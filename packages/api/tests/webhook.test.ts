import { describe, expect, test, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createWebhookRoutes, type WebhookDeps } from "../src/routes/webhook.ts";
import type { UserProfile, IntegrationFlags } from "../src/routes/messages.ts";
import type { PendingActionRow } from "../src/db/pending-actions.ts";
import type { HistoryMessage } from "@relay/core";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DEFAULT_PROFILE: UserProfile = {
  timezone:     "America/New_York",
  display_name: "Alice",
  profile_md:   "Software engineer.",
  ai_model:     "llama-3.3-70b-versatile",
  max_history:  10,
  web_search:   false,
};

const NO_FLAGS: IntegrationFlags = {
  gmailEnabled:    false,
  calendarEnabled: false,
  notionEnabled:   false,
  vapiEnabled:     false,
  tavilyEnabled:   false,
};

const ACTION_UUID = "11111111-1111-1111-1111-111111111111";
const NO_SUCH_UUID = "00000000-0000-0000-0000-000000000000";

function makeRow(overrides: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    id: ACTION_UUID, user_id: "user-uuid",
    action_type: "note", description: "Save note",
    data: "test note", status: "pending",
    chat_id: 123456, message_id: 10,
    result: null, error: null,
    created_at: "2026-03-09T10:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── App builder ───────────────────────────────────────────────────────────────

const TEST_SECRET = "test-webhook-secret";

// Pass webhookSecret = null to simulate missing env var (triggers 500).
function buildApp(overrides: Partial<WebhookDeps> = {}, webhookSecret: string | null = TEST_SECRET) {
  if (webhookSecret !== null) process.env.TELEGRAM_WEBHOOK_SECRET = webhookSecret;
  else delete process.env.TELEGRAM_WEBHOOK_SECRET;

  const sentMessages: Array<{ chatId: number; text: string }> = [];
  const sentActions: Array<{ chatId: number; text: string; actionId: string }> = [];
  const editedMessages: Array<{ chatId: number; messageId: number; text: string }> = [];
  const answeredCallbacks: Array<{ queryId: string; text?: string }> = [];

  const deps: WebhookDeps = {
    groqCall:             mock(async () => "Hello from AI!"),
    fetchHistory:         mock(async () => [] as HistoryMessage[]),
    persistMessage:       mock(async () => {}),
    fetchMemoryContext:   mock(async () => undefined),
    fetchRelevantContext: mock(async () => undefined),
    persistMemoryIntents: mock(async () => {}),
    storePendingAction:   mock(async () => "action-1"),
    loadUserProfile:      mock(async () => DEFAULT_PROFILE),
    loadIntegrationFlags: mock(async () => NO_FLAGS),
    findUserByTelegramId: mock(async () => ({ userId: "user-uuid", profile: DEFAULT_PROFILE })),
    sendTelegramMessage:  mock(async (_token, chatId, text) => { sentMessages.push({ chatId, text }); }),
    sendTelegramAction:   mock(async (_token, chatId, text, actionId) => { sentActions.push({ chatId, text, actionId }); }),
    answerCallbackQuery:  mock(async (_token, queryId, text) => { answeredCallbacks.push({ queryId, text }); }),
    editTelegramMessage:  mock(async (_token, chatId, messageId, text) => { editedMessages.push({ chatId, messageId, text }); }),
    fetchAction:          mock(async () => makeRow()),
    claimAction:          mock(async () => true),
    resolveAction:        mock(async () => {}) as WebhookDeps["resolveAction"],
    rejectAction:         mock(async () => {}) as WebhookDeps["rejectAction"],
    getBotToken:          mock(async () => "test-bot-token"),
    ...overrides,
  };

  const routes = createWebhookRoutes(deps);
  const app = new Hono();
  app.route("/webhook", routes);

  return { app, deps, sentMessages, sentActions, editedMessages, answeredCallbacks };
}

function post(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/webhook/telegram", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Include the correct secret by default — tests that want to omit or
      // use a wrong value pass it explicitly via the headers override.
      "X-Telegram-Bot-Api-Secret-Token": TEST_SECRET,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ── Webhook secret verification ───────────────────────────────────────────────

describe("webhook secret verification", () => {
  test("returns 403 when secret header is missing", async () => {
    const { app } = buildApp({}, "my-secret");
    const res = await post(app, { update_id: 1, message: { message_id: 1, chat: { id: 123 }, text: "hi" } });
    expect(res.status).toBe(403);
  });

  test("returns 403 when secret header is wrong", async () => {
    const { app } = buildApp({}, "my-secret");
    const res = await post(app,
      { update_id: 1, message: { message_id: 1, chat: { id: 123 }, text: "hi" } },
      { "X-Telegram-Bot-Api-Secret-Token": "wrong-secret" }
    );
    expect(res.status).toBe(403);
  });

  test("allows request with correct secret", async () => {
    const { app } = buildApp({}, "my-secret");
    const res = await post(app,
      { update_id: 1, message: { message_id: 1, chat: { id: 123 }, text: "hi" } },
      { "X-Telegram-Bot-Api-Secret-Token": "my-secret" }
    );
    expect(res.status).toBe(200);
  });

  test("returns 403 when TELEGRAM_WEBHOOK_SECRET is not configured", async () => {
    const { app } = buildApp({}, null);
    const res = await post(app, { update_id: 1, message: { message_id: 1, chat: { id: 123 }, text: "hi" } });
    expect(res.status).toBe(403);
  });
});

// ── Text message handling ─────────────────────────────────────────────────────

describe("text message handling", () => {
  test("sends AI reply back to chat", async () => {
    const { app, sentMessages } = buildApp();
    const res = await post(app, {
      update_id: 1,
      message: { message_id: 1, chat: { id: 999 }, text: "Hello" },
    });
    expect(res.status).toBe(200);
    // Give fire-and-forget a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(sentMessages[0].chatId).toBe(999);
    expect(sentMessages[0].text).toBe("Hello from AI!");
  });

  test("returns 200 and drops message when user not found", async () => {
    const { app, sentMessages } = buildApp({
      findUserByTelegramId: mock(async () => null),
    });
    const res = await post(app, {
      update_id: 1,
      message: { message_id: 1, chat: { id: 999 }, text: "Hello" },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(sentMessages.length).toBe(0);
  });

  test("sends error message when Groq throws", async () => {
    const { app, sentMessages } = buildApp({
      groqCall: mock(async () => { throw new Error("Groq down"); }),
    });
    await post(app, {
      update_id: 1,
      message: { message_id: 1, chat: { id: 999 }, text: "hi" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(sentMessages[0].text).toContain("temporarily unavailable");
  });

  test("sends HitL inline keyboard when action tag detected", async () => {
    const { app, sentActions } = buildApp({
      groqCall: mock(async () =>
        'On it! [ACTION: Save note | TYPE: note | DATA: meeting at 10am]'
      ),
    });
    await post(app, {
      update_id: 1,
      message: { message_id: 1, chat: { id: 999 }, text: "save a note" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(sentActions.length).toBe(1);
    expect(sentActions[0].actionId).toBe("action-1");
    expect(sentActions[0].text).toBe("On it!");
  });

  test("persists messages as fire-and-forget", async () => {
    const persistMessage = mock(async () => {});
    const { app } = buildApp({ persistMessage });
    await post(app, {
      update_id: 1,
      message: { message_id: 1, chat: { id: 999 }, text: "Hello" },
    });
    await new Promise((r) => setTimeout(r, 20));
    // user + assistant messages
    expect(persistMessage).toHaveBeenCalledTimes(2);
  });

  test("responds to /start with welcome message", async () => {
    const { app, sentMessages } = buildApp();
    await post(app, {
      update_id: 1,
      message: { message_id: 1, chat: { id: 999 }, text: "/start" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(sentMessages[0].text).toContain("Welcome back");
  });
});

// ── Callback query handling (HitL) ────────────────────────────────────────────

describe("callback query handling", () => {
  test("rejects action on reject callback", async () => {
    const rejectAction = mock(async () => {});
    const { app, editedMessages } = buildApp({ rejectAction });
    await post(app, {
      update_id: 2,
      callback_query: {
        id: "cq-1",
        from: { id: 123 },
        message: { message_id: 10, chat: { id: 999 } },
        data: `reject:${ACTION_UUID}`,
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(rejectAction).toHaveBeenCalledWith(ACTION_UUID, undefined, "user-uuid");
    expect(editedMessages[0].text).toContain("Cancelled");
  });

  test("returns 404 feedback when action not found", async () => {
    const { app, answeredCallbacks } = buildApp({
      fetchAction: mock(async () => null),
    });
    await post(app, {
      update_id: 2,
      callback_query: {
        id: "cq-1",
        from: { id: 123 },
        message: { message_id: 10, chat: { id: 999 } },
        data: `approve:${NO_SUCH_UUID}`,
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(answeredCallbacks[0].text).toContain("not found");
  });

  test("returns 409 feedback when action already processed", async () => {
    const { app, answeredCallbacks } = buildApp({
      fetchAction: mock(async () => makeRow({ status: "approved" })),
    });
    await post(app, {
      update_id: 2,
      callback_query: {
        id: "cq-1",
        from: { id: 123 },
        message: { message_id: 10, chat: { id: 999 } },
        data: `approve:${ACTION_UUID}`,
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(answeredCallbacks[0].text).toContain("approved");
  });

  test("returns 409 feedback when claim races", async () => {
    const { app, answeredCallbacks } = buildApp({
      claimAction: mock(async () => false),
    });
    await post(app, {
      update_id: 2,
      callback_query: {
        id: "cq-1",
        from: { id: 123 },
        message: { message_id: 10, chat: { id: 999 } },
        data: `approve:${ACTION_UUID}`,
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(answeredCallbacks[0].text).toContain("being processed");
  });
});

// ── Callback data UUID validation ─────────────────────────────────────────────

describe("callback data UUID validation", () => {
  test("ignores callback with non-UUID actionId (injection guard)", async () => {
    const claimAction = mock(async () => true);
    const { app, answeredCallbacks } = buildApp({ claimAction });
    await post(app, {
      update_id: 2,
      callback_query: {
        id: "cq-1",
        from: { id: 123 },
        message: { message_id: 10, chat: { id: 999 } },
        data: "approve:../../etc/passwd",
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(claimAction).not.toHaveBeenCalled();
    expect(answeredCallbacks[0].text).toContain("Unknown action");
  });

  test("ignores callback with SQL-injection-style actionId", async () => {
    const claimAction = mock(async () => true);
    const { app, answeredCallbacks } = buildApp({ claimAction });
    await post(app, {
      update_id: 2,
      callback_query: {
        id: "cq-1",
        from: { id: 123 },
        message: { message_id: 10, chat: { id: 999 } },
        data: "approve:' OR '1'='1",
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(claimAction).not.toHaveBeenCalled();
    expect(answeredCallbacks[0].text).toContain("Unknown action");
  });
});

// ── Per-sender rate limiting (M7) ─────────────────────────────────────────────

describe("per-sender rate limiting", () => {
  test("silently drops message (200 ok, no reply) when rate limit exceeded", async () => {
    const { app, sentMessages } = buildApp({
      checkRateLimit: mock(async () => false),
    } as any);
    const res = await post(app, {
      update_id: 1,
      message: { message_id: 1, chat: { id: 999 }, text: "Hello" },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(sentMessages.length).toBe(0);
  });

  test("allows message when rate limit check returns true", async () => {
    const { app, sentMessages } = buildApp({
      checkRateLimit: mock(async () => true),
    } as any);
    const res = await post(app, {
      update_id: 1,
      message: { message_id: 1, chat: { id: 999 }, text: "Hello" },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(sentMessages.length).toBe(1);
  });
});
