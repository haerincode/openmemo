import { db, getOwner, safeLog } from "./supabase.ts";
import { sendMessage } from "./telegram.ts";
import {
  handleCancelReminder,
  handleListReminders,
} from "./handlers/reminders.ts";
import { handleListTrunk } from "./handlers/trunk.ts";
import { getEventsInRange } from "./handlers/calendar.ts";
import { formatInTimeZone } from "date-fns-tz";
import type {
  IntentEnvelope,
  MemoryBubbleRow,
  OwnerRow,
  ReminderRow,
  TaskRow,
} from "./types.ts";

const WIPE_CONFIRMATION_WINDOW_MS = 60_000;

const EXPORT_BUCKET = "trunk";

const EXPORT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

const EXPORT_SPEC_VERSION = "memorae-personal-1";

const NOTES_LIMIT = 10;

const NOTES_TRUNCATE_CHARS = 80;

const EXPORT_AUDIT_LIMIT = 1000;

const wipeRequests = new Map<number, number>();

export function parseCommand(
  text: string,
): { command: string; args: string[] } {
  const trimmed = text.trim().replace(/^\//, "");
  const parts = trimmed.split(/\s+/).filter((s) => s.length > 0);
  if (parts.length === 0) {
    return { command: "", args: [] };
  }
  return { command: parts[0].toLowerCase(), args: parts.slice(1) };
}

export async function handleCommand(
  text: string,
  chatId: number,
  owner: OwnerRow,
): Promise<void> {
  const { command, args } = parseCommand(text);
  safeLog("info", "command_received", { command });

  try {
    switch (command) {
      case "start":
        await runStart(chatId, owner);
        break;
      case "help":
        await runHelp(chatId);
        break;
      case "list":
        await runList(chatId);
        break;
      case "cancel":
        await runCancel(chatId, args, text);
        break;
      case "today":
        await runDay(chatId, owner, 0, "Hoy");
        break;
      case "tomorrow":
        await runDay(chatId, owner, 1, "Mañana");
        break;
      case "notes":
        await runNotes(chatId);
        break;
      case "files":
        await runFiles(chatId);
        break;
      case "export":
        await runExport(chatId);
        break;
      case "wipe":
        await runWipe(chatId);
        break;
      case "tz":
        await runTz(chatId, args);
        break;
      default:
        await sendMessage(
          chatId,
          `No reconozco el comando «/${command}». Usa /help para ver lo que sé hacer.`,
        );
        safeLog("info", "command_outcome", { command, status: "unknown" });
        return;
    }
    safeLog("info", "command_outcome", { command, status: "ok" });
  } catch (err) {
    safeLog("error", "command_outcome", {
      command,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    await safeReply(
      chatId,
      `⚠️ Algo falló ejecutando «/${command}». Inténtalo de nuevo.`,
    );
  }
}

async function runStart(chatId: number, owner: OwnerRow): Promise<void> {
  const name = owner.display_name ?? "Owner";
  const lines = [
    `👋 Hola, ${name}.`,
    "Soy Memorae_Personal. Háblame en lenguaje natural y entenderé recordatorios, listas, tareas, notas y archivos.",
    "",
    "Comandos rápidos: /help /list /today /tomorrow /notes /files /export /wipe",
  ];
  await sendMessage(chatId, lines.join("\n"));
}

async function runHelp(chatId: number): Promise<void> {
  const lines = [
    "🧠 Memorae_Personal — capacidades:",
    "",
    "• Recordatorios puntuales, recurrentes, condicionales, escalados o compuestos.",
    "• Listas y elementos (compras, ideas, pendientes).",
    "• Tareas con fecha límite, prioridad y etiquetas.",
    "• Notas (Memory_Bubbles) con búsqueda semántica.",
    "• Archivos cifrados (Memory_Trunk).",
    "• Calendario interno (eventos).",
    "",
    "Habla en lenguaje natural. Ejemplos:",
    "• «recuérdame el martes a las 9 revisar el informe»",
    "• «cada lunes a las 19:30 entrenar»",
    "• «si para el viernes 18:00 no he cerrado el ticket, recuérdamelo cada día a las 20:00»",
    "• «añade leche a la lista de la compra»",
    "• «guarda esta nota: idea para el blog»",
    "• «¿qué tengo mañana?»",
    "",
    "Comandos directos:",
    "• /list — recordatorios pendientes",
    "• /cancel <id> — cancelar un recordatorio",
    "• /today, /tomorrow — agenda del día",
    "• /notes — últimas 10 notas",
    "• /files — archivos guardados",
    "• /export — descargar todos los datos (enlace 24 h)",
    "• /wipe — borrar todo (requiere doble confirmación)",
  ];
  await sendMessage(chatId, lines.join("\n"));
}

async function runList(chatId: number): Promise<void> {
  const reply = await handleListReminders();
  await sendMessage(chatId, reply);
}

async function runCancel(
  chatId: number,
  args: string[],
  rawText: string,
): Promise<void> {
  const shortId = (args[0] ?? "").trim().toLowerCase();
  if (shortId.length < 4) {
    await sendMessage(
      chatId,
      "Uso: /cancel <id> (mínimo 4 caracteres del id corto).",
    );
    return;
  }

  if (!/^[0-9a-f-]+$/.test(shortId)) {
    await sendMessage(chatId, "El id debe contener solo 0-9, a-f o «-».");
    return;
  }

  const { data, error } = await db
    .from("reminder")
    .select("id, content, status")
    .ilike("id", `${shortId}%`)
    .in("status", ["scheduled", "active", "paused"])
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`runCancel lookup failed: ${error.message}`);
  }
  if (!data) {
    await sendMessage(chatId, "No encontré ningún recordatorio con ese id.");
    return;
  }

  const row = data as Pick<ReminderRow, "id" | "content" | "status">;

  const envelope: IntentEnvelope = {
    intent: "cancel_reminder",
    confidence: 1,
    raw_text: rawText,
    entities: { reminder_id: row.id },
  };

  const reply = await handleCancelReminder(envelope);
  await sendMessage(chatId, reply);
}

async function runDay(
  chatId: number,
  owner: OwnerRow,
  dayOffset: number,
  label: string,
): Promise<void> {
  const tz = owner.timezone;
  const dayStart = startOfDayInTz(addDays(new Date(), dayOffset), tz);
  const dayEnd = addDays(dayStart, 1);

  const fromIso = dayStart.toISOString();
  const toIso = dayEnd.toISOString();

  const [reminders, events, tasks] = await Promise.all([
    fetchRemindersInRange(fromIso, toIso),
    getEventsInRange(dayStart, dayEnd),
    fetchTasksInRange(fromIso, toIso),
  ]);

  if (
    reminders.length === 0 &&
    events.length === 0 &&
    tasks.length === 0
  ) {
    await sendMessage(chatId, `${label} no tienes nada agendado.`);
    return;
  }

  const sections: string[] = [`📅 ${label}:`, ""];

  if (reminders.length > 0) {
    sections.push("⏰ Recordatorios:");
    for (const r of reminders) {
      const time = formatInTimeZone(
        new Date(r.next_trigger_at as string),
        tz,
        "HH:mm",
      );
      const content = r.content ?? "(sin contenido)";
      sections.push(`  • ${time} «${content}»`);
    }
    sections.push("");
  }

  if (events.length > 0) {
    sections.push("🗓 Eventos:");
    for (const e of events) {
      const time = formatInTimeZone(new Date(e.starts_at), tz, "HH:mm");
      const loc = e.location ? ` (@ ${e.location})` : "";
      sections.push(`  • ${time} «${e.title}»${loc}`);
    }
    sections.push("");
  }

  if (tasks.length > 0) {
    sections.push("✅ Tareas:");
    for (const t of tasks) {
      const time = t.due_at
        ? formatInTimeZone(new Date(t.due_at), tz, "HH:mm")
        : "—";
      sections.push(`  • ${time} «${t.title}»`);
    }
    sections.push("");
  }

  while (sections.length > 0 && sections[sections.length - 1] === "") {
    sections.pop();
  }

  await sendMessage(chatId, sections.join("\n"));
}

async function runNotes(chatId: number): Promise<void> {
  const { data, error } = await db
    .from("memory_bubble")
    .select("id, content, tags, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(NOTES_LIMIT);
  if (error) {
    throw new Error(`runNotes query failed: ${error.message}`);
  }
  const rows = (data ?? []) as Array<
    Pick<MemoryBubbleRow, "id" | "content" | "tags" | "created_at">
  >;

  if (rows.length === 0) {
    await sendMessage(chatId, "Aún no tienes notas en The Park.");
    return;
  }

  const lines: string[] = ["🌳 Tus últimas notas:", ""];
  for (const r of rows) {
    const shortId = r.id.substring(0, 8);
    const truncated = truncate(r.content, NOTES_TRUNCATE_CHARS);
    const tagSuffix = r.tags && r.tags.length > 0
      ? ` [${r.tags.map((t) => `#${t}`).join(" ")}]`
      : "";
    lines.push(`• [${shortId}] ${truncated}${tagSuffix}`);
    lines.push(`  ${formatRelativeDate(r.created_at)}`);
  }
  await sendMessage(chatId, lines.join("\n"));
}

async function runFiles(chatId: number): Promise<void> {
  const reply = await handleListTrunk(1);
  await sendMessage(chatId, reply);
}

async function runExport(chatId: number): Promise<void> {
  const owner = await getOwner();
  const [
    reminders,
    lists,
    listItems,
    tasks,
    bubbles,
    events,
    trunkObjects,
    auditLog,
  ] = await Promise.all([
    selectAll("reminder"),
    selectAll("list"),
    selectAll("list_item"),
    selectAll("task"),
    selectMemoryBubblesNoEmbedding(),
    selectAll("event"),
    selectAll("trunk_object"),
    selectAuditLogTail(EXPORT_AUDIT_LIMIT),
  ]);

  const payload = {
    exported_at: new Date().toISOString(),
    spec_version: EXPORT_SPEC_VERSION,
    data: {
      owner,
      reminders,
      lists,
      list_items: listItems,
      tasks,
      memory_bubbles: bubbles,
      events,
      trunk_objects: trunkObjects,
      audit_log: auditLog,
    },
  };

  const path = `exports/${crypto.randomUUID()}.json`;
  const body = JSON.stringify(payload, null, 2);
  const { error: uploadError } = await db.storage
    .from(EXPORT_BUCKET)
    .upload(path, body, {
      contentType: "application/json",
      cacheControl: "private, max-age=0",
      upsert: false,
    });
  if (uploadError) {
    throw new Error(`runExport upload failed: ${uploadError.message}`);
  }

  const { data: signed, error: signError } = await db.storage
    .from(EXPORT_BUCKET)
    .createSignedUrl(path, EXPORT_SIGNED_URL_TTL_SECONDS);
  if (signError || !signed?.signedUrl) {
    throw new Error(
      `runExport sign failed: ${signError?.message ?? "no signed url"}`,
    );
  }

  safeLog("info", "command_outcome", {
    command: "export",
    status: "ok",
    bytes: body.length,
  });
  await sendMessage(
    chatId,
    `📥 Tu export está listo (válido 24h):\n${signed.signedUrl}`,
  );
}

async function runWipe(chatId: number): Promise<void> {
  const now = Date.now();
  const previous = wipeRequests.get(chatId);
  const within = previous !== undefined &&
    now - previous <= WIPE_CONFIRMATION_WINDOW_MS;

  if (!within) {
    wipeRequests.set(chatId, now);
    await sendMessage(
      chatId,
      "⚠️ ¿Seguro que quieres BORRAR todo? Esta acción es irreversible. Confirma escribiendo /wipe de nuevo en los próximos 60 segundos.",
    );
    return;
  }

  wipeRequests.delete(chatId);

  await executeWipe();

  await sendMessage(
    chatId,
    "🧹 Borrado total completado. La cuenta queda vacía.",
  );
}

async function executeWipe(): Promise<void> {
  await emptyBucket(EXPORT_BUCKET);

  const orderedTables = [
    "job_outbox",
    "reminder",
    "list_item",
    "list",
    "task",
    "memory_bubble",
    "trunk_object",
    "event",
    "audit_log",
    "inbound_message",
  ];
  for (const table of orderedTables) {
    const { error } = await db
      .from(table)
      .delete()
      .gte("created_at", "1970-01-01T00:00:00Z");
    if (error) {
      throw new Error(
        `executeWipe delete on ${table} failed: ${error.message}`,
      );
    }
    safeLog("info", "wipe_table", { table });
  }
}

async function emptyBucket(bucket: string): Promise<void> {
  const PAGE = 1000;

  let safety = 100;
  while (safety-- > 0) {
    const { data, error } = await db.storage
      .from(bucket)
      .list("", { limit: PAGE });
    if (error) {
      throw new Error(`emptyBucket list failed: ${error.message}`);
    }
    const entries = (data ?? []) as Array<{ name: string }>;
    if (entries.length === 0) return;
    const paths = entries.map((e) => e.name);
    const { error: removeError } = await db.storage.from(bucket).remove(paths);
    if (removeError) {
      throw new Error(`emptyBucket remove failed: ${removeError.message}`);
    }

    for (const e of entries) {
      if (e.name.includes("/")) continue;
      const { data: subData } = await db.storage
        .from(bucket)
        .list(e.name, { limit: PAGE });
      const subEntries = (subData ?? []) as Array<{ name: string }>;
      if (subEntries.length > 0) {
        const subPaths = subEntries.map((s) => `${e.name}/${s.name}`);
        await db.storage.from(bucket).remove(subPaths);
      }
    }
  }
}

async function fetchRemindersInRange(
  fromIso: string,
  toIso: string,
): Promise<ReminderRow[]> {
  const { data, error } = await db
    .from("reminder")
    .select("*")
    .gte("next_trigger_at", fromIso)
    .lt("next_trigger_at", toIso)
    .in("status", ["scheduled", "active", "paused"])
    .order("next_trigger_at", { ascending: true });
  if (error) {
    throw new Error(`fetchRemindersInRange failed: ${error.message}`);
  }
  return (data ?? []) as ReminderRow[];
}

async function fetchTasksInRange(
  fromIso: string,
  toIso: string,
): Promise<TaskRow[]> {
  const { data, error } = await db
    .from("task")
    .select("*")
    .gte("due_at", fromIso)
    .lt("due_at", toIso)
    .eq("status", "pending")
    .order("due_at", { ascending: true });
  if (error) {
    throw new Error(`fetchTasksInRange failed: ${error.message}`);
  }
  return (data ?? []) as TaskRow[];
}

async function selectAll<T = Record<string, unknown>>(
  table: string,
): Promise<T[]> {
  const { data, error } = await db.from(table).select("*");
  if (error) {
    throw new Error(`selectAll(${table}) failed: ${error.message}`);
  }
  return (data ?? []) as T[];
}

async function selectMemoryBubblesNoEmbedding(): Promise<
  Array<Omit<MemoryBubbleRow, "embedding">>
> {
  const { data, error } = await db
    .from("memory_bubble")
    .select(
      "id, content, tags, source, language, created_at, updated_at, deleted_at",
    );
  if (error) {
    throw new Error(`selectMemoryBubblesNoEmbedding failed: ${error.message}`);
  }
  return (data ?? []) as Array<Omit<MemoryBubbleRow, "embedding">>;
}

async function selectAuditLogTail(
  n: number,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await db
    .from("audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(n);
  if (error) {
    throw new Error(`selectAuditLogTail failed: ${error.message}`);
  }
  return (data ?? []) as Record<string, unknown>[];
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function formatRelativeDate(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaMs = Date.now() - then;
  if (deltaMs < 60_000) return "hace unos segundos";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return minutes === 1 ? "hace 1 minuto" : `hace ${minutes} minutos`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "hace 1 hora" : `hace ${hours} horas`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return days === 1 ? "hace 1 día" : `hace ${days} días`;
  }
  const months = Math.floor(days / 30);
  return months === 1 ? "hace 1 mes" : `hace ${months} meses`;
}

function startOfDayInTz(date: Date, tz: string): Date {
  const ymd = formatInTimeZone(date, tz, "yyyy-MM-dd");
  const offset = formatInTimeZone(date, tz, "xxx");
  const iso = `${ymd}T00:00:00${offset === "Z" ? "+00:00" : offset}`;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`startOfDayInTz failed for ${date.toISOString()} / ${tz}`);
  }
  return start;
}

function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * 86_400_000);
}

