/**
 * Telegram webhook route — multi-user bot handler.
 *
 * POST /webhook/telegram
 *   Verified by X-Telegram-Bot-Api-Secret-Token header.
 *   Looks up the user by telegram_chat_id stored in user_profiles.
 *   Runs the full message pipeline (same deps as /api/messages).
 *   Sends the reply back via the Telegram Bot API.
 *
 * This is a PUBLIC route (no authMiddleware) — Telegram calls it directly.
 * Security comes from the secret token header, not a JWT.
 *
 * Supports:
 *   - Text messages
 *   - Callback queries (approve / reject HitL actions)
 *   - /start command (registration welcome message)
 */

import { Hono } from "hono";
import { timingSafeEqual } from "crypto";
import type { MessageDeps, UserProfile, IntegrationFlags } from "./messages.ts";
import { buildPrompt, needsWebSearch, parseActionIntent } from "@relay/core";
import type { HistoryMessage, PromptConfig, PendingAction } from "@relay/core";
import type { PendingActionRow } from "../db/pending-actions.ts";
import { buildContextId } from "../db/messages.ts";

// ── Telegram API types (minimal surface) ─────────────────────────────────────

interface TelegramPhotoSize {
  file_id:    string;
  width:      number;
  height:     number;
  file_size?: number;
}

