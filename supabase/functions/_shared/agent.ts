import { db, safeLog } from "./supabase.ts";
import { computeNextTrigger, parseRRule, summarizeRRule } from "./rrule.ts";
import { reinterpretUtcAsLocal } from "./tz.ts";
import { embed } from "./deepseek.ts";
import { sendEmailWithReason } from "./email.ts";
import { geocode, getWeather } from "./weather.ts";
import { getGoodNews } from "./news.ts";
import { webSearch } from "./websearch.ts";
import type { NlpContext, OwnerRow } from "./types.ts";
import { formatInTimeZone } from "date-fns-tz";

const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ??
  Deno.env.get("DEEPSEEK_API_KEY");
if (!LLM_API_KEY) throw new Error("Missing LLM_API_KEY");

const LLM_BASE_URL =
  (Deno.env.get("LLM_BASE_URL") ?? "https://api.deepseek.com").replace(
    /\/+$/,
    "",
  );
const CHAT_MODEL = Deno.env.get("LLM_CHAT_MODEL") ?? "deepseek-chat";
const ENDPOINT = `${LLM_BASE_URL}/v1/chat/completions`;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_ITERATIONS = 6;
const MAX_TOOLS = 24;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "create_reminder",
      description:
        "Crea un recordatorio. Para uno único usa trigger_at. Para recurrente usa recurrence_rule (RRULE RFC 5545). Para múltiples eventos en un mensaje, llama esta función una vez por cada evento. NO inventes fechas: si el usuario no la dio, NO uses esta tool y pregunta primero.",
      parameters: {
        type: "object",
        required: ["title"],
        properties: {
          title: {
            type: "string",
            description: "Qué hay que hacer. Frase corta.",
          },
          trigger_at: {
            type: "string",
            description: "ISO 8601 con offset. Único o primero de la serie.",
          },
          recurrence_rule: {
            type: "string",
            description: "RRULE RFC 5545 si es recurrente.",
          },
          ends_at: { type: "string", description: "Fin del evento si aplica." },
          location: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          parent_id: {
            type: "string",
            description:
              "uuid del recordatorio padre si este es pre-aviso/derivado.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description:
        "Lista los recordatorios del usuario. Filtros opcionales por rango de fechas (inclusive), texto en el contenido, o estado.",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description:
              "ISO 8601. Filtra recordatorios con next_trigger_at >= from.",
          },
          to: {
            type: "string",
            description: "ISO 8601. Filtra con next_trigger_at <= to.",
          },
          contains: {
            type: "string",
            description: "Substring case-insensitive en el contenido.",
          },
          status: {
            type: "string",
            enum: [
              "scheduled",
              "active",
              "paused",
              "completed",
              "cancelled",
              "all",
            ],
            description: "Por defecto: 'open' (scheduled+active+paused).",
          },
          limit: { type: "integer", default: 20 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_reminders",
      description:
        "Borra (cancela) recordatorios por id, o todos los abiertos si pasas all=true. Para borrado selectivo, primero llama list_reminders y pasa los ids. Reversible vía status='cancelled'.",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "uuids específicos.",
          },
          all: {
            type: "boolean",
            description: "Si true, cancela TODOS los abiertos.",
          },
          contains: {
            type: "string",
            description:
              "Borra los abiertos cuyo contenido contenga este texto.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_reminder",
      description:
        "Modifica un recordatorio existente: cambiar fecha, contenido, pausar, reanudar.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          trigger_at: { type: "string" },
          recurrence_rule: { type: "string" },
          status: {
            type: "string",
            enum: ["scheduled", "active", "paused", "completed", "cancelled"],
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_pre_notifications",
      description:
        "Añade pre-avisos a un recordatorio existente. lead_times_days en días (ej. [21,3,1] = 3 avisos a 21d, 3d, 1d antes).",
      parameters: {
        type: "object",
        required: ["reminder_id", "lead_times_days"],
        properties: {
          reminder_id: { type: "string" },
          lead_times_days: {
            type: "array",
            items: { type: "integer", minimum: 0 },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_event",
      description: "Crea un evento de calendario (con inicio y fin opcional).",
      parameters: {
        type: "object",
        required: ["title", "starts_at"],
        properties: {
          title: { type: "string" },
          starts_at: { type: "string", description: "ISO 8601." },
          ends_at: { type: "string" },
          location: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_events",
      description: "Lista eventos en una ventana temporal.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          contains: { type: "string" },
          limit: { type: "integer", default: 20 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_events",
      description: "Borra eventos por id o todos los futuros si all=true.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          all_future: { type: "boolean" },
          contains: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description:
        "Guarda una nota o reflexión en The_Park (memoria de conocimiento).",
      parameters: {
        type: "object",
        required: ["content"],
        properties: {
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          source: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_notes",
      description: "Busca notas en The_Park por similitud semántica.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "integer", default: 10 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Crea una tarea (con due_at opcional, prioridad 1-5).",
      parameters: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          due_at: { type: "string" },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "Marca una tarea como completada por id.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "Lista tareas, opcionalmente filtradas.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "completed", "cancelled", "all"],
          },
          contains: { type: "string" },
          limit: { type: "integer", default: 20 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_about_user",
      description:
        "Guarda un dato personal del usuario que has aprendido (preferencia, rutina, contexto).",
      parameters: {
        type: "object",
        required: ["category", "key", "value"],
        properties: {
          category: {
            type: "string",
            enum: ["personal", "work", "health", "education", "preferences"],
          },
          key: { type: "string" },
          value: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description:
        "Envía un correo al email del usuario (configurado en OWNER_EMAIL). Útil cuando pide enviarse algo por correo: un resumen, un recordatorio crítico, un texto largo, un export. NO uses esta tool para pre-avisos automáticos de un recordatorio (eso ya pasa solo).",
      parameters: {
        type: "object",
        required: ["subject", "body"],
        properties: {
          subject: {
            type: "string",
            description: "Asunto del correo, claro y corto.",
          },
          body: {
            type: "string",
            description:
              "Cuerpo en texto plano. Saltos de línea con \\n. Si quieres formato, usa Markdown sencillo.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "current_time",
      description:
        "Obtén la hora ACTUAL del usuario en su zona, en este instante. Llama esta tool SIEMPRE que el usuario pregunte qué hora es, qué día es hoy, qué hora marca tu reloj interno, qué hora tienes tú, o necesites la hora exacta presente. La respuesta del tool YA ES la hora local del usuario; jamás la conviertas a UTC ni la presentes en otra zona. NO uses la hora del turno anterior.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_list_item",
      description: "Edita el texto de un elemento de lista existente.",
      parameters: {
        type: "object",
        required: ["id", "content"],
        properties: {
          id: { type: "string", description: "uuid del list_item" },
          content: { type: "string", description: "nuevo texto" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_list",
      description:
        "Creates a named list (shopping list, packing list, books to read, etc.). Reuse with add_to_list afterwards.",
      parameters: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_lists",
      description: "Returns all lists with their item counts.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_list",
      description: "Deletes a list and every item in it. Identify by id or by exact name.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_list",
      description:
        "Adds one or more items to a list. The list is identified by name (created automatically if it doesn't exist) or by list_id.",
      parameters: {
        type: "object",
        required: ["items"],
        properties: {
          list_name: { type: "string" },
          list_id: { type: "string" },
          items: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_items",
      description:
        "Returns the items of a given list. Identify it by list_id or by exact list_name.",
      parameters: {
        type: "object",
        properties: {
          list_id: { type: "string" },
          list_name: { type: "string" },
          status: { type: "string", enum: ["pending", "completed", "all"], default: "pending" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_list_item",
      description:
        "Marks one or more list items as completed (or back to pending if status='pending').",
      parameters: {
        type: "object",
        required: ["ids"],
        properties: {
          ids: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["completed", "pending"], default: "completed" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_list_items",
      description: "Deletes specific items by id from any list.",
      parameters: {
        type: "object",
        required: ["ids"],
        properties: {
          ids: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_friend",
      description: "Crea un contacto/amigo. Cualquier campo opcional puede ir.",
      parameters: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          birthday: {
            type: "string",
            description:
              "Fecha YYYY-MM-DD; usa solo cuando el usuario la dio. Si solo dio dia/mes, usa 0001-MM-DD.",
          },
          notes: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_friend",
      description:
        "Actualiza campos de un contacto existente. Pasa solo los que cambian.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          birthday: { type: "string" },
          notes: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_friend",
      description: "Borra un contacto por id, o por nombre si es inequívoco.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: {
            type: "string",
            description: "match case-insensitive exacto",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_friends",
      description:
        "Lista contactos. Filtros opcionales: nombre parcial, tag, próximos cumpleaños.",
      parameters: {
        type: "object",
        properties: {
          contains: {
            type: "string",
            description: "match parcial en nombre/email/phone/notes",
          },
          tag: { type: "string" },
          upcoming_birthdays_days: {
            type: "integer",
            description: "Solo contactos con cumple en los próximos N días.",
          },
          limit: { type: "integer", default: 30 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_address",
      description:
        "Guarda una direccion o ubicacion. Da label y al menos street+city o latitude+longitude.",
      parameters: {
        type: "object",
        required: ["label"],
        properties: {
          label: {
            type: "string",
            description:
              "Nombre identificable, ej. 'Casa', 'Oficina', 'Pizzeria favorita'.",
          },
          street: { type: "string" },
          city: { type: "string" },
          region: { type: "string" },
          country: { type: "string" },
          postal_code: { type: "string" },
          latitude: { type: "number" },
          longitude: { type: "number" },
          notes: { type: "string" },
          friend_id: {
            type: "string",
            description: "uuid del friend si la direccion es de alguien",
          },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_address",
      description:
        "Actualiza campos de una direccion. Pasa solo los que cambian.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          street: { type: "string" },
          city: { type: "string" },
          region: { type: "string" },
          country: { type: "string" },
          postal_code: { type: "string" },
          latitude: { type: "number" },
          longitude: { type: "number" },
          notes: { type: "string" },
          friend_id: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_address",
      description: "Borra una direccion por id o por label inequivoco.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_addresses",
      description:
        "Lista direcciones. Devuelve label, ciudad, coords y un enlace de Google Maps.",
      parameters: {
        type: "object",
        properties: {
          contains: {
            type: "string",
            description: "match parcial en label/street/city/notes",
          },
          friend_id: { type: "string" },
          limit: { type: "integer", default: 30 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Returns the current weather and short-term forecast for the user's saved location, or for a city if `query` is provided. Use this for greetings (good morning), outfit advice, planning outdoor activities.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "City name or 'lat,lon'. Optional; defaults to the user's saved location.",
          },
          units: {
            type: "string",
            enum: ["metric", "imperial"],
            default: "metric",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_news",
      description:
        "Fetches a few uplifting or neutral international headlines on the requested topic. Use when the user wants the news, the morning brief, or asks 'what is happening in the world'.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "Topic to query, e.g. 'world', 'tech', 'science', 'sports'. Defaults to 'world'.",
          },
          limit: { type: "integer", default: 5 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Searches the public web for up-to-date information that is not in the database (events, prices, definitions, recent facts). Returns a small list of titles, URLs and snippets.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "integer", default: 5 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_location",
      description:
        "Saves the user's home city/coordinates so weather and briefings are local. Accepts free-form city or explicit lat/lon.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          country: { type: "string" },
          latitude: { type: "number" },
          longitude: { type: "number" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_link",
      description:
        "Returns the private URL the user can open in a browser to see their reminders and events as a calendar.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memories",
      description:
        "Lists everything we've stored about the user via remember_about_user. Useful before answering 'what do you know about me'.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_about_user",
      description:
        "Removes one stored memory entry by key. Use only when the user explicitly says 'forget X'.",
      parameters: {
        type: "object",
        required: ["key"],
        properties: { key: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_journal_entry",
      description:
        "Saves a journal entry: a thought, reflection, idea, goal, or feeling the user wants to keep and revisit later. NOT for reminders or events. Embeds it for semantic search.",
      parameters: {
        type: "object",
        required: ["body"],
        properties: {
          body: { type: "string", description: "Free-form text." },
          mood: {
            type: "string",
            description: "Optional one-word mood, e.g. 'happy', 'anxious', 'focused'.",
          },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_journal",
      description:
        "Searches the user's journal by semantic similarity, optional tag filter, and optional date range. Returns up to 10 entries.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text query for semantic search." },
          tag: { type: "string" },
          from: { type: "string", description: "ISO date lower bound." },
          to: { type: "string", description: "ISO date upper bound." },
          limit: { type: "integer", default: 10 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_journal",
      description:
        "Lists the most recent journal entries in chronological order. Use for 'show me my last reflections' or weekly recaps.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", default: 10 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_habit",
      description:
        "Defines a new habit the user wants to track (e.g. 'workout', 'call mom', 'read 20 pages'). cadence_days is the expected interval (1=daily, 7=weekly).",
      parameters: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          cadence_days: { type: "integer", default: 1 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_habit",
      description:
        "Marks a habit as done now (or at a specific time). Updates streak. Identify the habit by id (preferred) or by exact title.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          done_at: { type: "string", description: "ISO 8601, defaults to now." },
          note: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_habits",
      description:
        "Lists tracked habits with their last_done_at, streak and overdue status. Use for 'how am I doing with my habits'.",
      parameters: {
        type: "object",
        properties: {
          active_only: { type: "boolean", default: true },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "connect_dots",
      description:
        "Returns days in the next N days where two or more agenda items collide (multiple reminders/events on the same calendar day). Use to surface scheduling conflicts proactively.",
      parameters: {
        type: "object",
        properties: {
          horizon_days: { type: "integer", default: 30 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_nudges",
      description:
        "Returns the queue of pending proactive insights ('what you might be missing'). Use when the user asks 'is there anything I should know' or at the start of a day.",
      parameters: {
        type: "object",
        properties: {
          include_delivered: { type: "boolean", default: false },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dismiss_nudge",
      description:
        "Marks a proactive nudge as dismissed so the bot does not surface it again.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  },
] as const;

interface ToolCtx {
  ownerTimezone: string;
  ownerLanguage?: string;
  calendarBaseUrl?: string;
}

type ToolArgs = Record<string, unknown>;

async function exec_create_reminder(
  args: ToolArgs,
  ctx: ToolCtx,
): Promise<unknown> {
  const title = String(args.title ?? "").trim();
  if (!title) return { error: "title is required" };
  let triggerAt = typeof args.trigger_at === "string"
    ? args.trigger_at
    : null;
  if (triggerAt) triggerAt = reinterpretUtcAsLocal(triggerAt, ctx.ownerTimezone);
  const rrule = typeof args.recurrence_rule === "string"
    ? args.recurrence_rule
    : null;
  if (!triggerAt && !rrule) {
    return { error: "must provide trigger_at or recurrence_rule" };
  }

  const now = new Date();
  let nextTrigger: Date;
  let kind: "static" | "recurring" = "static";
  let status: "scheduled" | "active" = "scheduled";

  if (rrule) {
    try {
      const rule = parseRRule(rrule, now, ctx.ownerTimezone);
      const after = rule.after(now, true);
      if (!after) return { error: "recurrence_rule has no future occurrence" };
      nextTrigger = after;
      kind = "recurring";
      status = "active";
    } catch (err) {
      return {
        error: `invalid recurrence_rule: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  } else {
    const parsed = new Date(triggerAt!);
    if (Number.isNaN(parsed.getTime())) {
      return { error: "trigger_at is not a valid ISO 8601 date" };
    }
    if (parsed.getTime() <= Date.now() - 60_000) {
      return { error: "trigger_at is in the past" };
    }
    nextTrigger = parsed.getTime() <= Date.now()
      ? new Date(Date.now() + 10_000)
      : parsed;
  }

  const insertPayload: Record<string, unknown> = {
    kind,
    status,
    content: title,
    next_trigger_at: nextTrigger.toISOString(),
    timezone: ctx.ownerTimezone,
  };
  if (rrule) insertPayload.recurrence_rule = rrule;
  if (typeof args.parent_id === "string") {
    insertPayload.parent_reminder_id = args.parent_id;
  }

  const { data, error } = await db.from("reminder").insert(insertPayload)
    .select("id, next_trigger_at, recurrence_rule").single();
  if (error || !data) return { error: error?.message ?? "insert failed" };

  const deltaMs = nextTrigger.getTime() - Date.now();
  const showSeconds = deltaMs < 120_000;
  const localHuman = new Intl.DateTimeFormat("es-ES", {
    timeZone: ctx.ownerTimezone,
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: showSeconds ? "2-digit" : undefined,
  }).format(nextTrigger);
  return {
    id: (data as { id: string }).id,
    next_trigger_at: (data as { next_trigger_at: string }).next_trigger_at,
    local_time_human: localHuman,
    kind,
    rrule_summary: rrule
      ? safeRRuleSummary(rrule, now, ctx.ownerTimezone)
      : null,
  };
}

function safeRRuleSummary(rrule: string, now: Date, tz: string): string | null {
  try {
    return summarizeRRule(rrule, now, tz).description;
  } catch {
    return null;
  }
}

async function exec_list_reminders(args: ToolArgs): Promise<unknown> {
  const status = typeof args.status === "string" ? args.status : "open";
  const limit = safeLimit(args.limit, 20, 50);
  let q = db.from("reminder").select(
    "id, content, status, next_trigger_at, recurrence_rule, kind",
  ).order("next_trigger_at", { ascending: true, nullsFirst: false }).limit(
    limit,
  );
  if (status === "open") q = q.in("status", ["scheduled", "active", "paused"]);
  else if (status !== "all") q = q.eq("status", status);
  if (typeof args.from === "string") q = q.gte("next_trigger_at", args.from);
  if (typeof args.to === "string") q = q.lte("next_trigger_at", args.to);
  if (typeof args.contains === "string" && args.contains.length > 0) {
    q = q.ilike("content", `%${args.contains}%`);
  }
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { items: data ?? [], count: (data ?? []).length };
}

async function exec_delete_reminders(args: ToolArgs): Promise<unknown> {
  const updates = {
    status: "cancelled",
    next_trigger_at: null,
    updated_at: new Date().toISOString(),
  };

  if (args.all === true) {
    const { data, error } = await db.from("reminder").update(updates).in(
      "status",
      ["scheduled", "active", "paused"],
    ).select("id");
    if (error) return { error: error.message };
    const ids = (data ?? []).map((r: { id: string }) => r.id);
    if (ids.length > 0) {
      await db.from("job_outbox").delete().in("status", [
        "pending",
        "in_flight",
      ]).in("reminder_id", ids);
    }
    return { cancelled: ids.length };
  }

  const ids = Array.isArray(args.ids)
    ? (args.ids as string[]).filter((s) => typeof s === "string")
    : [];
  if (ids.length > 0) {
    const { data, error } = await db.from("reminder").update(updates).in(
      "id",
      ids,
    ).select("id");
    if (error) return { error: error.message };
    const cancelledIds = (data ?? []).map((r: { id: string }) => r.id);
    await db.from("job_outbox").delete().in("status", ["pending", "in_flight"])
      .in("reminder_id", cancelledIds);
    return { cancelled: cancelledIds.length, ids: cancelledIds };
  }

  if (typeof args.contains === "string" && args.contains.length > 0) {
    const { data, error } = await db.from("reminder").update(updates).in(
      "status",
      ["scheduled", "active", "paused"],
    ).ilike("content", `%${args.contains}%`).select("id, content");
    if (error) return { error: error.message };
    const cancelled = (data ?? []) as Array<
      { id: string; content: string | null }
    >;
    if (cancelled.length > 0) {
      await db.from("job_outbox").delete().in("status", [
        "pending",
        "in_flight",
      ]).in("reminder_id", cancelled.map((r) => r.id));
    }
    return { cancelled: cancelled.length, items: cancelled };
  }

  return { error: "must provide ids, all=true, or contains" };
}

async function exec_update_reminder(args: ToolArgs): Promise<unknown> {
  const id = String(args.id ?? "");
  if (!id) return { error: "id required" };
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (typeof args.title === "string") update.content = args.title;
  if (typeof args.trigger_at === "string") {
    update.next_trigger_at = args.trigger_at;
  }
  if (typeof args.recurrence_rule === "string") {
    update.recurrence_rule = args.recurrence_rule;
  }
  if (typeof args.status === "string") update.status = args.status;
  const { data, error } = await db.from("reminder").update(update).eq("id", id)
    .select("id, content, next_trigger_at, status").maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "not found" };
  return data;
}

async function exec_add_pre_notifications(
  args: ToolArgs,
  ctx: ToolCtx,
): Promise<unknown> {
  const reminderId = String(args.reminder_id ?? "");
  const days = Array.isArray(args.lead_times_days)
    ? (args.lead_times_days as unknown[]).filter((n): n is number =>
      typeof n === "number" && n > 0
    ).map((n) => Math.floor(n))
    : [];
  if (!reminderId || days.length === 0) {
    return { error: "reminder_id and lead_times_days required" };
  }
  const { data: target } = await db.from("reminder").select(
    "id, next_trigger_at, content",
  ).eq("id", reminderId).maybeSingle();
  if (!target) return { error: "parent reminder not found" };
  const t = target as {
    id: string;
    next_trigger_at: string | null;
    content: string | null;
  };
  if (!t.next_trigger_at) return { error: "parent has no next_trigger_at" };
  const parentTrigger = new Date(t.next_trigger_at);
  const created: number[] = [];
  const skipped: Array<{ days: number; reason: string }> = [];
  for (const d of days) {
    const ts = new Date(parentTrigger.getTime() - d * 86_400_000);
    if (ts.getTime() <= Date.now()) {
      skipped.push({ days: d, reason: "already passed" });
      continue;
    }
    const { error } = await db.from("reminder").insert({
      kind: "static",
      status: "scheduled",
      content: `Faltan ${d} ${d === 1 ? "día" : "días"} para «${
        t.content ?? ""
      }»`,
      next_trigger_at: ts.toISOString(),
      parent_reminder_id: t.id,
      timezone: ctx.ownerTimezone,
    });
    if (error) skipped.push({ days: d, reason: "insert error" });
    else created.push(d);
  }
  return { created, skipped };
}

async function exec_create_event(args: ToolArgs, ctx: ToolCtx): Promise<unknown> {
  const title = String(args.title ?? "").trim();
  let startsAt = String(args.starts_at ?? "");
  if (!title || !startsAt) return { error: "title and starts_at required" };
  startsAt = reinterpretUtcAsLocal(startsAt, ctx.ownerTimezone);
  const startMs = Date.parse(startsAt);
  if (Number.isNaN(startMs)) return { error: "invalid starts_at" };
  const payload: Record<string, unknown> = { title, starts_at: startsAt };
  if (typeof args.ends_at === "string") {
    payload.ends_at = reinterpretUtcAsLocal(args.ends_at, ctx.ownerTimezone);
  }
  if (typeof args.location === "string") payload.location = args.location;
  if (typeof args.description === "string") {
    payload.description = args.description;
  }
  if (Array.isArray(args.tags)) payload.tags = args.tags;
  const { data, error } = await db.from("event").insert(payload).select(
    "id, title, starts_at, ends_at",
  ).single();
  if (error || !data) return { error: error?.message ?? "insert failed" };
  return data;
}

async function exec_list_events(args: ToolArgs): Promise<unknown> {
  const limit = safeLimit(args.limit, 20, 50);
  let q = db.from("event").select("id, title, starts_at, ends_at, location")
    .order("starts_at", { ascending: true }).limit(limit);
  if (typeof args.from === "string") q = q.gte("starts_at", args.from);
  if (typeof args.to === "string") q = q.lte("starts_at", args.to);
  if (typeof args.contains === "string" && args.contains.length > 0) {
    q = q.ilike("title", `%${args.contains}%`);
  }
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { items: data ?? [] };
}

async function exec_delete_events(args: ToolArgs): Promise<unknown> {
  if (args.all_future === true) {
    const { data, error } = await db.from("event").delete().gte(
      "starts_at",
      new Date().toISOString(),
    ).select("id");
    if (error) return { error: error.message };
    return { deleted: (data ?? []).length };
  }
  const ids = Array.isArray(args.ids)
    ? (args.ids as string[]).filter((s) => typeof s === "string")
    : [];
  if (ids.length > 0) {
    const { data, error } = await db.from("event").delete().in("id", ids)
      .select("id");
    if (error) return { error: error.message };
    return { deleted: (data ?? []).length };
  }
  if (typeof args.contains === "string" && args.contains.length > 0) {
    const { data, error } = await db.from("event").delete().ilike(
      "title",
      `%${args.contains}%`,
    ).select("id");
    if (error) return { error: error.message };
    return { deleted: (data ?? []).length };
  }
  return { error: "must provide ids, all_future=true, or contains" };
}

async function exec_create_note(args: ToolArgs): Promise<unknown> {
  const content = String(args.content ?? "").trim();
  if (!content) return { error: "content required" };
  const tags = Array.isArray(args.tags)
    ? (args.tags as string[]).map((t) => t.toLowerCase().trim()).filter((t) =>
      t.length > 0
    )
    : [];
  let embedding: number[] | null = null;
  try {
    embedding = await embed(content);
  } catch {}
  const payload: Record<string, unknown> = { content, tags };
  if (typeof args.source === "string") payload.source = args.source;
  if (embedding) payload.embedding = embedding;
  const { data, error } = await db.from("memory_bubble").insert(payload).select(
    "id",
  ).single();
  if (error || !data) return { error: error?.message ?? "insert failed" };
  return { id: (data as { id: string }).id, has_embedding: embedding !== null };
}

async function exec_search_notes(args: ToolArgs): Promise<unknown> {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query required" };
  const limit = safeLimit(args.limit, 10, 20);
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embed(query);
  } catch {}
  if (queryEmbedding) {
    const { data, error } = await db.rpc("search_park", {
      query_embedding: queryEmbedding,
      tag_filter: null,
      k: limit,
    });
    if (!error) return { items: data ?? [] };
  }

  const { data, error } = await db.from("memory_bubble").select(
    "id, content, tags, created_at",
  ).is("deleted_at", null).ilike("content", `%${query}%`).limit(limit);
  if (error) return { error: error.message };
  return { items: data ?? [] };
}

async function exec_create_task(args: ToolArgs): Promise<unknown> {
  const title = String(args.title ?? "").trim();
  if (!title) return { error: "title required" };
  const payload: Record<string, unknown> = { title };
  if (typeof args.description === "string") {
    payload.description = args.description;
  }
  if (typeof args.due_at === "string") payload.due_at = args.due_at;
  if (typeof args.priority === "number") payload.priority = args.priority;
  if (Array.isArray(args.tags)) payload.tags = args.tags;
  const { data, error } = await db.from("task").insert(payload).select(
    "id, title, due_at",
  ).single();
  if (error || !data) return { error: error?.message ?? "insert failed" };
  return data;
}

async function exec_complete_task(args: ToolArgs): Promise<unknown> {
  const id = String(args.id ?? "");
  if (!id) return { error: "id required" };
  const { data, error } = await db.from("task").update({
    status: "completed",
    completed_at: new Date().toISOString(),
  }).eq("id", id).select("id, title").maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "not found" };
  return data;
}

async function exec_list_tasks(args: ToolArgs): Promise<unknown> {
  const status = typeof args.status === "string" ? args.status : "pending";
  const limit = safeLimit(args.limit, 20, 50);
  let q = db.from("task").select("id, title, status, due_at, priority").order(
    "due_at",
    { ascending: true, nullsFirst: false },
  ).limit(limit);
  if (status !== "all") q = q.eq("status", status);
  if (typeof args.contains === "string" && args.contains.length > 0) {
    q = q.ilike("title", `%${args.contains}%`);
  }
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { items: data ?? [] };
}

async function exec_remember_about_user(args: ToolArgs): Promise<unknown> {
  const category = String(args.category ?? "");
  const key = String(args.key ?? "");
  const value = String(args.value ?? "");
  if (!category || !key || !value) {
    return { error: "category, key, value required" };
  }
  const { error } = await db.from("owner_context").upsert({
    category,
    key,
    value,
    source: `agent ${new Date().toISOString().split("T")[0]}`,
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });
  if (error) return { error: error.message };
  return { saved: true };
}

async function exec_send_email(args: ToolArgs): Promise<unknown> {
  const subject = String(args.subject ?? "").trim();
  const body = String(args.body ?? "").trim();
  if (!subject || !body) return { error: "subject and body required" };
  const result = await sendEmailWithReason(subject, body);
  if (result.ok) return { sent: true };
  if (result.reason === "not_configured") {
    return {
      error:
        "email backup not configured (RESEND_API_KEY or OWNER_EMAIL missing)",
    };
  }
  if (result.reason === "remote_error") {
    return {
      error: `email provider rejected the request (HTTP ${result.detail})`,
    };
  }
  return { error: `email failed: ${result.detail ?? "unknown"}` };
}

async function exec_current_time(
  _args: ToolArgs,
  ctx: ToolCtx,
): Promise<unknown> {
  const tz = ctx.ownerTimezone;
  const now = new Date();
  const time = new Intl.DateTimeFormat("es-ES", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const date = new Intl.DateTimeFormat("es-ES", {
    timeZone: tz,
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(now);

  const iso = formatInTimeZone(now, tz, "yyyy-MM-dd'T'HH:mm:ssxxx");
  return { time_hhmm: time, date_long: date, iso_local: iso };
}

function postgrestEscape(value: string): string {
  return value.replace(/[,()*%]/g, " ").replace(/\s+/g, " ").trim();
}

function ilikeEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function safeLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

async function exec_edit_list_item(args: ToolArgs): Promise<unknown> {
  const id = String(args.id ?? "");
  const content = String(args.content ?? "").trim();
  if (!id || !content) return { error: "id and content required" };
  const { data, error } = await db.from("list_item")
    .update({ content })
    .eq("id", id)
    .select("id, content")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "list_item not found" };
  return data;
}

async function exec_create_list(args: ToolArgs): Promise<unknown> {
  const name = String(args.name ?? "").trim();
  if (!name) return { error: "name required" };
  const { data, error } = await db.from("list")
    .insert({ name })
    .select("id, name")
    .single();
  if (error) return { error: error.message };
  return { created: data };
}

async function exec_list_lists(_args: ToolArgs): Promise<unknown> {
  const { data: lists, error } = await db.from("list")
    .select("id, name, created_at")
    .order("name", { ascending: true });
  if (error) return { error: error.message };
  if (!lists || lists.length === 0) return { items: [] };
  const ids = (lists as Array<{ id: string }>).map((l) => l.id);
  const { data: counts } = await db.from("list_item")
    .select("list_id, status")
    .in("list_id", ids);
  const tally: Record<string, { open: number; total: number }> = {};
  for (const r of (counts ?? []) as Array<{ list_id: string; status: string }>) {
    if (!tally[r.list_id]) tally[r.list_id] = { open: 0, total: 0 };
    tally[r.list_id].total += 1;
    if (r.status === "pending") tally[r.list_id].open += 1;
  }
  return {
    items: (lists as Array<Record<string, unknown>>).map((l) => ({
      ...l,
      open_items: tally[String(l.id)]?.open ?? 0,
      total_items: tally[String(l.id)]?.total ?? 0,
    })),
  };
}

async function resolveListId(args: ToolArgs): Promise<string | { error: string }> {
  const id = typeof args.list_id === "string" && args.list_id.length > 0
    ? args.list_id
    : null;
  if (id) return id;
  const name = typeof args.list_name === "string" ? args.list_name.trim() : "";
  if (!name) return { error: "list_id or list_name required" };
  const { data } = await db.from("list")
    .select("id")
    .ilike("name", name)
    .limit(1)
    .maybeSingle();
  if (data) return (data as { id: string }).id;
  const { data: created, error } = await db.from("list")
    .insert({ name })
    .select("id")
    .single();
  if (error || !created) return { error: error?.message ?? "could not create list" };
  return (created as { id: string }).id;
}

async function exec_delete_list(args: ToolArgs): Promise<unknown> {
  const id = typeof args.id === "string" && args.id.length > 0 ? args.id : null;
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!id && !name) return { error: "id or name required" };
  let q = db.from("list").delete();
  q = id ? q.eq("id", id) : q.ilike("name", ilikeEscape(name));
  const { data, error } = await q.select("id, name");
  if (error) return { error: error.message };
  const rows = (data ?? []) as Array<{ id: string; name: string }>;
  if (rows.length === 0) return { error: "no list matched" };
  if (rows.length > 1) return { error: `ambiguous: ${rows.length} matches`, items: rows };
  return { deleted: rows[0] };
}

async function exec_add_to_list(args: ToolArgs): Promise<unknown> {
  const items = Array.isArray(args.items)
    ? (args.items as unknown[])
      .filter((i) => typeof i === "string")
      .map((i) => (i as string).trim())
      .filter((i) => i.length > 0)
    : [];
  if (items.length === 0) return { error: "items required" };
  const resolved = await resolveListId(args);
  if (typeof resolved !== "string") return resolved;

  const { data: existing } = await db.from("list_item")
    .select("position")
    .eq("list_id", resolved)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const startPos =
    ((existing as { position?: number } | null)?.position ?? -1) + 1;

  const rows = items.map((content, i) => ({
    list_id: resolved,
    content,
    status: "pending",
    position: startPos + i,
  }));
  const { data, error } = await db.from("list_item")
    .insert(rows)
    .select("id, content, position");
  if (error) return { error: error.message };
  return { list_id: resolved, added: data ?? [] };
}

async function exec_list_items(args: ToolArgs): Promise<unknown> {
  const status = typeof args.status === "string" ? args.status : "pending";
  const id = typeof args.list_id === "string" && args.list_id.length > 0
    ? args.list_id
    : null;
  const name = typeof args.list_name === "string" ? args.list_name.trim() : "";
  let listId = id;
  if (!listId && name) {
    const { data } = await db.from("list")
      .select("id")
      .ilike("name", name)
      .limit(1)
      .maybeSingle();
    listId = (data as { id: string } | null)?.id ?? null;
  }
  if (!listId) return { error: "list_id or list_name required" };
  let q = db.from("list_item")
    .select("id, content, status, created_at")
    .eq("list_id", listId)
    .order("created_at", { ascending: true });
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { list_id: listId, items: data ?? [] };
}

async function exec_complete_list_item(args: ToolArgs): Promise<unknown> {
  const ids = Array.isArray(args.ids)
    ? (args.ids as unknown[]).filter((i) => typeof i === "string") as string[]
    : [];
  if (ids.length === 0) return { error: "ids required" };
  const status = args.status === "pending" ? "pending" : "completed";
  const { data, error } = await db.from("list_item")
    .update({ status })
    .in("id", ids)
    .select("id, status");
  if (error) return { error: error.message };
  return { updated: data ?? [] };
}

async function exec_delete_list_items(args: ToolArgs): Promise<unknown> {
  const ids = Array.isArray(args.ids)
    ? (args.ids as unknown[]).filter((i) => typeof i === "string") as string[]
    : [];
  if (ids.length === 0) return { error: "ids required" };
  const { data, error } = await db.from("list_item")
    .delete()
    .in("id", ids)
    .select("id");
  if (error) return { error: error.message };
  return { deleted: data ?? [] };
}

async function exec_create_friend(args: ToolArgs): Promise<unknown> {
  const name = String(args.name ?? "").trim();
  if (!name) return { error: "name required" };
  const payload: Record<string, unknown> = { name };
  if (typeof args.email === "string" && args.email.trim()) {
    payload.email = args.email.trim();
  }
  if (typeof args.phone === "string" && args.phone.trim()) {
    payload.phone = args.phone.trim();
  }
  if (
    typeof args.birthday === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(args.birthday)
  ) payload.birthday = args.birthday;
  if (typeof args.notes === "string") payload.notes = args.notes;
  if (Array.isArray(args.tags)) {
    payload.tags = (args.tags as unknown[]).filter((t) =>
      typeof t === "string"
    );
  }
  const { data, error } = await db.from("friend").insert(payload).select(
    "id, name, email, phone, birthday",
  ).single();
  if (error || !data) return { error: error?.message ?? "insert failed" };
  return data;
}

async function exec_update_friend(args: ToolArgs): Promise<unknown> {
  const id = String(args.id ?? "");
  if (!id) return { error: "id required" };
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  for (const k of ["name", "email", "phone", "notes"] as const) {
    if (typeof args[k] === "string") update[k] = args[k];
  }
  if (
    typeof args.birthday === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(args.birthday)
  ) update.birthday = args.birthday;
  if (Array.isArray(args.tags)) {
    update.tags = (args.tags as unknown[]).filter((t) => typeof t === "string");
  }
  const { data, error } = await db.from("friend").update(update).eq("id", id)
    .select("id, name").maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "friend not found" };
  return data;
}

async function exec_delete_friend(args: ToolArgs): Promise<unknown> {
  const id = typeof args.id === "string" && args.id.length > 0 ? args.id : null;
  const name = typeof args.name === "string" && args.name.trim().length > 0
    ? args.name.trim()
    : null;
  if (!id && !name) return { error: "id or name required" };
  let q = db.from("friend").delete();
  if (id) q = q.eq("id", id);
  else q = q.ilike("name", ilikeEscape(name!));
  const { data, error } = await q.select("id, name");
  if (error) return { error: error.message };
  const rows = (data ?? []) as Array<{ id: string; name: string }>;
  if (rows.length === 0) return { error: "no friend matched" };
  if (rows.length > 1) {
    return { error: `ambiguous: ${rows.length} matches`, items: rows };
  }
  return { deleted: rows[0] };
}

async function exec_list_friends(args: ToolArgs): Promise<unknown> {
  const limit = safeLimit(args.limit, 30, 50);
  if (
    typeof args.upcoming_birthdays_days === "number" &&
    args.upcoming_birthdays_days > 0
  ) {
    const days = Math.min(366, args.upcoming_birthdays_days as number);
    const { data, error } = await db.from("friend")
      .select("id, name, birthday")
      .not("birthday", "is", null)
      .order("name", { ascending: true });
    if (error) return { error: error.message };
    const today = new Date();
    const todayMs = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
    );
    const horizon = todayMs + days * 86_400_000;
    const items = (data ?? []) as Array<
      { id: string; name: string; birthday: string }
    >;
    const upcoming = items.map((f) => {
      const [, mm, dd] = f.birthday.split("-").map(Number);
      let candidate = Date.UTC(today.getUTCFullYear(), mm - 1, dd);
      if (candidate < todayMs) {
        candidate = Date.UTC(today.getUTCFullYear() + 1, mm - 1, dd);
      }
      return { ...f, next_birthday: candidate };
    }).filter((f) => f.next_birthday <= horizon)
      .sort((a, b) => a.next_birthday - b.next_birthday)
      .slice(0, limit)
      .map((f) => ({
        id: f.id,
        name: f.name,
        birthday: f.birthday,
        next_birthday_iso: new Date(f.next_birthday).toISOString().slice(0, 10),
      }));
    return { items: upcoming };
  }
  let q = db.from("friend").select("id, name, email, phone, birthday, tags")
    .order("name", { ascending: true }).limit(limit);
  if (typeof args.contains === "string" && args.contains.length > 0) {
    const c = postgrestEscape(args.contains);
    if (c.length > 0) {
      q = q.or(
        `name.ilike.%${c}%,email.ilike.%${c}%,phone.ilike.%${c}%,notes.ilike.%${c}%`,
      );
    }
  }
  if (typeof args.tag === "string" && args.tag.length > 0) {
    q = q.contains("tags", [args.tag]);
  }
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { items: data ?? [] };
}

function mapsLink(
  lat: number | null | undefined,
  lon: number | null | undefined,
  label: string,
  street?: string | null,
  city?: string | null,
): string | null {
  if (typeof lat === "number" && typeof lon === "number") {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  }
  const q = [label, street, city].filter(Boolean).join(", ");
  if (!q) return null;
  return `https://www.google.com/maps/search/?api=1&query=${
    encodeURIComponent(q)
  }`;
}

async function exec_create_address(args: ToolArgs): Promise<unknown> {
  const label = String(args.label ?? "").trim();
  if (!label) return { error: "label required" };
  const payload: Record<string, unknown> = { label };
  for (
    const k of [
      "street",
      "city",
      "region",
      "country",
      "postal_code",
      "notes",
    ] as const
  ) {
    if (typeof args[k] === "string") payload[k] = args[k];
  }
  if (typeof args.latitude === "number") payload.latitude = args.latitude;
  if (typeof args.longitude === "number") payload.longitude = args.longitude;
  if (typeof args.friend_id === "string") payload.friend_id = args.friend_id;
  if (Array.isArray(args.tags)) {
    payload.tags = (args.tags as unknown[]).filter((t) =>
      typeof t === "string"
    );
  }
  const { data, error } = await db.from("address").insert(payload).select(
    "id, label, latitude, longitude, street, city",
  ).single();
  if (error || !data) return { error: error?.message ?? "insert failed" };
  const row = data as {
    id: string;
    label: string;
    latitude: number | null;
    longitude: number | null;
    street: string | null;
    city: string | null;
  };
  return {
    ...row,
    maps_url: mapsLink(
      row.latitude,
      row.longitude,
      row.label,
      row.street,
      row.city,
    ),
  };
}

async function exec_update_address(args: ToolArgs): Promise<unknown> {
  const id = String(args.id ?? "");
  if (!id) return { error: "id required" };
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  for (
    const k of [
      "label",
      "street",
      "city",
      "region",
      "country",
      "postal_code",
      "notes",
      "friend_id",
    ] as const
  ) {
    if (typeof args[k] === "string") update[k] = args[k];
  }
  if (typeof args.latitude === "number") update.latitude = args.latitude;
  if (typeof args.longitude === "number") update.longitude = args.longitude;
  if (Array.isArray(args.tags)) {
    update.tags = (args.tags as unknown[]).filter((t) => typeof t === "string");
  }
  const { data, error } = await db.from("address").update(update).eq("id", id)
    .select("id, label").maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "address not found" };
  return data;
}

async function exec_delete_address(args: ToolArgs): Promise<unknown> {
  const id = typeof args.id === "string" && args.id.length > 0 ? args.id : null;
  const label = typeof args.label === "string" && args.label.trim().length > 0
    ? args.label.trim()
    : null;
  if (!id && !label) return { error: "id or label required" };
  let q = db.from("address").delete();
  if (id) q = q.eq("id", id);
  else q = q.ilike("label", ilikeEscape(label!));
  const { data, error } = await q.select("id, label");
  if (error) return { error: error.message };
  const rows = (data ?? []) as Array<{ id: string; label: string }>;
  if (rows.length === 0) return { error: "no address matched" };
  if (rows.length > 1) {
    return { error: `ambiguous: ${rows.length} matches`, items: rows };
  }
  return { deleted: rows[0] };
}

async function exec_list_addresses(args: ToolArgs): Promise<unknown> {
  const limit = safeLimit(args.limit, 30, 50);
  let q = db.from("address").select(
    "id, label, street, city, country, latitude, longitude, friend_id, tags",
  ).order("label", { ascending: true }).limit(limit);
  if (typeof args.contains === "string" && args.contains.length > 0) {
    const c = postgrestEscape(args.contains);
    if (c.length > 0) {
      q = q.or(
        `label.ilike.%${c}%,street.ilike.%${c}%,city.ilike.%${c}%,notes.ilike.%${c}%`,
      );
    }
  }
  if (typeof args.friend_id === "string" && args.friend_id.length > 0) {
    q = q.eq("friend_id", args.friend_id);
  }
  const { data, error } = await q;
  if (error) return { error: error.message };
  const items = (data ?? []) as Array<
    {
      id: string;
      label: string;
      street: string | null;
      city: string | null;
      country: string | null;
      latitude: number | null;
      longitude: number | null;
      friend_id: string | null;
      tags: string[];
    }
  >;
  return {
    items: items.map((a) => ({
      ...a,
      maps_url: mapsLink(a.latitude, a.longitude, a.label, a.street, a.city),
    })),
  };
}

const TOOL_IMPL: Record<
  string,
  (args: ToolArgs, ctx: ToolCtx) => Promise<unknown>
> = {
  create_reminder: exec_create_reminder,
  list_reminders: (a) => exec_list_reminders(a),
  delete_reminders: (a) => exec_delete_reminders(a),
  update_reminder: (a) => exec_update_reminder(a),
  add_pre_notifications: exec_add_pre_notifications,
  create_event: (a, c) => exec_create_event(a, c),
  list_events: (a) => exec_list_events(a),
  delete_events: (a) => exec_delete_events(a),
  create_note: (a) => exec_create_note(a),
  search_notes: (a) => exec_search_notes(a),
  create_task: (a) => exec_create_task(a),
  complete_task: (a) => exec_complete_task(a),
  list_tasks: (a) => exec_list_tasks(a),
  remember_about_user: (a) => exec_remember_about_user(a),
  send_email: (a) => exec_send_email(a),
  current_time: exec_current_time,
  edit_list_item: (a) => exec_edit_list_item(a),
  create_list: (a) => exec_create_list(a),
  list_lists: (a) => exec_list_lists(a),
  delete_list: (a) => exec_delete_list(a),
  add_to_list: (a) => exec_add_to_list(a),
  list_items: (a) => exec_list_items(a),
  complete_list_item: (a) => exec_complete_list_item(a),
  delete_list_items: (a) => exec_delete_list_items(a),
  create_friend: (a) => exec_create_friend(a),
  update_friend: (a) => exec_update_friend(a),
  delete_friend: (a) => exec_delete_friend(a),
  list_friends: (a) => exec_list_friends(a),
  create_address: (a) => exec_create_address(a),
  update_address: (a) => exec_update_address(a),
  delete_address: (a) => exec_delete_address(a),
  list_addresses: (a) => exec_list_addresses(a),
  get_weather: (a, c) => exec_get_weather(a, c),
  get_news: (a, c) => exec_get_news(a, c),
  web_search: (a) => exec_web_search(a),
  set_location: (a) => exec_set_location(a),
  calendar_link: (_a, c) => exec_calendar_link(c),
  list_memories: (a) => exec_list_memories(a),
  forget_about_user: (a) => exec_forget_about_user(a),
  add_journal_entry: (a) => exec_add_journal_entry(a),
  search_journal: (a) => exec_search_journal(a),
  list_journal: (a) => exec_list_journal(a),
  create_habit: (a) => exec_create_habit(a),
  log_habit: (a) => exec_log_habit(a),
  list_habits: (a) => exec_list_habits(a),
  connect_dots: (a) => exec_connect_dots(a),
  list_nudges: (a) => exec_list_nudges(a),
  dismiss_nudge: (a) => exec_dismiss_nudge(a),
};

async function exec_get_weather(
  args: ToolArgs,
  ctx: ToolCtx,
): Promise<unknown> {
  const units = (args.units === "imperial" ? "imperial" : "metric") as
    | "metric"
    | "imperial";
  const lang = ctx.ownerLanguage ?? "en";
  let lat: number | null = null;
  let lon: number | null = null;

  if (typeof args.query === "string" && args.query.trim().length > 0) {
    const q = args.query.trim();
    const m = q.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
    if (m) {
      lat = Number(m[1]);
      lon = Number(m[2]);
    } else {
      const g = await geocode(q);
      if (!g) return { error: `could not geocode '${q}'` };
      lat = g.lat;
      lon = g.lon;
    }
  } else {
    const { data } = await db.from("owner")
      .select("latitude, longitude")
      .eq("id", 1)
      .maybeSingle();
    const row = data as
      | { latitude: number | null; longitude: number | null }
      | null;
    if (!row?.latitude || !row?.longitude) {
      return {
        error:
          "no saved location. Ask the user where they are and call set_location.",
      };
    }
    lat = row.latitude;
    lon = row.longitude;
  }

  return await getWeather(lat!, lon!, units, lang);
}

async function exec_get_news(
  args: ToolArgs,
  ctx: ToolCtx,
): Promise<unknown> {
  const topic = typeof args.topic === "string" && args.topic.length > 0
    ? args.topic
    : "world";
  const limit = safeLimit(args.limit, 5, 10);
  return await getGoodNews(topic, ctx.ownerLanguage ?? "en", limit);
}

async function exec_web_search(args: ToolArgs): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { error: "query required" };
  const limit = safeLimit(args.limit, 5, 10);
  return await webSearch(query, limit);
}

async function exec_set_location(args: ToolArgs): Promise<unknown> {
  let lat = typeof args.latitude === "number" ? args.latitude : null;
  let lon = typeof args.longitude === "number" ? args.longitude : null;
  let city = typeof args.city === "string" ? args.city.trim() : "";
  let country = typeof args.country === "string" ? args.country.trim() : "";

  if ((lat === null || lon === null) && city) {
    const q = country ? `${city}, ${country}` : city;
    const g = await geocode(q);
    if (g) {
      lat = g.lat;
      lon = g.lon;
      if (!city) city = g.name;
      if (!country) country = g.country;
    }
  }
  if (lat === null || lon === null) {
    return { error: "could not resolve a location from the inputs" };
  }
  const updates: Record<string, unknown> = {
    latitude: lat,
    longitude: lon,
  };
  if (city) updates.city = city;
  if (country) updates.country = country;
  const { error } = await db.from("owner").update(updates).eq("id", 1);
  if (error) return { error: error.message };
  return { saved: true, latitude: lat, longitude: lon, city, country };
}

async function exec_calendar_link(ctx: ToolCtx): Promise<unknown> {
  const { data: access } = await db.from("calendar_access")
    .select("token")
    .eq("id", 1)
    .maybeSingle();
  const token = (access as { token: string } | null)?.token ?? "";
  if (!token) {
    return {
      error:
        "calendar token not configured. Ask the user to insert a token in calendar_access (id=1).",
    };
  }
  const base = ctx.calendarBaseUrl;
  if (!base) {
    return {
      error:
        "CALENDAR_BASE_URL is not set. Add it as an environment variable, e.g. https://<project-ref>.supabase.co/functions/v1/calendar.",
    };
  }
  return { url: `${base}?t=${token}` };
}

async function exec_list_memories(args: ToolArgs): Promise<unknown> {
  let q = db.from("owner_context")
    .select("category, key, value, updated_at")
    .order("category", { ascending: true })
    .order("key", { ascending: true });
  if (typeof args.category === "string" && args.category.length > 0) {
    q = q.eq("category", args.category);
  }
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { items: data ?? [] };
}

async function exec_forget_about_user(args: ToolArgs): Promise<unknown> {
  const key = typeof args.key === "string" ? args.key.trim() : "";
  if (!key) return { error: "key required" };
  const { data, error } = await db.from("owner_context")
    .delete()
    .eq("key", key)
    .select("key");
  if (error) return { error: error.message };
  if (!data || data.length === 0) return { error: "no memory with that key" };
  return { forgotten: key };
}

async function exec_add_journal_entry(args: ToolArgs): Promise<unknown> {
  const body = String(args.body ?? "").trim();
  if (!body) return { error: "body required" };
  const mood = typeof args.mood === "string" ? args.mood : null;
  const tags = Array.isArray(args.tags)
    ? (args.tags as unknown[]).filter((t) => typeof t === "string")
    : [];
  let embedding: number[] | null = null;
  try {
    embedding = await embed(body);
  } catch {
    embedding = null;
  }
  const { data, error } = await db.from("journal_entry")
    .insert({ body, mood, tags, embedding })
    .select("id, created_at")
    .single();
  if (error) return { error: error.message };
  return { saved: true, ...(data as Record<string, unknown>) };
}

async function exec_search_journal(args: ToolArgs): Promise<unknown> {
  const limit = safeLimit(args.limit, 10, 20);
  const tag = typeof args.tag === "string" ? args.tag : null;
  const fromIso = typeof args.from === "string" ? args.from : null;
  const toIso = typeof args.to === "string" ? args.to : null;
  const query = typeof args.query === "string" ? args.query.trim() : "";

  if (query.length > 0) {
    let queryEmbedding: number[] | null = null;
    try {
      queryEmbedding = await embed(query);
    } catch {
      queryEmbedding = null;
    }
    if (queryEmbedding) {
      const { data, error } = await db.rpc("match_journal", {
        query_embedding: queryEmbedding,
        match_count: limit,
      }).select();
      if (!error && data) {
        return { items: data };
      }
    }
  }

  let q = db.from("journal_entry")
    .select("id, body, mood, tags, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (tag) q = q.contains("tags", [tag]);
  if (fromIso) q = q.gte("created_at", fromIso);
  if (toIso) q = q.lte("created_at", toIso);
  if (query.length > 0) q = q.ilike("body", `%${query}%`);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { items: data ?? [] };
}

async function exec_list_journal(args: ToolArgs): Promise<unknown> {
  const limit = safeLimit(args.limit, 10, 30);
  const { data, error } = await db.from("journal_entry")
    .select("id, body, mood, tags, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { error: error.message };
  return { items: data ?? [] };
}

async function exec_create_habit(args: ToolArgs): Promise<unknown> {
  const title = String(args.title ?? "").trim();
  if (!title) return { error: "title required" };
  const cadence = Number(args.cadence_days ?? 1);
  const { data, error } = await db.from("habit")
    .insert({
      title,
      cadence_days: Number.isFinite(cadence) && cadence > 0 ? cadence : 1,
    })
    .select("id, title, cadence_days")
    .single();
  if (error) return { error: error.message };
  return { created: data };
}

async function exec_log_habit(args: ToolArgs): Promise<unknown> {
  const id = typeof args.id === "string" ? args.id : null;
  const title = typeof args.title === "string" ? args.title.trim() : null;
  if (!id && !title) return { error: "id or title required" };

  let habitId = id;
  if (!habitId && title) {
    const { data } = await db.from("habit")
      .select("id")
      .ilike("title", title)
      .limit(1)
      .maybeSingle();
    const row = data as { id: string } | null;
    if (!row) return { error: "no habit matched that title" };
    habitId = row.id;
  }

  const doneAtIso = typeof args.done_at === "string"
    ? args.done_at
    : new Date().toISOString();
  const note = typeof args.note === "string" ? args.note : null;

  const { data, error } = await db.rpc("log_habit_atomic", {
    p_habit_id: habitId,
    p_done_at: doneAtIso,
    p_note: note,
  });
  if (error) return { error: error.message };
  const result = (Array.isArray(data) ? data[0] : data) as
    | { habit_id: string; streak: number }
    | null;
  return {
    logged: true,
    habit_id: result?.habit_id ?? habitId,
    streak: result?.streak ?? 1,
  };
}

async function exec_list_habits(args: ToolArgs): Promise<unknown> {
  const activeOnly = args.active_only !== false;
  let q = db.from("habit")
    .select("id, title, cadence_days, last_done_at, streak_count, active")
    .order("title", { ascending: true });
  if (activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) return { error: error.message };
  const now = Date.now();
  const items = (data ?? []) as Array<{
    id: string;
    title: string;
    cadence_days: number;
    last_done_at: string | null;
    streak_count: number;
    active: boolean;
  }>;
  return {
    items: items.map((h) => {
      const overdueDays = h.last_done_at
        ? Math.max(
          0,
          Math.floor(
            (now - new Date(h.last_done_at).getTime()) / 86_400_000,
          ) - h.cadence_days,
        )
        : null;
      return { ...h, overdue_days: overdueDays };
    }),
  };
}

async function exec_connect_dots(args: ToolArgs): Promise<unknown> {
  const horizon = Math.min(180, Math.max(1, Number(args.horizon_days ?? 30)));
  const { data, error } = await db.from("upcoming_collisions")
    .select("day, items");
  if (error) return { error: error.message };
  const today = new Date();
  const horizonMs = today.getTime() + horizon * 86_400_000;
  const collisions = (data ?? []) as Array<
    { day: string; items: Array<{ id: string; title: string; at: string; source: string }> }
  >;
  const filtered = collisions.filter((c) => {
    const d = new Date(c.day).getTime();
    return d >= today.getTime() - 86_400_000 && d <= horizonMs;
  });
  return { collisions: filtered };
}

async function exec_list_nudges(args: ToolArgs): Promise<unknown> {
  const includeDelivered = args.include_delivered === true;
  let q = db.from("proactive_nudge")
    .select("id, kind, payload, reason, ready_at, delivered_at")
    .is("dismissed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("ready_at", { ascending: true })
    .limit(20);
  if (!includeDelivered) q = q.is("delivered_at", null);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { items: data ?? [] };
}

async function exec_dismiss_nudge(args: ToolArgs): Promise<unknown> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return { error: "id required" };
  const { error } = await db.from("proactive_nudge")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { error: error.message };
  return { dismissed: id };
}

function buildSystemPrompt(ctx: NlpContext, owner: OwnerRow): string {
  const filteredCtx = (ctx.owner_context ?? []).filter((c) => {
    const k = (c.key ?? "").toLowerCase();
    const v = (c.value ?? "").toLowerCase();
    return !k.includes("timezone") && !k.includes("zona") &&
      !v.includes("/");
  });
  const ownerCtx = filteredCtx.length > 0
    ? filteredCtx.map((c) => `${c.key}=${c.value}`).join(" | ")
    : "no stored memory yet";
  const lists = ctx.list_names.length > 0 ? ctx.list_names.join(", ") : "none";
  const pending = ctx.pending_short_items.slice(0, 8)
    .map((i) =>
      `${i.short_id}: ${i.title}${
        i.next_trigger_at ?? i.due_at
          ? ` @ ${i.next_trigger_at ?? i.due_at}`
          : ""
      }`
    )
    .join(" | ") || "none";

  const language = (owner as { language?: string }).language ?? "en";
  const replyLang = language === "es" ? "Spanish" : "English";

  const localNow = new Intl.DateTimeFormat(
    language === "es" ? "es-ES" : "en-US",
    {
      timeZone: ctx.timezone,
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
  ).format(new Date());

  const ownerName = owner.display_name && owner.display_name.trim().length > 0
    ? owner.display_name
    : "the user";

  return [
    `You are OpenMemo, a personal assistant for ${ownerName}. Read the message, decide what to do, and use the available tools to do it.`,
    ``,
    `Live context (refreshed every turn, do not reuse values from previous turns):`,
    `- Local time now: ${localNow}`,
    `- Reference ISO timestamp (use this exact offset when building trigger_at): ${ctx.now}`,
    `- What you know about ${ownerName}: ${ownerCtx}`,
    `- Existing lists: ${lists}`,
    `- Upcoming pending items: ${pending}`,
    ``,
    `Rules:`,
    `1. Think before acting. Reads should call list_* tools and answer from the data.`,
    `2. Chains are fine: list_reminders -> delete_reminders with those ids.`,
    `3. "delete everything" -> delete_reminders with all=true. "delete the ones from monday" -> list first, then delete by id.`,
    `4. Never invent dates. If the user did not give a time, default to 12:00 only when the day is unambiguous; otherwise ask.`,
    `4b. Words like "morning", "wake up", "al despertar", "noche", "before bed", "antes de dormir" map to the user's wake_time / bed_time. Look them up in owner_context first. If they are missing, ask once and persist with remember_about_user (key wake_time or bed_time, value HH:MM 24h). Never assume 06:00 or 22:00 by default.`,
    `5. For relative times ("in N minutes", "later") ALWAYS call current_time first; the reference timestamp can be a few seconds stale. For absolute dates the reference is fine.`,
    `5b. trigger_at MUST use the user's local offset from the reference timestamp. If the reference is 2026-05-17T04:08:11-04:00, every trigger_at must end with -04:00 (or whatever offset the reference shows). Never emit Z, +00:00 or -00:00 unless the reference itself is in UTC. The system rejects UTC trigger_at when the user is not in UTC.`,
    `5c. Hours in the chat are LOCAL. If the user says "20:00" treat it as 20:00 local, not UTC. Reply in the same local clock.`,
    `6. One create_reminder call per event. For multiple sub-minute pings, fire one create_reminder per exact time (RRULE handles minutes poorly).`,
    `6b. Appointments with another person or place (medical, dental, government, flight, interview, school) MUST be created as both create_reminder (so it pings) AND create_event (so it shows in the calendar and blocks the slot). One without the other is a bug.`,
    `7. Use the memory tools to save tokens long term:`,
    `   - When the user shares a fact about themselves (routine, preference, family, work, health, recurring places), call remember_about_user with a short stable key. Reuse it next time instead of asking again.`,
    `   - Before answering "what do you know about me" call list_memories.`,
    `   - Only call forget_about_user when the user explicitly asks to forget something.`,
    `8. New abilities:`,
    `   - get_weather: pull current weather and short forecast. Use it for greetings, outfit advice, planning outdoors. Suggest practical things ("it is 7C, take a jacket").`,
    `   - get_news: short list of mostly positive international headlines. Summarise instead of dumping URLs.`,
    `   - web_search: live web lookup for facts that are not in the database. Cite the source title.`,
    `   - calendar_link: returns the private URL the user can open in a browser. Reply with the URL when asked "send me my calendar".`,
    `   - set_location: when the user tells you their city, save it so weather and the morning briefing are local.`,
    `8a. Second-brain abilities (use proactively when they add value):`,
    `   - add_journal_entry: when the user shares a reflection, idea, goal, feeling, or anything personal worth keeping. Tag it.`,
    `   - search_journal / list_journal: when the user asks "what was I thinking last week", "find that idea I had about X".`,
    `   - create_habit / log_habit / list_habits: track recurring practices the user mentions ("I run every Wednesday"). Log silently when they say "done".`,
    `   - connect_dots: scan upcoming days for two or more things on the same date and surface conflicts proactively.`,
    `   - list_nudges: pending proactive insights the cron has detected (collisions, stale habits, upcoming birthdays). Use at the start of a turn if the user opens with "hi" or "good morning" and has a fresh nudge worth raising. Then dismiss_nudge so it does not repeat.`,
    `8b. Contextual initiative rule of thumb: surface a nudge only when value > noise. The user must learn something they did not have in mind, the timing must be early enough to act, and the message must be easy to ignore. Do not mention nudges that are not actionable.`,
    `9. After tool calls, reply in ${replyLang}, brief, warm, 1-3 sentences. Do not recite every action; summarise.`,
    `9b. When you create a reminder, always include the local human time from local_time_human in your reply (e.g. "Set, I will ping you at 06:14 to make coffee"). The user can correct it.`,
    `9c. Reminders fire on a one-minute tick. If the user asks for something under one minute or with seconds, warn that delivery can drift up to a minute, or round up to the next minute and say so.`,
    `9d. Never name timezones, countries or cities the user lives in. Never say "your profile", "the system", "according to your data". If asked the time, just answer "It's HH:MM".`,
    `10. If a tool returns an error, explain it naturally and move on. Do not retry the same call.`,
    `11. Pure chit-chat ("hi", "thanks") needs no tools.`,
    `12. For "what time is it", "what day is today", "qué hora marca tu reloj interno", "qué hora tienes tú", "tu hora", always call current_time and report time_hhmm exactly as returned. The tool already returns local time; never recompute or mention UTC.`,
    `13. Confirmation is one-shot. If the user said yes / sí / dale / ok / confirmo to a pending action in the previous turn, EXECUTE it now. Do not ask the same confirmation again. If the user said no / cancela, drop it silently.`,
    `14. Always speak in local clock to the user. Never mention UTC, offsets, timezones, "mi reloj interno está en UTC", "según mi sistema", or "according to my data". You do not have a separate internal clock; you read the user's clock through current_time. If you list times, format them HH:MM in the user's local time only.`,
    ``,
    `Date format: ISO 8601 with the user's offset (e.g. 2026-09-09T09:00:00+02:00).`,
  ].join("\n");
}

interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<
    {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }
  >;
  tool_call_id?: string;
  name?: string;
}

interface AgentResult {
  reply: string;
  toolsUsed: string[];
}

async function callLLM(messages: AgentMessage[]): Promise<{
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.4,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`DeepSeek ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = await res.json() as {
      choices?: Array<
        {
          message?: {
            content: string | null;
            tool_calls?: Array<
              { id: string; function: { name: string; arguments: string } }
            >;
          };
        }
      >;
    };
    const msg = json.choices?.[0]?.message;
    const content = msg?.content ?? null;
    const tc = msg?.tool_calls ?? [];
    return {
      content,
      toolCalls: tc.map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runAgent(opts: {
  userText: string;
  ctx: NlpContext;
  owner: OwnerRow;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<AgentResult> {
  const ctxTool: ToolCtx = {
    ownerTimezone: opts.owner.timezone,
    ownerLanguage: (opts.owner as { language?: string }).language ?? "en",
    calendarBaseUrl: Deno.env.get("CALENDAR_BASE_URL") ?? undefined,
  };
  const messages: AgentMessage[] = [
    { role: "system", content: buildSystemPrompt(opts.ctx, opts.owner) },
    ...opts.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: opts.userText },
  ];

  const toolsUsed: string[] = [];
  let toolBudget = MAX_TOOLS;

  const createdSignatures = new Set<string>();

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const { content, toolCalls } = await callLLM(messages);

    if (toolCalls.length === 0) {
      return { reply: (content ?? "").trim() || "(sin respuesta)", toolsUsed };
    }

    messages.push({
      role: "assistant",
      content,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    for (const tc of toolCalls) {
      if (toolBudget <= 0) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify({ error: "tool budget exceeded" }),
        });
        continue;
      }
      toolBudget -= 1;
      toolsUsed.push(tc.name);

      let parsedArgs: ToolArgs = {};
      try {
        parsedArgs = JSON.parse(tc.arguments || "{}") as ToolArgs;
      } catch {
        parsedArgs = {};
      }

      const impl = TOOL_IMPL[tc.name];
      let result: unknown;
      if (!impl) {
        result = { error: `unknown tool: ${tc.name}` };
      } else {
        if (tc.name === "create_reminder" || tc.name === "create_event") {
          const title = String(parsedArgs.title ?? "").trim().toLowerCase();
          const when = String(
            parsedArgs.trigger_at ?? parsedArgs.starts_at ??
              parsedArgs.recurrence_rule ?? "",
          ).trim();
          const sig = `${tc.name}|${title}|${when}`;
          if (createdSignatures.has(sig)) {
            result = {
              error:
                "duplicate of an item already created in this turn; skipped",
            };
            safeLog("warn", "agent_dedup_skip", { tool: tc.name });
          } else {
            createdSignatures.add(sig);
            try {
              result = await impl(parsedArgs, ctxTool);
            } catch (err) {
              result = {
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }
        } else {
          try {
            result = await impl(parsedArgs, ctxTool);
          } catch (err) {
            result = {
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }
      safeLog("info", "agent_tool", {
        tool: tc.name,
        ok: !(result as { error?: unknown })?.error,
      });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.name,
        content: JSON.stringify(result).slice(0, 4000),
      });
    }
  }

  messages.push({
    role: "system",
    content:
      "Genera ya una respuesta final en español al usuario, sin llamar más tools.",
  });
  try {
    const final = await callLLM(messages);
    return { reply: (final.content ?? "").trim() || "Hecho.", toolsUsed };
  } catch {
    return {
      reply:
        "He hecho lo que he podido. Cuéntame si algo no salió como querías.",
      toolsUsed,
    };
  }
}
