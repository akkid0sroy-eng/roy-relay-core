/**
 * WhatsApp Cloud API webhook — multi-user bot handler.
 *
 * GET  /webhook/whatsapp  — Meta webhook verification challenge
 * POST /webhook/whatsapp  — Inbound message handler
 *
 * Security: every POST is verified with HMAC-SHA256 over the raw body
 * using WHATSAPP_APP_SECRET (X-Hub-Signature-256 header).
 *
 * Supported update types:
 *   - Text messages      → full message pipeline → reply or HitL buttons
 *   - Interactive reply  → approve / reject a pending HitL action
 *   - Status updates     → acknowledged silently (no processing)
 *
 * User linking flow (first-time user):
 *   1. Unknown phone → bot asks for email address
 *   2. User replies with email → bot sends magic-link email with whatsapp_phone in metadata
 *   3. User clicks link → /auth/callback stores whatsapp_phone in user_profiles
 *   4. Subsequent messages are routed to the linked account
 */

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { buildPrompt, needsWebSearch, parseActionIntent } from "@relay/core";
import type { HistoryMessage, PromptConfig, PendingAction } from "@relay/core";
import type { MessageDeps, UserProfile, IntegrationFlags } from "./messages.ts";
import type { PendingActionRow } from "../db/pending-actions.ts";
import { buildContextId } from "../db/messages.ts";

// ── WhatsApp Cloud API types ──────────────────────────────────────────────────

interface WAMetadata   { display_phone_number: string; phone_number_id: string }
interface WAContact    { wa_id: string; profile: { name?: string } }
interface WATextMsg    { from: string; id: string; type: "text"; text: { body: string } }
interface WAInteractive {
  from: string; id: string; type: "interactive";
  interactive: { type: "button_reply"; button_reply: { id: string; title: string } };
}
type WAMessage = WATextMsg | WAInteractive;

interface WAChangeValue {
  messaging_product: "whatsapp";
  metadata: WAMetadata;
  contacts?: WAContact[];
  messages?: WAMessage[];
  statuses?: unknown[];
}

interface WAUpdate {
  object: string;
  entry: Array<{ id: string; changes: Array<{ value: WAChangeValue; field: string }> }>;
}

// ── Dependency injection interface ────────────────────────────────────────────

export interface WebhookWhatsAppDeps extends MessageDeps {
  /** Look up a registered user by their WhatsApp phone number. */
  findUserByPhone:  (phone: string) => Promise<{ userId: string; profile: UserProfile } | null>;
  /** Send a plain text message via WhatsApp Cloud API. */
  sendTextMessage:  (accessToken: string, phoneNumberId: string, to: string, text: string) => Promise<void>;
  /** Send a text message with Approve / Cancel inline buttons. */
  sendHitLButtons:  (accessToken: string, phoneNumberId: string, to: string, text: string, actionId: string, description: string) => Promise<void>;
  /** Mark an inbound message as read (shows double blue ticks). */
  markAsRead:       (accessToken: string, phoneNumberId: string, messageId: string) => Promise<void>;
  /** Send a magic-link email with whatsapp_phone bound in metadata. */
  sendMagicLink:    (email: string, whatsappPhone: string) => Promise<void>;
  /** Fetch, claim, resolve, reject pending actions (same as actions route). */
  fetchAction:      (userId: string, actionId: string) => Promise<PendingActionRow | null>;
  claimAction:      (actionId: string, userId: string) => Promise<boolean>;
  resolveAction:    (actionId: string, result: string, userId: string) => Promise<void>;
  rejectAction:     (actionId: string, errorMsg: string | undefined, userId: string) => Promise<void>;
  /** Per-sender rate limit (phone number). Returns false to silently drop the message. */
  checkRateLimit?:  (phone: string) => Promise<boolean>;
  /** Deduplication check: returns true if msgId was already processed (replay). */
  isDuplicate?:     (msgId: string) => boolean;
}

// ── Signature verification ────────────────────────────────────────────────────

function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  try {
    // timingSafeEqual requires equal-length Buffers — throws on mismatch, which
    // is itself constant-time relative to the length check.
    return timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  } catch {
    return false;
  }
}

// ── In-process replay deduplication cache ────────────────────────────────────
// Stores processed WhatsApp message IDs with their arrival timestamp.
// Entries older than DEDUP_TTL_MS are evicted on each check.
// For multi-process deployments this should be replaced by a Redis-backed dep.