interface TelegramVoice {
  file_id:    string;
  duration:   number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramDocument {
  file_id:    string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; first_name?: string };
  text?: string;
  /** Array of photo sizes (Telegram always sends all resolutions); largest is last. */
  photo?:    TelegramPhotoSize[];
  voice?:    TelegramVoice;
  audio?:    TelegramVoice;   // same shape as voice
  document?: TelegramDocument;
  /** Text accompanying a photo or document. */
  caption?:  string;
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: TelegramMessage;
  data?: string; // "approve:<action_id>" | "reject:<action_id>"
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// ── Dependency injection interface ────────────────────────────────────────────

export interface WebhookDeps extends MessageDeps {
  // User lookup by Telegram chat ID
  findUserByTelegramId: (chatId: number) => Promise<{ userId: string; profile: UserProfile } | null>;
  // Send reply back to Telegram
  sendTelegramMessage: (botToken: string, chatId: number, text: string, opts?: TelegramSendOpts) => Promise<void>;
  // Send HitL inline keyboard
  sendTelegramAction: (botToken: string, chatId: number, text: string, actionId: string, actionDescription: string) => Promise<void>;
  // Answer a callback query (dismiss the loading spinner)
  answerCallbackQuery: (botToken: string, queryId: string, text?: string) => Promise<void>;
  // Edit the action message after approve/reject
  editTelegramMessage: (botToken: string, chatId: number, messageId: number, text: string) => Promise<void>;
  // Fetch + claim + resolve/reject a pending action
  fetchAction: (userId: string, actionId: string) => Promise<PendingActionRow | null>;
  claimAction: (actionId: string, userId: string) => Promise<boolean>;
  resolveAction: (actionId: string, result: string, userId: string) => Promise<void>;
  rejectAction: (actionId: string, errorMsg: string | undefined, userId: string) => Promise<void>;
  // Get bot token (may be per-user or shared)
  getBotToken: (userId: string) => Promise<string>;
  /** Per-sender rate limit (chatId). Returns false to silently drop the message. */
  checkRateLimit?: (chatId: number) => Promise<boolean>;
  /** Send a chat action (e.g. "typing") — best-effort, optional. */
  sendChatAction?: (botToken: string, chatId: number, action: string) => Promise<void>;
  /** Download a file from Telegram's CDN by file_id — returns raw buffer. */
  downloadTelegramFile?: (botToken: string, fileId: string) => Promise<Buffer>;
  /** Groq vision call — optional; falls back to graceful message if absent. */
  callGroqVision?: (
    prompt: string,
    image: { base64: string; mimeType: string },
    opts?: { apiKey?: string }
  ) => Promise<string>;
  /** Groq Whisper transcription — optional; falls back to graceful message if absent. */
  transcribeAudio?: (buffer: Buffer, filename: string, opts?: { apiKey?: string }) => Promise<string>;
}

interface TelegramSendOpts {
  parse_mode?: "Markdown" | "HTML";
  reply_to_message_id?: number;
}

// ── Typing indicator helper ───────────────────────────────────────────────────

/**
 * Send a "typing…" chat action every 4 s while the LLM (or other slow I/O) is
 * running. Telegram clears the indicator after ~5 s, so we refresh it before
 * that. Returns a cancel function — always call it in a `finally` block.
 */
function startTypingLoop(botToken: string, chatId: number, deps: WebhookDeps): () => void {
  if (!deps.sendChatAction) return () => {};
  deps.sendChatAction(botToken, chatId, "typing").catch(() => {});
  const id = setInterval(
    () => deps.sendChatAction!(botToken, chatId, "typing").catch(() => {}),
    4_000
  );
  return () => clearInterval(id);
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function createWebhookRoutes(deps: WebhookDeps): Hono {
  const webhook = new Hono();

  webhook.post("/telegram", async (c) => {
    // 1. Verify secret token — always return 403 regardless of whether the secret is
    //    missing or wrong, to avoid leaking configuration state to callers.
    //    Uses timing-safe comparison to prevent byte-by-byte enumeration attacks.
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[webhook] TELEGRAM_WEBHOOK_SECRET is not set.");
      return c.json({ error: "Forbidden" }, 403);
    }
    const header = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
    const secretBuf = Buffer.from(secret);
    const headerBuf = Buffer.from(header);
    const headerValid =
      secretBuf.length > 0 &&
      secretBuf.length === headerBuf.length &&
      timingSafeEqual(secretBuf, headerBuf);
    if (!headerValid) {
      return c.json({ error: "Forbidden" }, 403);
    }

    let update: TelegramUpdate;
    try {
      update = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // 2. Per-sender rate limit — silently drop if exceeded (don't expose to sender)
    const senderId = update.message?.chat?.id ?? update.callback_query?.from?.id;
    if (senderId && deps.checkRateLimit) {
      const allowed = await deps.checkRateLimit(senderId).catch(() => true);
      if (!allowed) return c.json({ ok: true });
    }

    // 3. Handle callback queries (HitL approve/reject)
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, deps);
      return c.json({ ok: true });
    }

    // 4. Dispatch by message type
    if (update.message) {
      const msg = update.message;
      if (msg.text) {
        await handleTextMessage(msg, deps);
      } else if (msg.photo?.length) {
        await handlePhotoMessage(msg, deps);
      } else if (msg.voice ?? msg.audio) {
        await handleVoiceMessage(msg, deps);
      } else if (msg.document) {
        await handleDocumentMessage(msg, deps);
      }
    }

    // Always return 200 quickly — Telegram retries on non-200
    return c.json({ ok: true });
  });

  return webhook;
}

// ── Text message handler ──────────────────────────────────────────────────────

