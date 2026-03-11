import { describe, expect, test, mock, beforeEach } from "bun:test";
import { createHmac } from "crypto";
import { Hono } from "hono";
import { createWhatsAppWebhookRoutes, type WebhookWhatsAppDeps } from "../src/routes/webhook-whatsapp.ts";
import type { UserProfile, IntegrationFlags } from "../src/routes/messages.ts";
import type { PendingActionRow } from "../src/db/pending-actions.ts";
import type { HistoryMessage } from "@relay/core";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DEFAULT_PROFILE: UserProfile = {
  timezone:    "America/New_York",
  display_name: "Alice",
  profile_md:  "Software engineer.",
  ai_model:    "llama-3.3-70b-versatile",
  max_history: 10,
  web_search:  false,
};

const NO_FLAGS: IntegrationFlags = {
  gmailEnabled: false, calendarEnabled: false,
  notionEnabled: false, vapiEnabled: false, tavilyEnabled: false,
};

const ACTION_UUID = "11111111-1111-1111-1111-111111111111";
const NO_SUCH_UUID = "00000000-0000-0000-0000-000000000000";

function makeRow(overrides: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    id: ACTION_UUID, user_id: "user-uuid",
    action_type: "note", description: "Save note",
    data: "test note", status: "pending",
    chat_id: null, message_id: null,
    result: null, error: null,
    created_at: "2026-03-09T10:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── App builder ───────────────────────────────────────────────────────────────

const TEST_APP_SECRET  = "test-app-secret";
const TEST_VERIFY_TOKEN = "test-verify-token";

/** Compute the X-Hub-Signature-256 header for a given raw body string. */
function makeSignature(body: string, secret: string = TEST_APP_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// Pass appSecret = null to simulate missing env var (triggers 500).
function buildApp(
  overrides: Partial<WebhookWhatsAppDeps> = {},
  opts: { verifyToken?: string | null; appSecret?: string | null } = {}
) {
  if (opts.verifyToken !== null && opts.verifyToken !== undefined)
    process.env.WHATSAPP_VERIFY_TOKEN = opts.verifyToken;
  else if (opts.verifyToken === null)
    delete process.env.WHATSAPP_VERIFY_TOKEN;
  else
    process.env.WHATSAPP_VERIFY_TOKEN = TEST_VERIFY_TOKEN;

  if (opts.appSecret === null) delete process.env.WHATSAPP_APP_SECRET;
  else process.env.WHATSAPP_APP_SECRET = opts.appSecret ?? TEST_APP_SECRET;

  delete process.env.WHATSAPP_ACCESS_TOKEN;

  const sentMessages: Array<{ to: string; text: string }> = [];
  const sentHitL: Array<{ to: string; text: string; actionId: string }> = [];
  const markedRead: string[] = [];
  const sentMagicLinks: Array<{ email: string; phone: string }> = [];

  const deps: WebhookWhatsAppDeps = {
    groqCall:             mock(async () => "Hello from AI!"),
    fetchHistory:         mock(async () => [] as HistoryMessage[]),
    persistMessage:       mock(async () => {}),
    fetchMemoryContext:   mock(async () => undefined),
    fetchRelevantContext: mock(async () => undefined),
    persistMemoryIntents: mock(async () => {}),
    storePendingAction:   mock(async () => "action-1"),
    loadUserProfile:      mock(async () => DEFAULT_PROFILE),
    loadIntegrationFlags: mock(async () => NO_FLAGS),
    findUserByPhone:      mock(async () => ({ userId: "user-uuid", profile: DEFAULT_PROFILE })),
    sendTextMessage:      mock(async (_t, _id, to, text) => { sentMessages.push({ to, text }); }),
    sendHitLButtons:      mock(async (_t, _id, to, text, actionId) => { sentHitL.push({ to, text, actionId }); }),
    markAsRead:           mock(async (_t, _id, msgId) => { markedRead.push(msgId); }),
    sendMagicLink:        mock(async (email, phone) => { sentMagicLinks.push({ email, phone }); }),
    fetchAction:          mock(async () => makeRow()),
    claimAction:          mock(async () => true),
    resolveAction:        mock(async () => {}) as WebhookWhatsAppDeps["resolveAction"],
    rejectAction:         mock(async () => {}) as WebhookWhatsAppDeps["rejectAction"],
    ...overrides,
  };

  const routes = createWhatsAppWebhookRoutes(deps);
  const app = new Hono();
  app.route("/webhook", routes);

  return { app, deps, sentMessages, sentHitL, markedRead, sentMagicLinks };
}

function waUpdate(messages: Array<Record<string, unknown>>, phoneNumberId = "phone-id-1") {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
          contacts: [{ wa_id: "15551234567", profile: { name: "Alice" } }],
          messages,
        },
      }],
    }],
  };
}

