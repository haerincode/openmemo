import { db, ensureOwner, safeLog } from "../_shared/supabase.ts";
import {
  answerCallbackQuery,
  sendChatAction,
  sendMessage,
  TelegramApiError,
  verifySecret,
} from "../_shared/telegram.ts";
import { DeepSeekError, parseIntent } from "../_shared/deepseek.ts";
import { runAgent } from "../_shared/agent.ts";
import { handleCommand as runCommand } from "../_shared/commands.ts";
import {
  handleAddPreNotifications,
  handleCancelReminder,
  handleCreateReminder,
  handleListReminders,
  handlePauseReminder,
  handleResumeReminder,
  handleUpdateReminder,
} from "../_shared/handlers/reminders.ts";
import {
  handleAddToList,
  handleCompleteListItem,
  handleCreateList,
  handleQueryOffice,
  handleRemoveListItem,
} from "../_shared/handlers/lists.ts";
import {
  handleCompleteTask,
  handleCreateTask,
} from "../_shared/handlers/tasks.ts";
import {
  handleCreateMemoryBubble,
  handleQueryPark,
} from "../_shared/handlers/park.ts";
import {
  handleRetrieveFile,
  handleStoreFile,
} from "../_shared/handlers/trunk.ts";
import {
  handleCalendarCreate,
  handleCalendarQuery,
} from "../_shared/handlers/calendar.ts";
import type {
  IntentEnvelope,
  IntentType,
  NlpContext,
  OwnerRow,
} from "../_shared/types.ts";

const OWNER_CHAT_ID = Number(Deno.env.get("OWNER_CHAT_ID"));
if (!OWNER_CHAT_ID || Number.isNaN(OWNER_CHAT_ID)) {
  throw new Error("Missing or invalid OWNER_CHAT_ID env var");
}

const PROCESSING_TIMEOUT_MS = 12_000;

interface TelegramChat {
  id: number;
}