const _processedMsgIds = new Map<string, number>(); // msgId → timestamp (ms)
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function defaultIsDuplicate(msgId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of _processedMsgIds) {
    if (now - ts > DEDUP_TTL_MS) _processedMsgIds.delete(id);
  }
  if (_processedMsgIds.has(msgId)) return true;
  _processedMsgIds.set(msgId, now);
  return false;
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function createWhatsAppWebhookRoutes(deps: WebhookWhatsAppDeps): Hono {
  const webhook = new Hono();

  // ── GET /webhook/whatsapp — Meta webhook verification ─────────────────────

  webhook.get("/whatsapp", (c) => {
    const mode      = c.req.query("hub.mode");
    const token     = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");

    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!verifyToken) return c.text("WHATSAPP_VERIFY_TOKEN not configured", 500);

    // Use timing-safe comparison to prevent token enumeration attacks.
    const verifyBuf = Buffer.from(verifyToken);
    const tokenBuf  = Buffer.from(token ?? "");
    const tokenValid =
      verifyBuf.length > 0 &&
      verifyBuf.length === tokenBuf.length &&
      timingSafeEqual(verifyBuf, tokenBuf);

    if (mode === "subscribe" && tokenValid && challenge) {
      return c.text(challenge, 200);
    }
    return c.text("Forbidden", 403);
  });

  // ── POST /webhook/whatsapp — inbound messages ─────────────────────────────

  webhook.post("/whatsapp", async (c) => {
    const rawBody = await c.req.text();

    // 1. Verify HMAC-SHA256 signature — always return 403 regardless of whether the
    //    secret is missing or wrong, to avoid leaking configuration state to callers.
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    const sig = c.req.header("X-Hub-Signature-256") ?? null;
    if (!appSecret || !verifySignature(rawBody, sig, appSecret)) {
      if (!appSecret) console.error("[webhook] WHATSAPP_APP_SECRET is not set.");
      return c.json({ error: "Forbidden" }, 403);
    }

    let update: WAUpdate;
    try {
      update = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Only handle whatsapp_business_account events
    if (update.object !== "whatsapp_business_account") {
      return c.json({ ok: true });
    }

    // Process each entry / change asynchronously — always return 200 immediately
    // (Telegram retries on non-200; WhatsApp does the same)
    for (const entry of update.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue;
        const value = change.value;
        if (!value.messages?.length) continue; // status updates only — skip

        const accessToken  = process.env.WHATSAPP_ACCESS_TOKEN ?? "";
        const phoneNumberId = value.metadata.phone_number_id;

        for (const msg of value.messages) {
          // Replay deduplication — skip messages already processed in this process
          if (deps.isDuplicate && deps.isDuplicate(msg.id)) continue;

          // Per-sender rate limit — silently drop if exceeded
          if (deps.checkRateLimit) {
            const allowed = await deps.checkRateLimit(msg.from).catch(() => true);
            if (!allowed) continue;
          }

          // Mark as read (best-effort, don't block)
          deps.markAsRead(accessToken, phoneNumberId, msg.id).catch(() => {});

          if (msg.type === "text") {
            handleTextMessage(msg as WATextMsg, phoneNumberId, accessToken, deps).catch((err) =>
              console.error("WhatsApp text handler error:", err.message)
            );
          } else if (msg.type === "interactive") {
            handleInteractiveReply(msg as WAInteractive, phoneNumberId, accessToken, deps).catch((err) =>
              console.error("WhatsApp interactive handler error:", err.message)
            );
          }
        }
      }
    }

    return c.json({ ok: true });
  });

  return webhook;
}

// ── Text message handler ──────────────────────────────────────────────────────

async function handleTextMessage(
  msg: WATextMsg,
  phoneNumberId: string,
  accessToken: string,
  deps: WebhookWhatsAppDeps
) {
  const phone = msg.from;
  const text  = msg.text.body.trim().slice(0, 4096); // cap before sending to LLM

  // Look up linked user
  const userCtx = await deps.findUserByPhone(phone);

  if (!userCtx) {
    await handleUnlinkedUser(phone, text, phoneNumberId, accessToken, deps);
    return;
  }

  const { userId, profile } = userCtx;

  // Build PromptConfig from profile + flags
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

  // Load history (WhatsApp threads keyed by phone)
  const contextId = buildContextId(userId, `wa:${phone}`);
  const history   = await deps.fetchHistory(userId, contextId, profile.max_history);

  // Optional web search
  let searchResults: string | undefined;
  if (profile.web_search && flags.tavilyEnabled && needsWebSearch(text)) {
    try { searchResults = await deps.runWebSearch?.(text, userId); }
    catch (err: any) { console.warn("Web search failed:", err.message); }
  }

  // Memory context
  const [memoryContext, relevantContext] = await Promise.all([
    deps.fetchMemoryContext(userId),
    deps.fetchRelevantContext(userId, text),
  ]);

  // Build prompt + call Groq
  const prompt = buildPrompt(text, promptConfig, { memoryContext, relevantContext, searchResults });

  let rawResponse: string;
  try {
    rawResponse = await deps.groqCall(prompt, {
      history,
      model:  profile.ai_model,
      apiKey: (flags as any).groqApiKey,
    });
  } catch (err: any) {
    console.error("Groq error in WhatsApp handler:", err.message);
    await deps.sendTextMessage(accessToken, phoneNumberId, phone,
      "⚠️ AI service is temporarily unavailable. Please try again shortly."
    );
    return;
  }

  // Parse action intent
  const { clean: reply, action } = parseActionIntent(rawResponse);

  // Store pending action and send HitL buttons if needed
  let action_id: string | undefined;
  if (action) {
    try { action_id = await deps.storePendingAction(userId, action as PendingAction); }
    catch (err: any) { console.error("Failed to store pending action:", err.message); }
  }

  // Fire-and-forget persist
  const meta = { thread_id: `wa:${phone}`, channel: "whatsapp" };
  Promise.all([
    deps.persistMessage(userId, "user", text, meta),
    deps.persistMessage(userId, "assistant", reply, { ...meta, has_action: !!action }),
    deps.persistMemoryIntents(userId, rawResponse),
  ]).catch((err) => console.error("Background persist error:", err.message));

  // Send reply
  if (action_id && action) {
    await deps.sendHitLButtons(
      accessToken, phoneNumberId, phone,
      reply, action_id, (action as PendingAction).description
    );
  } else {
    await deps.sendTextMessage(accessToken, phoneNumberId, phone, reply);
  }
}