async function handleTextMessage(msg: TelegramMessage, deps: WebhookDeps) {
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").slice(0, 4000); // cap before sending to LLM

  // Look up user
  const userCtx = await deps.findUserByTelegramId(chatId);
  if (!userCtx) {
    // Unknown user — silently drop or send a welcome
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token && text === "/start") {
      await deps.sendTelegramMessage(token, chatId,
        "👋 Welcome! Please sign up at the web app to link your Telegram account."
      );
    }
    return;
  }

  const { userId, profile } = userCtx;
  const token = await deps.getBotToken(userId);

  // /start command for already-registered user
  if (text === "/start") {
    await deps.sendTelegramMessage(token, chatId,
      `Welcome back, ${profile.display_name ?? "there"}! How can I help?`
    );
    return;
  }

  // Load integration flags
  const flags = await deps.loadIntegrationFlags(userId);

  // Build PromptConfig
  const promptConfig: PromptConfig = {
    userName:        profile.display_name,
    userTimezone:    profile.timezone,
    profileContext:  profile.profile_md,
    tavilyEnabled:   flags.tavilyEnabled,
    gmailEnabled:    flags.gmailEnabled,
    calendarEnabled: flags.calendarEnabled,
    notionEnabled:   flags.notionEnabled,
    vapiEnabled:     flags.vapiEnabled,
  };

  // Load history
  const contextId = buildContextId(userId, `tg:${chatId}`);
  const history = await deps.fetchHistory(userId, contextId, profile.max_history);

  // Optional web search
  let searchResults: string | undefined;
  if (profile.web_search && flags.tavilyEnabled && needsWebSearch(text)) {
    try {
      searchResults = await deps.runWebSearch?.(text, userId);
    } catch (err: any) {
      console.warn("Web search failed:", err.message);
    }
  }

  // Memory context
  const [memoryContext, relevantContext] = await Promise.all([
    deps.fetchMemoryContext(userId),
    deps.fetchRelevantContext(userId, text),
  ]);

  // Build prompt + call Groq (show typing indicator while waiting)
  const prompt = buildPrompt(text, promptConfig, { memoryContext, relevantContext, searchResults });

  const stopTyping = startTypingLoop(token, chatId, deps);
  let rawResponse: string;
  try {
    rawResponse = await deps.groqCall(prompt, {
      history,
      model: profile.ai_model,
      apiKey: (flags as any).groqApiKey,
    });
  } catch (err: any) {
    console.error("Groq error in webhook:", err.message);
    await deps.sendTelegramMessage(token, chatId,
      "⚠️ AI service is temporarily unavailable. Please try again."
    );
    return;
  } finally {
    stopTyping();
  }

  // Parse action intent
  const { clean: reply, action } = parseActionIntent(rawResponse);

  // Store pending action and send HitL buttons if needed
  let action_id: string | undefined;
  if (action) {
    try {
      action_id = await deps.storePendingAction(userId, action as PendingAction);
    } catch (err: any) {
      console.error("Failed to store pending action:", err.message);
    }
  }

  // Fire-and-forget persist
  const meta = { thread_id: `tg:${chatId}`, channel: "telegram" };
  Promise.all([
    deps.persistMessage(userId, "user", text, meta),
    deps.persistMessage(userId, "assistant", reply, { ...meta, has_action: !!action }),
    deps.persistMemoryIntents(userId, rawResponse),
  ]).catch((err) => console.error("Background persist error:", err.message));

  // Send reply
  if (action_id && action) {
    await deps.sendTelegramAction(token, chatId, reply, action_id, (action as PendingAction).description);
  } else {
    await deps.sendTelegramMessage(token, chatId, reply);
  }
}

// ── Photo message handler ─────────────────────────────────────────────────────

