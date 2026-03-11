import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";
import { updateSchema } from "../src/routes/users.ts";

// ── Mock DB builder ───────────────────────────────────────────────────────────

type Profile = {
  user_id: string;
  display_name?: string;
  timezone: string;
  profile_md?: string;
  voice_mode: boolean;
  web_search: boolean;
  ai_model: string;
  max_history: number;
  agent_topics: Record<string, string>;
  plan: string;
};

function makeDb(profile: Partial<Profile> = {}) {
  const stored: Profile = {
    user_id: "user-uuid",
    timezone: "America/New_York",
    voice_mode: false,
    web_search: true,
    ai_model: "llama-3.3-70b-versatile",
    max_history: 10,
    agent_topics: {},
    plan: "free",
    ...profile,
  };

  return {
    from: (table: string) => ({
      select: (cols?: string) => ({
        eq: (_col: string, _val: string) => ({
          single: async () => ({ data: { ...stored }, error: null }),
        }),
      }),
      update: (updates: Partial<Profile>) => {
        Object.assign(stored, updates);
        return {
          eq: (_col: string, _val: string) => ({
            select: () => ({
              single: async () => ({ data: { ...stored }, error: null }),
            }),
          }),
        };
      },
    }),
    _stored: stored,
  };
}

// ── App builder ───────────────────────────────────────────────────────────────

function buildApp(dbOverride?: ReturnType<typeof makeDb>) {
  const db = dbOverride ?? makeDb();
  const app = new Hono();

  // Inject userId via fake auth
  app.use("*", async (c, next) => {
    c.set("userId", "user-uuid");
    await next();
  });

  // GET /me
  app.get("/me", async (c) => {
    const { data, error } = await db.from("user_profiles").select("*").eq("user_id", c.get("userId")).single();
    if (error || !data) return c.json({ error: "Profile not found." }, 404);
    return c.json(data);
  });

  // PATCH /me
  app.patch("/me", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid body." }, 400);
    const allowed = ["display_name","timezone","profile_md","voice_mode","web_search","ai_model","max_history"];
    const updates: Partial<Profile> = {};
    for (const k of allowed) if (k in body) (updates as any)[k] = body[k];
    const { data, error } = await db.from("user_profiles").update(updates).eq("user_id", c.get("userId")).select().single();
    if (error) return c.json({ error: "Failed to update profile." }, 500);
    return c.json(data);
  });

  // GET /me/agents
  app.get("/me/agents", async (c) => {
    const { data, error } = await db.from("user_profiles").select("agent_topics").eq("user_id", c.get("userId")).single();
    if (error || !data) return c.json({ error: "Profile not found." }, 404);
    return c.json(data.agent_topics ?? {});
  });

  // PATCH /me/agents
  app.patch("/me/agents", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.thread_id) return c.json({ error: "Missing thread_id." }, 400);
    const { data: current } = await db.from("user_profiles").select("agent_topics").eq("user_id", c.get("userId")).single();
    const topics: Record<string, string | null> = { ...current.agent_topics };
    if (body.agent_key === null) delete topics[body.thread_id];
    else topics[body.thread_id] = body.agent_key;
    const { data } = await db.from("user_profiles").update({ agent_topics: topics }).eq("user_id", c.get("userId")).select("agent_topics").single();
    return c.json(data.agent_topics);
  });

  return { app, db };
}

// ── updateSchema validation (M1 — timezone + ai_model guards) ────────────────

describe("updateSchema — timezone validation", () => {
  test("accepts a valid IANA timezone", () => {
    expect(updateSchema.safeParse({ timezone: "America/New_York" }).success).toBe(true);
    expect(updateSchema.safeParse({ timezone: "Europe/Berlin" }).success).toBe(true);
    expect(updateSchema.safeParse({ timezone: "Asia/Tokyo" }).success).toBe(true);
    expect(updateSchema.safeParse({ timezone: "UTC" }).success).toBe(true);
  });

  test("rejects an invalid timezone string", () => {
    expect(updateSchema.safeParse({ timezone: "Not/A/Zone" }).success).toBe(false);
    expect(updateSchema.safeParse({ timezone: "garbage" }).success).toBe(false);
    expect(updateSchema.safeParse({ timezone: "America" }).success).toBe(false);
  });

  test("allows timezone to be omitted", () => {
    expect(updateSchema.safeParse({}).success).toBe(true);
  });
});