// ── Unlinked user flow ────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleUnlinkedUser(
  phone: string,
  text: string,
  phoneNumberId: string,
  accessToken: string,
  deps: WebhookWhatsAppDeps
) {
  if (EMAIL_RE.test(text)) {
    // User provided their email — send a magic link with whatsapp_phone bound
    try {
      await deps.sendMagicLink(text, phone);
      await deps.sendTextMessage(accessToken, phoneNumberId, phone,
        `✉️ Check your email (${text}) for a sign-in link.\n\n` +
        `Click the link to link your WhatsApp to your account. ` +
        `Your next message here will be answered right away.`
      );
    } catch (err: any) {
      console.error("Magic link failed:", err.message);
      await deps.sendTextMessage(accessToken, phoneNumberId, phone,
        "⚠️ Couldn't send a sign-in link. Please check your email address and try again."
      );
    }
  } else {
    // Unknown user — ask for email
    await deps.sendTextMessage(accessToken, phoneNumberId, phone,
      `👋 Welcome! To use this assistant, please reply with your *email address* to link your account.\n\n` +
      `You'll receive a one-click sign-in link by email.`
    );
  }
}

// ── Interactive button reply handler (HitL) ───────────────────────────────────

async function handleInteractiveReply(
  msg: WAInteractive,
  phoneNumberId: string,
  accessToken: string,
  deps: WebhookWhatsAppDeps
) {
  const phone = msg.from;
  const data  = msg.interactive.button_reply.id; // "approve:<uuid>" | "reject:<uuid>"

  const userCtx = await deps.findUserByPhone(phone);
  if (!userCtx) {
    await deps.sendTextMessage(accessToken, phoneNumberId, phone,
      "Session expired. Please link your account first."
    );
    return;
  }

  const { userId } = userCtx;
  const colonIdx = data.indexOf(":");
  const action   = colonIdx === -1 ? data : data.slice(0, colonIdx);
  const actionId = colonIdx === -1 ? "" : data.slice(colonIdx + 1);
  const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!actionId || !UUID_RE.test(actionId) || (action !== "approve" && action !== "reject")) {
    await deps.sendTextMessage(accessToken, phoneNumberId, phone, "Unknown action.");
    return;
  }

  const row = await deps.fetchAction(userId, actionId);
  if (!row) {
    await deps.sendTextMessage(accessToken, phoneNumberId, phone,
      "⏱️ This action has expired or was already handled."
    );
    return;
  }

  if (row.status !== "pending") {
    await deps.sendTextMessage(accessToken, phoneNumberId, phone,
      `Already ${row.status}.`
    );
    return;
  }

  if (new Date(row.expires_at) < new Date()) {
    await deps.sendTextMessage(accessToken, phoneNumberId, phone,
      "⏱️ This action has expired."
    );
    return;
  }

  if (action === "reject") {
    await deps.rejectAction(actionId, undefined, userId);
    await deps.sendTextMessage(accessToken, phoneNumberId, phone,
      `❌ Cancelled: ${row.description}`
    );
    return;
  }

  // Approve — atomically claim (includes ownership check via userId)
  const claimed = await deps.claimAction(actionId, userId);
  if (!claimed) {
    await deps.sendTextMessage(accessToken, phoneNumberId, phone,
      "Already being processed."
    );
    return;
  }

  await deps.sendTextMessage(accessToken, phoneNumberId, phone,
    `⏳ Executing: ${row.description}`
  );

  // Load integration loaders and execute
  const { loadUserIntegrations } = await import("../db/load-integrations.ts");
  const { executeAction } = await import("@relay/core");
  const loaders = await loadUserIntegrations(userId, userCtx.profile.timezone);

  try {
    const result = await executeAction(
      { type: row.action_type as PendingAction["type"], description: row.description, data: row.data },
      {},
      loaders
    );
    await deps.resolveAction(actionId, result, userId);
    await deps.sendTextMessage(accessToken, phoneNumberId, phone, `✅ Done: ${result}`);
  } catch (err: any) {
    console.error("executeAction error:", err.message);
    await deps.rejectAction(actionId, err.message, userId).catch(() => {});
    await deps.sendTextMessage(accessToken, phoneNumberId, phone, `❌ Action failed. Please try again.`);
  }
}