async function handlePhotoMessage(msg: TelegramMessage, deps: WebhookDeps) {
  const chatId  = msg.chat.id;
  const caption = (msg.caption ?? "").slice(0, 4000);

  const userCtx = await deps.findUserByTelegramId(chatId);
  if (!userCtx) return;

  const { userId, profile } = userCtx;
  const token = await deps.getBotToken(userId);

  // Graceful fallback — vision not wired up
  if (!deps.downloadTelegramFile || !deps.callGroqVision) {
    await deps.sendTelegramMessage(token, chatId,
      "📷 Photo received. I can't analyse images yet — please describe what you'd like help with."
    );
    return;
  }

  const photo     = msg.photo![msg.photo!.length - 1]; // largest resolution
  const stopTyping = startTypingLoop(token, chatId, deps);

  try {
    // Download the image
    let imageBuffer: Buffer;
    try {
      imageBuffer = await deps.downloadTelegramFile(token, photo.file_id);
    } catch (err: any) {
      console.error("Failed to download Telegram photo:", err.message);
      await deps.sendTelegramMessage(token, chatId,
        "⚠️ Failed to retrieve the photo. Please try again."
      );
      return;
    }

    const flags = await deps.loadIntegrationFlags(userId);

    const promptConfig: PromptConfig = {
      userName:        profile.display_name,
      userTimezone:    profile.timezone,
      profileContext:  profile.profile_md,
      tavilyEnabled:   flags.tavilyEnabled,
      gmailEnabled:    flags.gmailEnabled,
      calendarEnabled: flags.calendarEnabled,
      notionEnabled:   flags.notionEnabled,
      vapiEnabled:     flags.vapiEnabled,
    };

    const userText  = caption || "Please describe this image and help me with anything relevant.";
    const contextId = buildContextId(userId, `tg:${chatId}`);
    const [history, memoryContext, relevantContext] = await Promise.all([
      deps.fetchHistory(userId, contextId, profile.max_history),
      deps.fetchMemoryContext(userId),
      deps.fetchRelevantContext(userId, userText),
    ]);

    const prompt = buildPrompt(userText, promptConfig, { memoryContext, relevantContext });

    // Vision call — history is not passed (v1 limitation)
    let rawResponse: string;
    try {
      rawResponse = await deps.callGroqVision(
        prompt,
        { base64: imageBuffer.toString("base64"), mimeType: "image/jpeg" },
        { apiKey: (flags as any).groqApiKey }
      );
    } catch (err: any) {
      console.error("Groq vision error:", err.message);
      await deps.sendTelegramMessage(token, chatId,
        "⚠️ Image analysis is temporarily unavailable. Please try again."
      );
      return;
    }

    const { clean: reply, action } = parseActionIntent(rawResponse);

    let action_id: string | undefined;
    if (action) {
      try {
        action_id = await deps.storePendingAction(userId, action as PendingAction);
      } catch (err: any) {
        console.error("Failed to store pending action:", err.message);
      }
    }

    const inputText = caption ? `[Photo] ${caption}` : "[Photo]";
    const meta      = { thread_id: `tg:${chatId}`, channel: "telegram" };
    Promise.all([
      deps.persistMessage(userId, "user",      inputText, meta),
      deps.persistMessage(userId, "assistant", reply,     { ...meta, has_action: !!action }),
      deps.persistMemoryIntents(userId, rawResponse),
    ]).catch((err) => console.error("Background persist error:", err.message));

    if (action_id && action) {
      await deps.sendTelegramAction(token, chatId, reply, action_id, (action as PendingAction).description);
    } else {
      await deps.sendTelegramMessage(token, chatId, reply);
    }
  } finally {
    stopTyping();
  }
}

// ── Voice / audio message handler ─────────────────────────────────────────────

async function handleVoiceMessage(msg: TelegramMessage, deps: WebhookDeps) {
  const chatId = msg.chat.id;
  const voice  = msg.voice ?? msg.audio;
  if (!voice) return;

  const userCtx = await deps.findUserByTelegramId(chatId);
  if (!userCtx) return;

  const { userId } = userCtx;
  const token = await deps.getBotToken(userId);

  // Graceful fallback — transcription not wired up
  if (!deps.downloadTelegramFile || !deps.transcribeAudio) {
    await deps.sendTelegramMessage(token, chatId,
      "🎙️ Voice message received. I can't transcribe audio yet — please send a text message instead."
    );
    return;
  }

  // Typing indicator for download + transcription phase
  const stopTyping = startTypingLoop(token, chatId, deps);
  let transcribedText: string;
  try {
    const flags    = await deps.loadIntegrationFlags(userId);
    const filename = voice.mime_type?.includes("ogg") ? "audio.ogg" : "audio.mp3";
    const buffer   = await deps.downloadTelegramFile(token, voice.file_id);
    transcribedText = await deps.transcribeAudio(buffer, filename, { apiKey: (flags as any).groqApiKey });
  } catch (err: any) {
    console.error("Voice processing error:", err.message);
    await deps.sendTelegramMessage(token, chatId,
      "⚠️ Failed to process the voice message. Please try again or send text."
    );
    return;
  } finally {
    stopTyping(); // stop before handing off to text pipeline (which has its own loop)
  }

  if (!transcribedText) {
    await deps.sendTelegramMessage(token, chatId, "🔇 Couldn't detect any speech. Please try again.");
    return;
  }

  // Re-use the full text pipeline with the transcribed content
  await handleTextMessage({ ...msg, text: transcribedText, voice: undefined, audio: undefined }, deps);
}

// ── Document message handler ───────────────────────────────────────────────────