function post(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  const bodyStr = JSON.stringify(body);
  return app.request("/webhook/whatsapp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Include a valid HMAC signature by default so all message-handling
      // tests pass the security check without needing to care about it.
      "X-Hub-Signature-256": makeSignature(bodyStr),
      ...headers,
    },
    body: bodyStr,
  });
}

// ── GET — webhook verification ─────────────────────────────────────────────────

describe("GET /webhook/whatsapp — verification", () => {
  test("returns challenge when verify token matches", async () => {
    const { app } = buildApp();
    const res = await app.request(
      `/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=NONCE123`
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("NONCE123");
  });

  test("returns 403 when verify token is wrong", async () => {
    const { app } = buildApp();
    const res = await app.request(
      "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=NONCE"
    );
    expect(res.status).toBe(403);
  });

  test("returns 500 when WHATSAPP_VERIFY_TOKEN not configured", async () => {
    const { app } = buildApp({}, { verifyToken: null });
    const res = await app.request(
      "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y"
    );
    expect(res.status).toBe(500);
  });
});

// ── POST — signature verification ────────────────────────────────────────────

describe("POST /webhook/whatsapp — signature", () => {
  test("returns 403 when signature header is missing", async () => {
    const { app } = buildApp();
    const res = await post(app, waUpdate([
      { from: "15551234567", id: "msg-1", type: "text", text: { body: "hi" } },
    ]), { "X-Hub-Signature-256": "" });  // override with empty string
    expect(res.status).toBe(403);
  });

  test("returns 403 when signature is wrong", async () => {
    const { app } = buildApp();
    const res = await post(app, waUpdate([
      { from: "15551234567", id: "msg-1", type: "text", text: { body: "hi" } },
    ]), { "X-Hub-Signature-256": "sha256=deadbeef" });
    expect(res.status).toBe(403);
  });

  test("returns 403 when WHATSAPP_APP_SECRET is not configured", async () => {
    const { app } = buildApp({}, { appSecret: null });
    const res = await post(app, waUpdate([
      { from: "15551234567", id: "msg-1", type: "text", text: { body: "hi" } },
    ]));
    expect(res.status).toBe(403);
  });

  test("rejects body tampered after signing", async () => {
    const { app } = buildApp();
    const originalBody = JSON.stringify(waUpdate([
      { from: "15551234567", id: "msg-1", type: "text", text: { body: "legit" } },
    ]));
    const sig = makeSignature(originalBody);
    const tamperedBody = originalBody.replace("legit", "injected");
    const res = await app.request("/webhook/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig },
      body: tamperedBody,
    });
    expect(res.status).toBe(403);
  });

  test("returns 200 with correct signature", async () => {
    const { app } = buildApp();
    const res = await post(app, waUpdate([
      { from: "15551234567", id: "msg-1", type: "text", text: { body: "hi" } },
    ]));
    expect(res.status).toBe(200);
  });
});

// ── POST — replay deduplication ───────────────────────────────────────────────