describe("updateSchema — ai_model validation", () => {
  test("accepts valid model identifiers", () => {
    expect(updateSchema.safeParse({ ai_model: "llama-3.3-70b-versatile" }).success).toBe(true);
    expect(updateSchema.safeParse({ ai_model: "mixtral-8x7b-32768" }).success).toBe(true);
    expect(updateSchema.safeParse({ ai_model: "gemma2-9b-it" }).success).toBe(true);
    expect(updateSchema.safeParse({ ai_model: "claude-3-5-sonnet-20241022" }).success).toBe(true);
  });

  test("rejects model identifiers with spaces or special characters", () => {
    expect(updateSchema.safeParse({ ai_model: "bad model name" }).success).toBe(false);
    expect(updateSchema.safeParse({ ai_model: "model; DROP TABLE" }).success).toBe(false);
    expect(updateSchema.safeParse({ ai_model: "<script>" }).success).toBe(false);
  });

  test("allows ai_model to be omitted", () => {
    expect(updateSchema.safeParse({}).success).toBe(true);
  });
});

// ── GET /me ───────────────────────────────────────────────────────────────────

describe("GET /me", () => {
  test("returns the user profile", async () => {
    const { app } = buildApp(makeDb({ display_name: "Alice", timezone: "Europe/Berlin" }));
    const res = await app.request("/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe("user-uuid");
    expect(body.display_name).toBe("Alice");
    expect(body.timezone).toBe("Europe/Berlin");
  });
});

// ── PATCH /me ─────────────────────────────────────────────────────────────────

describe("PATCH /me", () => {
  test("updates timezone", async () => {
    const { app } = buildApp();
    const res = await app.request("/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "Asia/Tokyo" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.timezone).toBe("Asia/Tokyo");
  });

  test("updates multiple fields at once", async () => {
    const { app } = buildApp();
    const res = await app.request("/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: "Bob", voice_mode: true, max_history: 20 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.display_name).toBe("Bob");
    expect(body.voice_mode).toBe(true);
    expect(body.max_history).toBe(20);
  });

  test("persists changes across subsequent GET", async () => {
    const { app } = buildApp();
    await app.request("/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "Pacific/Auckland" }),
    });
    const res = await app.request("/me");
    const body = await res.json();
    expect(body.timezone).toBe("Pacific/Auckland");
  });
});

// ── GET /me/agents ────────────────────────────────────────────────────────────

describe("GET /me/agents", () => {
  test("returns empty object when no agents registered", async () => {
    const { app } = buildApp();
    const res = await app.request("/me/agents");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test("returns existing agent topic map", async () => {
    const { app } = buildApp(
      makeDb({ agent_topics: { "111": "research", "222": "finance" } })
    );
    const res = await app.request("/me/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body["111"]).toBe("research");
    expect(body["222"]).toBe("finance");
  });
});

// ── PATCH /me/agents ──────────────────────────────────────────────────────────

describe("PATCH /me/agents", () => {
  test("registers a new agent topic", async () => {
    const { app } = buildApp();
    const res = await app.request("/me/agents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: "123", agent_key: "research" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body["123"]).toBe("research");
  });

  test("unregisters an agent topic when agent_key is null", async () => {
    const { app } = buildApp(makeDb({ agent_topics: { "123": "research" } }));
    const res = await app.request("/me/agents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: "123", agent_key: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body["123"]).toBeUndefined();
  });

  test("preserves other topics when registering a new one", async () => {
    const { app } = buildApp(makeDb({ agent_topics: { "111": "finance" } }));
    const res = await app.request("/me/agents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: "222", agent_key: "strategy" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body["111"]).toBe("finance");
    expect(body["222"]).toBe("strategy");
  });

  test("returns 400 when thread_id is missing", async () => {
    const { app } = buildApp();
    const res = await app.request("/me/agents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_key: "research" }),
    });
    expect(res.status).toBe(400);
  });
});