async function handleDocumentMessage(msg: TelegramMessage, deps: WebhookDeps) {
  const chatId = msg.chat.id;
  const doc    = msg.document!;
  const caption = msg.caption ?? "";

  const userCtx = await deps.findUserByTelegramId(chatId);
  if (!userCtx) return;

  const { userId } = userCtx;
  const token = await deps.getBotToken(userId);

  const name  = doc.file_name ?? "document";
  const reply = caption
    ? `📄 Got your file *${name}* with note: "${caption}". I can't read document contents directly — paste the text you'd like me to help with.`
    : `📄 Got your file *${name}*. I can't read document contents directly — paste the text you'd like me to help with.`;

  await deps.sendTelegramMessage(token, chatId, reply, { parse_mode: "Markdown" });
}

// ── Callback query handler (HitL approve/reject) ──────────────────────────────

async function handleCallbackQuery(query: TelegramCallbackQuery, deps: WebhookDeps) {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const data = query.data ?? "";

  if (!chatId) return;

  const userCtx = await deps.findUserByTelegramId(chatId);
  if (!userCtx) {
    await deps.answerCallbackQuery(
      process.env.TELEGRAM_BOT_TOKEN ?? "",
      query.id,
      "Session expired. Please try again."
    );
    return;
  }

  const { userId } = userCtx;
  const token = await deps.getBotToken(userId);

  // Parse "approve:<id>" or "reject:<id>"
  const colonIdx = data.indexOf(":");
  const action   = colonIdx === -1 ? data : data.slice(0, colonIdx);
  const actionId = colonIdx === -1 ? "" : data.slice(colonIdx + 1);
  const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!actionId || !UUID_RE.test(actionId) || (action !== "approve" && action !== "reject")) {
    await deps.answerCallbackQuery(token, query.id, "Unknown action.");
    return;
  }

  const row = await deps.fetchAction(userId, actionId);
  if (!row) {
    await deps.answerCallbackQuery(token, query.id, "Action not found or expired.");
    if (messageId) {
      await deps.editTelegramMessage(token, chatId, messageId, "⏱️ This action has expired.");
    }
    return;
  }

  if (row.status !== "pending") {
    await deps.answerCallbackQuery(token, query.id, `Already ${row.status}.`);
    return;
  }

  if (new Date(row.expires_at) < new Date()) {
    await deps.answerCallbackQuery(token, query.id, "Action has expired.");
    if (messageId) {
      await deps.editTelegramMessage(token, chatId, messageId, "⏱️ This action has expired.");
    }
    return;
  }

  if (action === "reject") {
    await deps.rejectAction(actionId, undefined, userId);
    await deps.answerCallbackQuery(token, query.id, "Cancelled.");
    if (messageId) {
      await deps.editTelegramMessage(token, chatId, messageId, `❌ Cancelled: ${row.description}`);
    }
    return;
  }

  // Approve — claim atomically (includes ownership check via userId)
  const claimed = await deps.claimAction(actionId, userId);
  if (!claimed) {
    await deps.answerCallbackQuery(token, query.id, "Already being processed.");
    return;
  }

  // Notify optimistically
  await deps.answerCallbackQuery(token, query.id, "Processing…");
  if (messageId) {
    await deps.editTelegramMessage(token, chatId, messageId, `⏳ Executing: ${row.description}`);
  }

  // Load integration loaders from the messages deps (reuse loadIntegrationFlags pattern)
  // We use a minimal loader shim — actual integration loading happens in loadUserIntegrations
  const { loadUserIntegrations } = await import("../db/load-integrations.ts");
  const { executeAction } = await import("@relay/core");

  const loaders = await loadUserIntegrations(userId, userCtx.profile.timezone);

  let resultText: string;
  try {
    const result = await executeAction(
      { type: row.action_type as PendingAction["type"], description: row.description, data: row.data },
      {},
      loaders
    );
    await deps.resolveAction(actionId, result, userId);
    resultText = `✅ Done: ${result}`;
  } catch (err: any) {
    console.error("executeAction error:", err.message);
    await deps.rejectAction(actionId, err.message, userId);
    resultText = `❌ Action failed. Please try again.`;
  }

  if (messageId) {
    await deps.editTelegramMessage(token, chatId, messageId, resultText);
  } else {
    await deps.sendTelegramMessage(token, chatId, resultText);
  }
}

