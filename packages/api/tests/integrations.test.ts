import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createIntegrationRoutes,
  type IntegrationValidators,
} from "../src/routes/integrations.ts";
import { generateKey } from "../src/services/encrypt.ts";

// ── Test setup ────────────────────────────────────────────────────────────────

// Encryption key required by upsertIntegration → encryptJson
process.env.ENCRYPTION_KEY = generateKey();
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.API_BASE_URL = "https://myapp.com";

// ── Shared mock validators ────────────────────────────────────────────────────

const validValidators: IntegrationValidators = {
  validateGoogle: async (_code, _redirectUri) => ({
    secrets: {
      access_token: "ya29.access",
      refresh_token: "1//refresh",
      expiry_date: Date.now() + 3600 * 1000,
      client_id: "test-client-id",
      client_secret: "test-secret",
    },
    meta: { email: "alice@gmail.com", scope: ["gmail.send", "calendar.events"] },
  }),
  validateNotion: async (_token) => ({
    meta: { workspace_name: "Acme", bot_id: "bot-uuid" },
  }),
  validateVapi: async () => true,
  validateElevenLabs: async () => true,
  validateTavily: async () => true,
  validateGroq: async () => true,
};

const invalidValidators: IntegrationValidators = {
  validateGoogle: async () => { throw new Error("invalid_grant"); },
  validateNotion: async () => { throw new Error("Invalid Notion integration token."); },
  validateVapi: async () => false,
  validateElevenLabs: async () => false,
  validateTavily: async () => false,
  validateGroq: async () => false,
};

// ── Stored integrations (in-memory, per test) ─────────────────────────────────

type StoredRow = {
  provider: string;
  enabled: boolean;
  meta: Record<string, unknown>;
  secrets_enc: string;
};

function makeApp(validators = validValidators) {
  const store = new Map<string, StoredRow>();

  // Patch DB helpers with in-memory implementations
  const routes = createIntegrationRoutes(validators, {
    list: async (userId) =>
      [...store.values()]
        .filter((r) => r.provider)
        .map(({ secrets_enc: _omit, ...r }) => ({ ...r, id: "id", user_id: userId, created_at: "", updated_at: "" })),
    get: async (_userId, provider) => {
      const r = store.get(provider);
      return r ? { ...r, id: "id", user_id: _userId, created_at: "", updated_at: "" } : null;
    },
    upsert: async (userId, provider, _secrets, meta) => {
      const row = { provider, enabled: true, meta: meta ?? {}, secrets_enc: "enc" };
      store.set(provider, row);
      return { ...row, id: "id", user_id: userId, created_at: "", updated_at: "" };
    },
    delete: async (_userId, provider) => { store.delete(provider); },
  });

  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "user-uuid"); await next(); });
  app.route("/api/integrations", routes);
  return { app, store };
}

// ── GET /api/integrations ─────────────────────────────────────────────────────

describe("GET /api/integrations", () => {
  test("returns empty array when no integrations", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/integrations");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns connected integrations after connect", async () => {
    const { app } = makeApp();
    await app.request("/api/integrations/groq/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "gsk_test" }),
    });
    const res = await app.request("/api/integrations");
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].provider).toBe("groq");
    // secrets must never be returned
    expect(body[0].secrets_enc).toBeUndefined();
  });
});

// ── GET /api/integrations/:provider/status ────────────────────────────────────

describe("GET /api/integrations/:provider/status", () => {
  test("returns connected: false for unregistered provider", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/integrations/google/status");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.connected).toBe(false);
    expect(body.enabled).toBe(false);
  });

  test("returns connected: true after connect", async () => {
    const { app } = makeApp();
    await app.request("/api/integrations/tavily/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "tvly-test" }),
    });
    const res = await app.request("/api/integrations/tavily/status");
    const body = await res.json() as any;
    expect(body.connected).toBe(true);
    expect(body.enabled).toBe(true);
  });
});

// ── GET /api/integrations/google/auth-url ────────────────────────────────────