async function safeReply(chatId: number, text: string): Promise<void> {
  try {
    await sendMessage(chatId, text);
  } catch (err) {
    safeLog("warn", "command_reply_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runTz(chatId: number, args: string[]): Promise<void> {
  const owner = await getOwner();
  const current = owner?.timezone ?? "UTC";
  const arg = (args[0] ?? "").trim();

  if (!arg) {
    const localNow = new Intl.DateTimeFormat("es-ES", {
      timeZone: current,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date());
    await sendMessage(
      chatId,
      `Tu zona actual: ${current}\nAhora ahí son las ${localNow}\n\nPara cambiarla escribe /tz <zona> (ej. /tz America/Caracas).`,
    );
    return;
  }

  let resolved = await tryTimezone(arg);

  if (!resolved) {
    resolved = matchKnownTimezone(arg);
  }

  if (!resolved) {
    await sendMessage(
      chatId,
      `No reconozco «${arg}» como zona horaria. Usa el formato IANA: Europe/Madrid, America/Caracas, America/Argentina/Buenos_Aires, America/Mexico_City, America/New_York, Asia/Tokyo, etc.`,
    );
    return;
  }

  const { error } = await db.from("owner").update({ timezone: resolved }).eq(
    "id",
    1,
  );
  if (error) {
    safeLog("error", "tz_update_failed", { error: error.message });
    await sendMessage(
      chatId,
      "No pude guardar la zona. Inténtalo de nuevo en un momento.",
    );
    return;
  }

  const localNow = new Intl.DateTimeFormat("es-ES", {
    timeZone: resolved,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());
  await sendMessage(
    chatId,
    `Zona actualizada: ${resolved}\nAhora ahí son las ${localNow}.`,
  );
  safeLog("info", "tz_updated", { timezone: resolved });
}

async function tryTimezone(tz: string): Promise<string | null> {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return null;
  }
}

function matchKnownTimezone(input: string): string | null {
  const known = [
    "Europe/Madrid",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Europe/Lisbon",
    "Europe/Rome",
    "Europe/Amsterdam",
    "America/Caracas",
    "America/Bogota",
    "America/Lima",
    "America/Santiago",
    "America/La_Paz",
    "America/Argentina/Buenos_Aires",
    "America/Mexico_City",
    "America/Monterrey",
    "America/Tijuana",
    "America/Guatemala",
    "America/Costa_Rica",
    "America/Panama",
    "America/Havana",
    "America/Santo_Domingo",
    "America/Puerto_Rico",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Sao_Paulo",
    "America/Montevideo",
    "Africa/Casablanca",
    "Africa/Johannesburg",
    "Asia/Tokyo",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Dubai",
    "Australia/Sydney",
  ];
  const q = input.toLowerCase().replace(/\s+/g, "_");

  const exact = known.find((z) => z.toLowerCase() === q);
  if (exact) return exact;

  const partial = known.find((z) =>
    z.toLowerCase().endsWith("/" + q) ||
    z.toLowerCase().split("/").pop() === q ||
    z.toLowerCase().includes(q)
  );
  return partial ?? null;
}