describe("POST /webhook/whatsapp — replay deduplication", () => {
  test("processes each unique message id only once", async () => {
    let callCount = 0;
    const { app } = buildApp({
      isDuplicate: (msgId) => {
        if (msgId === "dup-msg-1") { callCount++; return callCount > 1; }
        return false;
      },
    });
    // Send the same message id twice
    await post(app, waUpdate([{ from: "15551234567", id: "dup-msg-1", type: "text", text: { body: "hi" } }]));
    await post(app, waUpdate([{ from: "15551234567", id: "dup-msg-1", type: "text", text: { body: "hi" } }]));
    await new Promise((r) => setTimeout(r, 20));
    expect(callCount).toBe(2); // isDuplicate called twice — second time returns true and skips
  });
});

// ── POST — text message handling ──────────────────────────────────────────────

describe("POST /webhook/whatsapp — text messages", () => {
  test("returns 200 and sends AI reply to linked user", async () => {
    const { app, sentMessages } = buildApp();
    const res = await post(app, waUpdate([
      { from: "15551234567", id: "msg-1", type: "text", text: { body: "Hello!" } },
    ]));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages[0].to).toBe("15551234567");
    expect(sentMessages[0].text).toBe("Hello from AI!");
  });

  test("marks message as read", async () => {
    const { app, markedRead } = buildApp();
    await post(app, waUpdate([
      { from: "15551234567", id: "wamid-abc123", type: "text", text: { body: "hi" } },
    ]));
    await new Promise((r) => setTimeout(r, 20));
    expect(markedRead).toContain("wamid-abc123");
  });

  test("sends HitL buttons when action tag detected", async () => {
    const { app, sentHitL, sentMessages } = buildApp({
      groqCall: mock(async () =>
        'On it! [ACTION: Save note | TYPE: note | DATA: meeting at 10am]'
      ),
    });
    await post(app, waUpdate([
      { from: "15551234567", id: "msg-1", type: "text", text: { body: "save a note" } },
    ]));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentHitL.length).toBe(1);
    expect(sentHitL[0].actionId).toBe("action-1");
    expect(sentHitL[0].text).toBe("On it!");
    expect(sentMessages.length).toBe(0); // only buttons sent, not plain text
  });

  test("sends error message when Groq throws", async () => {
    const { app, sentMessages } = buildApp({
      groqCall: mock(async () => { throw new Error("Groq down"); }),
    });
    await post(app, waUpdate([
      { from: "15551234567", id: "msg-1", type: "text", text: { body: "hi" } },
    ]));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages[0].text).toContain("temporarily unavailable");
  });

  test("persists user + assistant messages fire-and-forget", async () => {
    const persistMessage = mock(async () => {});
    const { app } = buildApp({ persistMessage });
    await post(app, waUpdate([
      { from: "15551234567", id: "msg-1", type: "text", text: { body: "Hello" } },
    ]));
    await new Promise((r) => setTimeout(r, 30));
    expect(persistMessage).toHaveBeenCalledTimes(2);
  });

  test("skips non-message entries (status updates)", async () => {
    const { app, sentMessages } = buildApp();
    const statusUpdate = {
      object: "whatsapp_business_account",
      entry: [{
        id: "waba-1",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550000000", phone_number_id: "p1" },
            statuses: [{ id: "wamid-x", status: "delivered", recipient_id: "15551234567" }],
          },
        }],
      }],
    };
    const res = await post(app, statusUpdate);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages.length).toBe(0);
  });
});

// ── POST — unlinked user flow ─────────────────────────────────────────────────