interface TelegramUser {
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramFileRef {
  file_id: string;
}

interface TelegramMessage {
  message_id?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  document?: TelegramFileRef;
  photo?: TelegramFileRef[];
  audio?: TelegramFileRef;
  voice?: TelegramFileRef;
}

interface TelegramCallbackQuery {
  id?: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface EdgeRuntimeLike {
  waitUntil?: (p: Promise<unknown>) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asTelegramMessage(value: unknown): TelegramMessage | null {
  if (!isRecord(value)) return null;
  const chat = value.chat;
  if (!isRecord(chat) || typeof chat.id !== "number") return null;
  const msg: TelegramMessage = { chat: { id: chat.id } };
  if (typeof value.message_id === "number") msg.message_id = value.message_id;
  if (isRecord(value.from)) {
    const from: TelegramUser = {};
    if (typeof value.from.first_name === "string") {
      from.first_name = value.from.first_name;
    }
    if (typeof value.from.last_name === "string") {
      from.last_name = value.from.last_name;
    }
    if (typeof value.from.username === "string") {
      from.username = value.from.username;
    }
    msg.from = from;
  }
  if (typeof value.text === "string") msg.text = value.text;
  if (isRecord(value.document) && typeof value.document.file_id === "string") {
    msg.document = { file_id: value.document.file_id };
  }
  if (Array.isArray(value.photo)) {
    const photos: TelegramFileRef[] = [];
    for (const p of value.photo) {
      if (isRecord(p) && typeof p.file_id === "string") {
        photos.push({ file_id: p.file_id });
      }
    }
    if (photos.length > 0) msg.photo = photos;
  }
  if (isRecord(value.audio) && typeof value.audio.file_id === "string") {
    msg.audio = { file_id: value.audio.file_id };
  }
  if (isRecord(value.voice) && typeof value.voice.file_id === "string") {
    msg.voice = { file_id: value.voice.file_id };
  }
  if (typeof value.caption === "string") msg.caption = value.caption;
  return msg;
}

function asTelegramUpdate(value: unknown): TelegramUpdate {
  const update: TelegramUpdate = {};
  if (!isRecord(value)) return update;
  if (typeof value.update_id === "number") update.update_id = value.update_id;
  const message = asTelegramMessage(value.message);
  if (message) update.message = message;
  const editedMessage = asTelegramMessage(value.edited_message);
  if (editedMessage) update.edited_message = editedMessage;
  if (isRecord(value.callback_query)) {
    const cqMessage = asTelegramMessage(value.callback_query.message);
    const cq: TelegramCallbackQuery = cqMessage ? { message: cqMessage } : {};
    if (typeof value.callback_query.id === "string") {
      cq.id = value.callback_query.id;
    }
    if (typeof value.callback_query.data === "string") {
      cq.data = value.callback_query.data;
    }
    update.callback_query = cq;
  }
  return update;
}

function extractChat(
  update: TelegramUpdate,
): { chatId: number; displayName: string; message: TelegramMessage } | null {
  const msg = update.message ?? update.edited_message ??
    update.callback_query?.message ?? null;
  if (!msg) return null;
  const parts: string[] = [];
  if (msg.from?.first_name) parts.push(msg.from.first_name);
  if (msg.from?.last_name) parts.push(msg.from.last_name);
  const displayName = parts.join(" ").trim() || msg.from?.username || "Owner";
  return { chatId: msg.chat.id, displayName, message: msg };
}

function hasFile(message: TelegramMessage): boolean {
  return Boolean(
    message.document ||
      (message.photo && message.photo.length > 0) ||
      message.audio ||
      message.voice,
  );
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (!verifySecret(req)) {
    safeLog("warn", "webhook_invalid_secret", {});
    return new Response("forbidden", { status: 403 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (err) {
    safeLog("warn", "webhook_invalid_json", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("ok");
  }

  const update = asTelegramUpdate(rawBody);

  if (update.callback_query && update.callback_query.id) {
    const cq = update.callback_query;
    const cqId = cq.id as string;
    const cqChatId = cq.message?.chat.id;
    if (cqChatId && cqChatId === OWNER_CHAT_ID) {
      try {
        if (cq.data === "ack") {
          const acked = await acknowledgeLatestReminder();
          await answerCallbackQuery(
            cqId,
            acked ? "✅ Marcado como hecho" : "No hay pendientes",
          );
          if (acked) {
            await sendMessage(
              cqChatId,
              "✅ Perfecto, marcado como completado. Buen trabajo.",
            );
          }
        } else if (cq.data === "snooze_30") {
          const snoozed = await snoozeLatestReminder(30);
          await answerCallbackQuery(
            cqId,
            snoozed ? "⏰ Te aviso en 30 min" : "No hay pendientes",
          );
          if (snoozed) {
            await sendMessage(
              cqChatId,
              "⏰ Vale, te vuelvo a avisar en 30 minutos.",
            );
          }
        } else if (cq.data === "cancel") {
          const cancelled = await cancelLatestPendingReminder();
          await answerCallbackQuery(
            cqId,
            cancelled ? "❌ Cancelado" : "No hay pendientes",
          );
          if (cancelled) {
            await sendMessage(cqChatId, "❌ Recordatorio cancelado.");
          }
        } else {
          await answerCallbackQuery(cqId);
        }
      } catch (err) {
        safeLog("error", "callback_query_failed", {
          error: err instanceof Error ? err.message : String(err),
          callback_id: cqId,
          callback_data: cq.data,
        });
        try {
          await answerCallbackQuery(cqId, "Error procesando");
        } catch {}
      }
      return new Response("ok");
    }

    try {
      await answerCallbackQuery(cqId);
    } catch {}
    return new Response("ok");
  }

  const chatInfo = extractChat(update);

  if (!chatInfo) {
    safeLog("warn", "webhook_no_chat", { update_id: update.update_id });
    return new Response("ok");
  }

  if (chatInfo.chatId !== OWNER_CHAT_ID) {
    safeLog("warn", "webhook_unauthorized_chat", { chat_id: chatInfo.chatId });
    try {
      await sendMessage(
        chatInfo.chatId,
        "Bot privado, acceso restringido al propietario.",
      );
    } catch (err) {
      safeLog("warn", "stranger_notice_failed", {
        chat_id: chatInfo.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return new Response("ok");
  }

  try {
    const owner = await ensureOwner(
      chatInfo.chatId,
      chatInfo.displayName,
    );

    const rawText = chatInfo.message.text ?? null;
    const inboundId = await persistInbound(update, rawText);

    if (rawText && rawText.startsWith("/")) {
      await handleCommand(rawText, chatInfo.chatId, owner);
      await markProcessed(inboundId);
      return new Response("ok");
    }

    if (hasFile(chatInfo.message)) {
      let trunkReply = "";
      try {
        trunkReply = await handleStoreFile(
          chatInfo.message as unknown as Parameters<typeof handleStoreFile>[0],
          chatInfo.chatId,
        );
      } catch (err) {
        safeLog("warn", "file_store_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const caption = chatInfo.message.caption;
      if (caption && caption.trim().length > 0) {
        if (trunkReply) await sendMessage(chatInfo.chatId, trunkReply);
        await sendChatAction(chatInfo.chatId, "typing");
        const ctx = await buildNlpContext(owner);
        const result = await runAgent({
          userText: caption,
          ctx,
          owner,
          history: [],
        });
        const captionReply = result.reply.trim() || "Hecho.";
        await sendMessage(chatInfo.chatId, captionReply, {
          parse_mode: "Markdown",
        }).catch(
          () =>
            sendMessage(
              chatInfo.chatId,
              captionReply.replace(/[_*`\[\]]/g, ""),
            ),
        );
        const pseudo: IntentEnvelope = {
          intent: "unknown",
          confidence: 1,
          raw_text: caption,
          entities: { reply_text: captionReply },
        };
        await persistEnvelope(inboundId, pseudo, captionReply);
      } else if (chatInfo.message.voice) {
        await sendMessage(
          chatInfo.chatId,
          "🎤 Audio guardado. Escríbeme lo que necesitas y lo gestiono al instante.\n\n_(Transcripción automática próximamente)_",
          { parse_mode: "Markdown" },
        );
      } else if (trunkReply) {
        await sendMessage(chatInfo.chatId, trunkReply);
      }

      await markProcessed(inboundId);
      return new Response("ok");
    }

    if (!rawText) {
      safeLog("info", "webhook_empty_text", { update_id: update.update_id });
      await sendMessage(
        chatInfo.chatId,
        "Recibí tu mensaje, pero aún no soporto este tipo de contenido.",
      );
      await markProcessed(inboundId);
      return new Response("ok");
    }

    await sendChatAction(chatInfo.chatId, "typing");
    const ctx = await buildNlpContext(owner);

    const work = runNlpPipeline({
      text: rawText,
      ctx,
      chatId: chatInfo.chatId,
      owner,
      inboundId,
    });

    const timedOut = await raceWithTimeout(work, PROCESSING_TIMEOUT_MS);

    if (timedOut) {
      safeLog("info", "nlp_timeout_provisional", { inbound_id: inboundId });
      try {
        await sendMessage(
          chatInfo.chatId,
          "Sigo procesando, te respondo en breve…",
        );
      } catch (err) {
        safeLog("warn", "provisional_send_failed", {
          inbound_id: inboundId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const continuation = work.catch((err) => {
        safeLog("error", "background_failure", {
          inbound_id: inboundId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      const edgeRuntime = (globalThis as unknown as {
        EdgeRuntime?: EdgeRuntimeLike;
      }).EdgeRuntime;
      if (edgeRuntime?.waitUntil) {
        edgeRuntime.waitUntil(continuation);
      }
    }

    return new Response("ok");
  } catch (err) {
    const errorPayload: Record<string, unknown> = {
      chat_id: chatInfo.chatId,
      error: err instanceof Error ? err.message : String(err),
    };
    if (err instanceof DeepSeekError) {
      errorPayload.endpoint = err.endpoint;
      errorPayload.status_code = err.statusCode;
    } else if (err instanceof TelegramApiError) {
      errorPayload.method = err.method;
      errorPayload.status_code = err.statusCode;
    }
    safeLog("error", "webhook_failure", errorPayload);

    try {
      const debugMsg = `⚠️ DEBUG ERROR: ${
        err instanceof Error ? err.message : String(err)
      }`;
      await sendMessage(
        chatInfo.chatId,
        debugMsg.slice(0, 4000),
      );
    } catch {
    }
    return new Response("ok");
  }
});

interface NlpPipelineArgs {
  text: string;
  ctx: NlpContext;
  chatId: number;
  owner: OwnerRow;
  inboundId: number;
}

async function runNlpPipeline(args: NlpPipelineArgs): Promise<void> {
  const { text, ctx, chatId, owner, inboundId } = args;

  const { data: historyData } = await db
    .from("inbound_message")
    .select("raw_text, bot_reply")
    .not("raw_text", "is", null)
    .lt("id", inboundId)
    .order("created_at", { ascending: false })
    .limit(5);
  const historyTurns: Array<{ role: "user" | "assistant"; content: string }> =
    [];
  const rows = ((historyData ?? []) as Array<
    { raw_text: string | null; bot_reply: string | null }
  >).reverse();
  for (const r of rows) {
    if (r.raw_text) historyTurns.push({ role: "user", content: r.raw_text });
    if (r.bot_reply) {
      historyTurns.push({ role: "assistant", content: r.bot_reply });
    }
  }

  const result = await runAgent({
    userText: text,
    ctx,
    owner,
    history: historyTurns,
  });

  const reply = result.reply.trim() || "Hecho.";
  await sendMessage(chatId, reply, { parse_mode: "Markdown" }).catch(
    () => sendMessage(chatId, reply.replace(/[_*`\[\]]/g, "")),
  );

  safeLog("info", "agent_done", {
    inbound_id: inboundId,
    tools: result.toolsUsed,
  });

  const pseudoEnvelope: IntentEnvelope = {
    intent: "unknown",
    confidence: 1,
    raw_text: text,
    entities: { reply_text: reply },
  };
  await persistEnvelope(inboundId, pseudoEnvelope, reply);
}

async function raceWithTimeout(
  work: Promise<void>,
  ms: number,
): Promise<boolean> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), ms);
  });

  const wrappedWork = work.then(() => "done" as const);

  try {
    const result = await Promise.race([wrappedWork, timeoutPromise]);
    return result === "timeout";
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
}

async function buildNlpContext(owner: OwnerRow): Promise<NlpContext> {
  const { formatInTimeZone } = await import("date-fns-tz");
  const nowDate = new Date();
  const now = formatInTimeZone(
    nowDate,
    owner.timezone,
    "yyyy-MM-dd'T'HH:mm:ssxxx",
  );

  const { data: listsData, error: listsError } = await db
    .from("list")
    .select("name")
    .order("name", { ascending: true });
  if (listsError) {
    throw new Error(
      `buildNlpContext lists query failed: ${listsError.message}`,
    );
  }

  const { data: remindersData, error: remindersError } = await db
    .from("reminder")
    .select("id, content, next_trigger_at")
    .in("status", ["scheduled", "active", "paused"])
    .order("next_trigger_at", { ascending: true, nullsFirst: false })
    .limit(20);
  if (remindersError) {
    throw new Error(
      `buildNlpContext reminders query failed: ${remindersError.message}`,
    );
  }

  const { data: tasksData, error: tasksError } = await db
    .from("task")
    .select("id, title, due_at")
    .eq("status", "pending")
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(20);
  if (tasksError) {
    throw new Error(
      `buildNlpContext tasks query failed: ${tasksError.message}`,
    );
  }

  const list_names: string[] = ((listsData ?? []) as Array<{ name: string }>)
    .map((r) => r.name);

  type PendingItem = NlpContext["pending_short_items"][number];

  const reminderItems: PendingItem[] = (
    (remindersData ?? []) as Array<{
      id: string;
      content: string | null;
      next_trigger_at: string | null;
    }>
  ).map((r) => ({
    short_id: r.id.substring(0, 8),
    kind: "reminder",
    title: r.content ?? "(sin contenido)",
    next_trigger_at: r.next_trigger_at ?? undefined,
  }));

  const taskItems: PendingItem[] = (
    (tasksData ?? []) as Array<{
      id: string;
      title: string;
      due_at: string | null;
    }>
  ).map((t) => ({
    short_id: t.id.substring(0, 8),
    kind: "task",
    title: t.title,
    due_at: t.due_at ?? undefined,
  }));

  const FAR_FUTURE = Number.POSITIVE_INFINITY;
  const sortKey = (item: PendingItem): number => {
    const iso = item.next_trigger_at ?? item.due_at;
    if (!iso) return FAR_FUTURE;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? FAR_FUTURE : t;
  };

  const pending_short_items = [...reminderItems, ...taskItems]
    .sort((a, b) => sortKey(a) - sortKey(b))
    .slice(0, 20);

  const nextWeekEnd = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const { data: upcomingEventsData } = await db
    .from("event")
    .select("title, starts_at")
    .gte("starts_at", new Date().toISOString())
    .lte("starts_at", nextWeekEnd)
    .order("starts_at", { ascending: true })
    .limit(10);

  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const { data: staleAcks } = await db
    .from("pending_ack")
    .select("reminder_id")
    .is("acknowledged_at", null)
    .lte("delivered_at", threeDaysAgo)
    .limit(5);

  let staleReminderContents: string[] = [];
  if (staleAcks && staleAcks.length > 0) {
    const staleIds = (staleAcks as Array<{ reminder_id: string }>).map((a) =>
      a.reminder_id
    );
    const { data: staleData } = await db
      .from("reminder")
      .select("content")
      .in("id", staleIds);
    staleReminderContents =
      ((staleData ?? []) as Array<{ content: string | null }>)
        .map((r) => r.content ?? "(sin contenido)")
        .filter((c) => c !== "(sin contenido)");
  }

  const { data: contextData } = await db
    .from("owner_context")
    .select("category, key, value")
    .order("category", { ascending: true });
  const ownerContext = (contextData ?? []) as Array<
    { category: string; key: string; value: string }
  >;

  return {
    now,
    timezone: owner.timezone,
    list_names,
    pending_short_items,
    upcoming_events: (upcomingEventsData ?? []) as Array<
      { title: string; starts_at: string }
    >,
    stale_reminders: staleReminderContents,
    owner_context: ownerContext,
  };
}

async function handleCommand(
  text: string,
  chatId: number,
  owner: OwnerRow,
): Promise<void> {
  await runCommand(text, chatId, owner);
}

async function persistInbound(
  update: TelegramUpdate,
  rawText: string | null,
): Promise<number> {
  const { data, error } = await db
    .from("inbound_message")
    .insert({
      telegram_update: update as unknown as Record<string, unknown>,
      raw_text: rawText,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(
      `persistInbound failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return (data as { id: number }).id;
}

async function persistEnvelope(
  inboundId: number,
  envelope: IntentEnvelope,
  botReply: string | null = null,
): Promise<void> {
  const update: Record<string, unknown> = {
    intent_envelope: envelope as unknown as Record<string, unknown>,
    processed_at: new Date().toISOString(),
  };
  if (botReply !== null) update.bot_reply = botReply;
  const { error } = await db
    .from("inbound_message")
    .update(update)
    .eq("id", inboundId);

  if (error) {
    throw new Error(`persistEnvelope failed: ${error.message}`);
  }
}

async function markProcessed(inboundId: number): Promise<void> {
  const { error } = await db
    .from("inbound_message")
    .update({ processed_at: new Date().toISOString() })
    .eq("id", inboundId);

  if (error) {
    safeLog("warn", "mark_processed_failed", {
      inbound_id: inboundId,
      error: error.message,
    });
  }
}

async function acknowledgeLatestReminder(): Promise<boolean> {
  const { data, error } = await db
    .from("pending_ack")
    .select("id, reminder_id, delivered_at")
    .is("acknowledged_at", null)
    .order("delivered_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return false;

  const ack = data as { id: string; reminder_id: string; delivered_at: string };

  await db.from("pending_ack").update({
    acknowledged_at: new Date().toISOString(),
  }).eq("id", ack.id);

  await db.from("reminder").update({
    status: "completed",
    next_trigger_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", ack.reminder_id).in("status", ["scheduled", "active"]);

  const now = new Date();
  const responseSeconds = ack.delivered_at
    ? Math.floor((now.getTime() - new Date(ack.delivered_at).getTime()) / 1000)
    : null;
  await db.from("feedback_event").insert({
    reminder_id: ack.reminder_id,
    event_type: "acknowledged",
    hour_of_day: now.getUTCHours(),
    day_of_week: now.getUTCDay(),
    response_time_seconds: responseSeconds,
  });

  safeLog("info", "reminder_acknowledged", { reminder_id: ack.reminder_id });
  return true;
}

async function snoozeLatestReminder(minutes: number): Promise<boolean> {
  const { data, error } = await db
    .from("pending_ack")
    .select("id, reminder_id")
    .is("acknowledged_at", null)
    .order("delivered_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return false;

  const ack = data as { id: string; reminder_id: string };
  const newTrigger = new Date(Date.now() + minutes * 60_000).toISOString();

  await db.from("pending_ack").update({
    acknowledged_at: new Date().toISOString(),
  }).eq("id", ack.id);

  await db.from("reminder").update({
    next_trigger_at: newTrigger,
    status: "scheduled",
    updated_at: new Date().toISOString(),
  }).eq("id", ack.reminder_id);

  const now = new Date();
  await db.from("feedback_event").insert({
    reminder_id: ack.reminder_id,
    event_type: "snoozed",
    hour_of_day: now.getUTCHours(),
    day_of_week: now.getUTCDay(),
    response_time_seconds: null,
  });

  safeLog("info", "reminder_snoozed", {
    reminder_id: ack.reminder_id,
    minutes,
  });
  return true;
}

async function cancelLatestPendingReminder(): Promise<boolean> {
  const { data, error } = await db
    .from("pending_ack")
    .select("id, reminder_id")
    .is("acknowledged_at", null)
    .order("delivered_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return false;

  const ack = data as { id: string; reminder_id: string };

  await db.from("pending_ack").update({
    acknowledged_at: new Date().toISOString(),
  }).eq("id", ack.id);

  await db.from("reminder").update({
    status: "cancelled",
    next_trigger_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", ack.reminder_id);

  const now = new Date();
  await db.from("feedback_event").insert({
    reminder_id: ack.reminder_id,
    event_type: "cancelled",
    hour_of_day: now.getUTCHours(),
    day_of_week: now.getUTCDay(),
    response_time_seconds: null,
  });

  safeLog("info", "reminder_cancelled_via_button", {
    reminder_id: ack.reminder_id,
  });
  return true;
}

interface BulkCreated {
  title: string;
  triggerAt: Date;
  ok: boolean;
  reason?: string;
}

async function createBulkEvents(
  events: NonNullable<IntentEnvelope["entities"]["events"]>,
  timezone: string,
): Promise<BulkCreated[]> {
  const out: BulkCreated[] = [];
  const now = Date.now();
  for (const entry of events) {
    const title = (entry.title ?? "").trim();
    const iso = (entry.trigger_at ?? "").trim();
    if (!title) {
      out.push({
        title: "(sin título)",
        triggerAt: new Date(),
        ok: false,
        reason: "sin título",
      });
      continue;
    }
    if (!iso) {
      out.push({
        title,
        triggerAt: new Date(),
        ok: false,
        reason: "sin fecha",
      });
      continue;
    }
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
      out.push({
        title,
        triggerAt: new Date(),
        ok: false,
        reason: "fecha inválida",
      });
      continue;
    }
    if (ms <= now - 60_000) {
      out.push({
        title,
        triggerAt: new Date(ms),
        ok: false,
        reason: "fecha en pasado",
      });
      continue;
    }
    const trigger = new Date(ms);
    const { error } = await db.from("reminder").insert({
      kind: "static",
      status: "scheduled",
      content: title,
      next_trigger_at: trigger.toISOString(),
      timezone,
    });
    if (error) {
      safeLog("warn", "bulk_event_insert_failed", {
        title: title.substring(0, 40),
        error: error.message,
      });
      out.push({ title, triggerAt: trigger, ok: false, reason: "error de BD" });
    } else {
      out.push({ title, triggerAt: trigger, ok: true });
    }
  }
  safeLog("info", "bulk_events_created", {
    total: out.length,
    ok: out.filter((e) => e.ok).length,
  });
  return out;
}

function formatBulkSummary(created: BulkCreated[], timezone: string): string {
  const ok = created.filter((e) => e.ok);
  const failed = created.filter((e) => !e.ok);
  const lines: string[] = [];
  if (ok.length === 0) {
    lines.push("No pude guardar ninguno. Revisa las fechas.");
  } else {
    lines.push(
      `📅 Guardé ${ok.length} ${ok.length === 1 ? "evento" : "eventos"}:`,
    );
    for (const e of ok) {
      const local = e.triggerAt.toLocaleString("es-ES", {
        timeZone: timezone,
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(`• ${local} — ${e.title}`);
    }
  }
  if (failed.length > 0) {
    lines.push("");
    lines.push(`No guardé ${failed.length}:`);
    for (const e of failed) {
      lines.push(`• ${e.title} (${e.reason ?? "?"})`);
    }
  }
  return lines.join("\n");
}