// ── Default WhatsApp API helpers ──────────────────────────────────────────────

async function waPost(
  accessToken: string,
  phoneNumberId: string,
  body: Record<string, unknown>
): Promise<void> {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method:  "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ messaging_product: "whatsapp", ...body }),
    }
  );
  if (!res.ok) console.error("WhatsApp API error:", await res.text());
}

export async function waSendText(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string
): Promise<void> {
  // WhatsApp text messages support basic markdown (*bold*, _italic_)
  await waPost(accessToken, phoneNumberId, { to, type: "text", text: { body: text } });
}

export async function waSendHitL(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string,
  actionId: string,
  description: string
): Promise<void> {
  // Truncate body to 1024 chars (WhatsApp limit); button titles ≤ 20 chars
  const body = `${text}\n\n*${description}*`.slice(0, 1024);
  await waPost(accessToken, phoneNumberId, {
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: [
          { type: "reply", reply: { id: `approve:${actionId}`, title: "✅ Approve" } },
          { type: "reply", reply: { id: `reject:${actionId}`,  title: "❌ Cancel"  } },
        ],
      },
    },
  });
}

export async function waMarkRead(
  accessToken: string,
  phoneNumberId: string,
  messageId: string
): Promise<void> {
  await waPost(accessToken, phoneNumberId, {
    status: "read",
    message_id: messageId,
  });
}

// ── DB helper: find user by WhatsApp phone ────────────────────────────────────

import { getServiceClient } from "../db/client.ts";
import { getAnonClient } from "../db/client.ts";
import type { UserProfile } from "./messages.ts";

export async function findUserByWhatsAppPhone(
  phone: string
): Promise<{ userId: string; profile: UserProfile } | null> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("user_profiles")
    .select("user_id, timezone, display_name, profile_md, ai_model, max_history, web_search")
    .eq("whatsapp_phone", phone)
    .single();

  if (error || !data) return null;
  return {
    userId: data.user_id,
    profile: {
      timezone:     data.timezone,
      display_name: data.display_name ?? undefined,
      profile_md:   data.profile_md   ?? undefined,
      ai_model:     data.ai_model,
      max_history:  data.max_history,
      web_search:   data.web_search,
    },
  };
}

export async function sendMagicLinkForWhatsApp(
  email: string,
  whatsappPhone: string
): Promise<void> {
  const supabase = getAnonClient();
  const baseUrl  = process.env.API_BASE_URL;

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      data: { whatsapp_phone: whatsappPhone },
      emailRedirectTo: baseUrl ? `${baseUrl}/auth/callback` : undefined,
    },
  });

  if (error) throw new Error(`Magic link failed: ${error.message}`);
}

// ── Default deps ──────────────────────────────────────────────────────────────

import { defaultMessageDeps } from "./messages.ts";
import {
  getPendingAction,
  claimPendingAction,
  resolvePendingAction,
  rejectPendingAction,
} from "../db/pending-actions.ts";

export const defaultWhatsAppDeps: WebhookWhatsAppDeps = {
  ...defaultMessageDeps,
  findUserByPhone:  findUserByWhatsAppPhone,
  sendTextMessage:  waSendText,
  sendHitLButtons:  waSendHitL,
  markAsRead:       waMarkRead,
  sendMagicLink:    sendMagicLinkForWhatsApp,
  fetchAction:      getPendingAction,
  claimAction:      (id, userId) => claimPendingAction(id, userId),
  resolveAction:    (id, result, userId) => resolvePendingAction(id, result, userId),
  rejectAction:     (id, msg, userId) => rejectPendingAction(id, msg, userId),
  isDuplicate:      defaultIsDuplicate,
  checkRateLimit:   async (phone) => {
    try {
      const { getRateLimiter } = await import("../services/rate-limiter.ts");
      const result = await getRateLimiter().check(`wh:wa:${phone}`, 20, 60_000);
      return result.allowed;
    } catch {
      return true; // fail open — never block on rate-limiter errors
    }
  },
};

export default createWhatsAppWebhookRoutes(defaultWhatsAppDeps);