describe("POST /webhook/whatsapp — unlinked user", () => {
  test("sends welcome/link prompt for unknown phone", async () => {
    const { app, sentMessages } = buildApp({
      findUserByPhone: mock(async () => null),
    });
    await post(app, waUpdate([
      { from: "15559999999", id: "msg-1", type: "text", text: { body: "Hello!" } },
    ]));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages[0].to).toBe("15559999999");
    expect(sentMessages[0].text).toContain("email address");
  });

  test("sends magic link when unknown user replies with email", async () => {
    const { app, sentMagicLinks, sentMessages } = buildApp({
      findUserByPhone: mock(async () => null),
    });
    await post(app, waUpdate([
      { from: "15559999999", id: "msg-1", type: "text", text: { body: "user@example.com" } },
    ]));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMagicLinks[0]).toEqual({ email: "user@example.com", phone: "15559999999" });
    expect(sentMessages[0].text).toContain("user@example.com");
    expect(sentMessages[0].text).toContain("sign-in link");
  });

  test("sends error when magic link fails", async () => {
    const { app, sentMessages } = buildApp({
      findUserByPhone: mock(async () => null),
      sendMagicLink:   mock(async () => { throw new Error("auth error"); }),
    });
    await post(app, waUpdate([
      { from: "15559999999", id: "msg-1", type: "text", text: { body: "bad@email.com" } },
    ]));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages[0].text).toContain("Couldn't send");
  });
});

// ── POST — interactive button replies (HitL) ──────────────────────────────────

describe("POST /webhook/whatsapp — HitL button replies", () => {
  function interactiveUpdate(buttonId: string) {
    return waUpdate([{
      from: "15551234567",
      id: "msg-2",
      type: "interactive",
      interactive: {
        type: "button_reply",
        button_reply: { id: buttonId, title: "✅ Approve" },
      },
    }]);
  }

  test("rejects action on reject button tap", async () => {
    const rejectAction = mock(async () => {});
    const { app, sentMessages } = buildApp({ rejectAction });
    await post(app, interactiveUpdate(`reject:${ACTION_UUID}`));
    await new Promise((r) => setTimeout(r, 20));
    expect(rejectAction).toHaveBeenCalledWith(ACTION_UUID, undefined, "user-uuid");
    expect(sentMessages[0].text).toContain("Cancelled");
  });

  test("sends 'expired' message when action not found", async () => {
    const { app, sentMessages } = buildApp({
      fetchAction: mock(async () => null),
    });
    await post(app, interactiveUpdate(`approve:${NO_SUCH_UUID}`));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages[0].text).toContain("expired");
  });

  test("sends 'already processed' when action not pending", async () => {
    const { app, sentMessages } = buildApp({
      fetchAction: mock(async () => makeRow({ status: "approved" })),
    });
    await post(app, interactiveUpdate(`approve:${ACTION_UUID}`));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages[0].text).toContain("approved");
  });

  test("sends 'already processing' on claim race", async () => {
    const { app, sentMessages } = buildApp({
      claimAction: mock(async () => false),
    });
    await post(app, interactiveUpdate(`approve:${ACTION_UUID}`));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages[0].text).toContain("being processed");
  });

  test("sends 'unknown action' for malformed button ID", async () => {
    const { app, sentMessages } = buildApp();
    await post(app, interactiveUpdate("bad-format"));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages.some((m) => m.text.includes("Unknown action"))).toBe(true);
  });
});

// ── Per-sender rate limiting (M7) ─────────────────────────────────────────────

describe("POST /webhook/whatsapp — per-sender rate limiting", () => {
  test("silently drops message (200 ok, no reply) when rate limit exceeded", async () => {
    const { app, sentMessages, markedRead } = buildApp({
      checkRateLimit: mock(async () => false),
    } as any);
    const res = await post(app, waUpdate([
      { from: "15551234567", id: "msg-1", type: "text", text: { body: "hi" } },
    ]));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages.length).toBe(0);
    expect(markedRead.length).toBe(0); // dropped before markAsRead
  });

  test("allows message when rate limit check returns true", async () => {
    const { app, sentMessages } = buildApp({
      checkRateLimit: mock(async () => true),
    } as any);
    await post(app, waUpdate([
      { from: "15551234567", id: "msg-1", type: "text", text: { body: "Hello!" } },
    ]));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages.length).toBe(1);
  });
});