// ── Default Telegram API helpers ──────────────────────────────────────────────

export async function telegramSend(
  botToken: string,
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("Telegram sendMessage failed:", err);
  }
}

export async function telegramEditMessage(
  botToken: string,
  chatId: number,
  messageId: number,
  text: string
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
}

export async function telegramAnswerCallback(
  botToken: string,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function telegramChatAction(
  botToken: string,
  chatId: number,
  action: string
): Promise<void> {
  // Best-effort — non-200 responses are silently ignored (typing is cosmetic)
  await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chatId, action }),
  });
}

export async function telegramDownloadFile(
  botToken: string,
  fileId: string
): Promise<Buffer> {
  // Step 1: resolve file_id → file_path
  const metaRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  if (!metaRes.ok) throw new Error(`getFile failed (${metaRes.status})`);
  const meta = (await metaRes.json()) as { result: { file_path: string } };
  const filePath = meta.result.file_path;

  // Step 2: download the actual bytes
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${filePath}`
  );
  if (!fileRes.ok) throw new Error(`File download failed (${fileRes.status})`);

  return Buffer.from(await fileRes.arrayBuffer());
}

export async function telegramSendWithAction(
  botToken: string,
  chatId: number,
  text: string,
  actionId: string,
  actionDescription: string
): Promise<void> {
  await telegramSend(botToken, chatId, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `approve:${actionId}` },
        { text: "❌ Cancel",  callback_data: `reject:${actionId}` },
      ]],
    },
  });
}

// ── DB helper: find user by Telegram chat ID ──────────────────────────────────

import { getServiceClient } from "../db/client.ts";
import type { UserProfile } from "./messages.ts";

export async function findUserByTelegramId(
  chatId: number
): Promise<{ userId: string; profile: UserProfile } | null> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("user_profiles")
    .select("user_id, timezone, display_name, profile_md, ai_model, max_history, web_search")
    .eq("telegram_id", String(chatId))
    .single();

  if (error || !data) return null;
  return {
    userId: data.user_id,
    profile: {
      timezone:     data.timezone,
      display_name: data.display_name ?? undefined,
      profile_md:   data.profile_md ?? undefined,
      ai_model:     data.ai_model,
      max_history:  data.max_history,
      web_search:   data.web_search,
    },
  };
}

// ── Default deps ──────────────────────────────────────────────────────────────

import { defaultMessageDeps } from "./messages.ts";
import {
  getPendingAction,
  claimPendingAction,
  resolvePendingAction,
  rejectPendingAction,
} from "../db/pending-actions.ts";
import { callGroqVision, transcribeAudio } from "../services/groq.ts";

export const defaultWebhookDeps: WebhookDeps = {
  ...defaultMessageDeps,
  findUserByTelegramId,
  sendTelegramMessage:  telegramSend,
  sendTelegramAction:   telegramSendWithAction,
  answerCallbackQuery:  telegramAnswerCallback,
  editTelegramMessage:  telegramEditMessage,
  fetchAction:          getPendingAction,
  claimAction:          (id, userId) => claimPendingAction(id, userId),
  resolveAction:        (id, result, userId) => resolvePendingAction(id, result, userId),
  rejectAction:         (id, msg, userId) => rejectPendingAction(id, msg, userId),
  getBotToken:          async () => process.env.TELEGRAM_BOT_TOKEN ?? "",
  sendChatAction:       telegramChatAction,
  downloadTelegramFile: telegramDownloadFile,
  callGroqVision,
  transcribeAudio,
  checkRateLimit:       async (chatId) => {
    try {
      const { getRateLimiter } = await import("../services/rate-limiter.ts");
      const result = await getRateLimiter().check(`wh:tg:${chatId}`, 20, 60_000);
      return result.allowed;
    } catch {
      return true; // fail open — never block on rate-limiter errors
    }
  },
};

export default createWebhookRoutes(defaultWebhookDeps);