describe("GET /api/integrations/google/auth-url", () => {
  test("returns a Google OAuth URL", async () => {
    const { app } = makeApp();
    const res = await app.request(
      "/api/integrations/google/auth-url?redirect_uri=https://myapp.com/callback"
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.url).toContain("accounts.google.com");
    expect(body.url).toContain("test-client-id");
    expect(body.url).toContain("myapp.com");
  });

  test("returns 400 when redirect_uri is missing", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/integrations/google/auth-url");
    expect(res.status).toBe(400);
  });

  test("returns 400 when redirect_uri points to an external domain (H4 open-redirect prevention)", async () => {
    const { app } = makeApp();
    const res = await app.request(
      "/api/integrations/google/auth-url?redirect_uri=https://evil.com/steal"
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("not allowed");
  });

  test("returns 400 for subdomain-prefix bypass (https://myapp.com.evil.com)", async () => {
    const { app } = makeApp();
    const res = await app.request(
      "/api/integrations/google/auth-url?redirect_uri=https://myapp.com.evil.com/steal"
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("not allowed");
  });
});

// ── POST /api/integrations/google/connect ────────────────────────────────────

describe("POST /api/integrations/google/connect", () => {
  // redirect_uri must originate from API_BASE_URL (https://myapp.com) — same check as /auth-url
  test("connects Google and returns meta with email", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/integrations/google/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "4/auth-code", redirect_uri: "https://myapp.com/callback" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.provider).toBe("google");
    expect(body.meta.email).toBe("alice@gmail.com");
    expect(body.meta.scope).toContain("gmail.send");
  });

  test("returns 422 when code is invalid", async () => {
    const { app } = makeApp(invalidValidators);
    const res = await app.request("/api/integrations/google/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "bad", redirect_uri: "https://myapp.com/callback" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toContain("invalid_grant");
  });

  test("returns 400 when redirect_uri is not a valid URL", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/integrations/google/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "code", redirect_uri: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 when redirect_uri origin does not match API_BASE_URL (C2 open-redirect prevention)", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/integrations/google/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "4/auth-code", redirect_uri: "https://attacker.com/steal" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("not allowed");
  });
});

// ── POST /api/integrations/notion/connect ────────────────────────────────────

describe("POST /api/integrations/notion/connect", () => {
  test("connects Notion and returns workspace meta", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/integrations/notion/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "secret_abc",
        databases: { tasks: { id: "db1", description: "Task tracker" } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.provider).toBe("notion");
    expect(body.meta.workspace_name).toBe("Acme");
    expect(body.meta.database_count).toBe(1);
  });

  test("returns 422 for invalid Notion token", async () => {
    const { app } = makeApp(invalidValidators);
    const res = await app.request("/api/integrations/notion/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bad-token" }),
    });
    expect(res.status).toBe(422);
  });
});

// ── POST /api/integrations/vapi/connect ──────────────────────────────────────

describe("POST /api/integrations/vapi/connect", () => {
  test("connects VAPI with valid credentials", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/integrations/vapi/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: "vapi-key",
        phone_number_id: "ph-uuid",
        destination_phone: "+14155551234",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.provider).toBe("vapi");
  });

  test("returns 422 for invalid VAPI credentials", async () => {
    const { app } = makeApp(invalidValidators);
    const res = await app.request("/api/integrations/vapi/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: "bad",
        phone_number_id: "bad",
        destination_phone: "+10000000000",
      }),
    });
    expect(res.status).toBe(422);
  });
});

// ── POST /api/integrations/:provider/connect (generic) ───────────────────────

describe("POST /api/integrations/:provider/connect (generic)", () => {
  test.each(["elevenlabs", "tavily", "groq"] as const)(
    "connects %s with valid api_key",
    async (provider) => {
      const { app } = makeApp();
      const res = await app.request(`/api/integrations/${provider}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: "test-key" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.provider).toBe(provider);
    }
  );

  test.each(["elevenlabs", "tavily", "groq"] as const)(
    "returns 422 for invalid %s api_key",
    async (provider) => {
      const { app } = makeApp(invalidValidators);
      const res = await app.request(`/api/integrations/${provider}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: "bad" }),
      });
      expect(res.status).toBe(422);
    }
  );

  test("returns 400 for unknown provider", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/integrations/unknown-provider/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "key" }),
    });
    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/integrations/:provider ───────────────────────────────────────

describe("DELETE /api/integrations/:provider", () => {
  test("disconnects a provider", async () => {
    const { app, store } = makeApp();
    // Connect first
    await app.request("/api/integrations/groq/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "gsk_test" }),
    });
    expect(store.has("groq")).toBe(true);

    // Disconnect
    const res = await app.request("/api/integrations/groq", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.connected).toBe(false);
    expect(store.has("groq")).toBe(false);
  });

  test("succeeds even if provider was not connected", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/integrations/groq", { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});
