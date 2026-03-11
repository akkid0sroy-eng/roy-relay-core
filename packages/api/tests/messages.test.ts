import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";
import { createMessageRoutes, type MessageDeps, type UserProfile, type IntegrationFlags } from "../src/routes/messages.ts";
import type { HistoryMessage, PendingAction } from "@relay/core";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DEFAULT_PROFILE: UserProfile = {
  timezone: "America/New_York",
  display_name: "Alice",
  profile_md: "Software engineer.",
  ai_model: "llama-3.3-70b-versatile",
  max_history: 10,
  web_search: true,
};

const NO_INTEGRATIONS: IntegrationFlags = {
  gmailEnabled: false,
  calendarEnabled: false,
  notionEnabled: false,
  vapiEnabled: false,
  tavilyEnabled: false,
};

// ── App builder ───────────────────────────────────────────────────────────────

function buildApp(overrides: Partial<MessageDeps> = {}, profile: UserProfile | null = DEFAULT_PROFILE) {
  const savedMessages: Array<{ userId: string; role: string; content: string }> = [];
  const savedActions: Array<{ userId: string; action: PendingAction }> = [];
  let actionIdCounter = 1;

  const deps: MessageDeps = {
    groqCall:             mock(async () => "Hello, how can I help you?"),
    fetchHistory:         mock(async () => [] as HistoryMessage[]),
    persistMessage:       mock(async (userId, role, content) => { savedMessages.push({ userId, role, content }); }),
    fetchMemoryContext:   mock(async () => undefined),
    fetchRelevantContext: mock(async () => undefined),
    persistMemoryIntents: mock(async () => {}),
    storePendingAction:   mock(async (userId, action) => {
      savedActions.push({ userId, action });
      return `action-${actionIdCounter++}`;
    }),
    loadUserProfile:      mock(async () => profile),
    loadIntegrationFlags: mock(async () => NO_INTEGRATIONS),
    ...overrides,
  };

  const routes = createMessageRoutes(deps);
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "user-uuid"); await next(); });
  app.route("/api/messages", routes);

  return { app, deps, savedMessages, savedActions };
}

// ── POST /api/messages — happy path ──────────────────────────────────────────

describe("POST /api/messages — basic", () => {
  test("returns reply from Groq", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.reply).toBe("Hello, how can I help you?");
    expect(body.action_id).toBeUndefined();
  });

  test("passes conversation history to Groq", async () => {
    const history: HistoryMessage[] = [
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It is noon." },
    ];
    const groqCall = mock(async (_prompt: string, opts: any) => {
      expect(opts.history).toEqual(history);
      return "Understood.";
    });
    const { app } = buildApp({
      fetchHistory: mock(async () => history),
      groqCall,
    });
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "And now?" }),
    });
    expect(res.status).toBe(200);
  });

  test("passes user's ai_model to Groq", async () => {
    const groqCall = mock(async (_prompt: string, opts: any) => {
      expect(opts.model).toBe("llama-3.1-8b-instant");
      return "OK";
    });
    const { app } = buildApp(
      { groqCall },
      { ...DEFAULT_PROFILE, ai_model: "llama-3.1-8b-instant" }
    );
    await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(groqCall).toHaveBeenCalledTimes(1);
  });

  test("returns 404 when user profile not found", async () => {
    const { app } = buildApp({}, null);
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 for empty content", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 503 when Groq throws", async () => {
    const { app } = buildApp({
      groqCall: mock(async () => { throw new Error("connection refused"); }),
    });
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(res.status).toBe(503);
  });
});

// ── Action detection ──────────────────────────────────────────────────────────

describe("POST /api/messages — action detection", () => {
  test("returns action_id when Groq response contains an action tag", async () => {
    const { app, savedActions } = buildApp({
      groqCall: mock(async () =>
        'Sure! [ACTION: Save workout note | TYPE: note | DATA: ran 5km today]'
      ),
    });
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "save a note: ran 5km today" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.action_id).toBe("action-1");
    expect(body.action_description).toBe("Save workout note");
    expect(body.reply).toBe("Sure!");
    expect(savedActions[0].action.type).toBe("note");
    expect(savedActions[0].action.data).toBe("ran 5km today");
  });

  test("strips action tag from reply returned to user", async () => {
    const { app } = buildApp({
      groqCall: mock(async () =>
        'On it! [ACTION: Send email | TYPE: email_send | DATA: {"to":"a@b.com","subject":"Hi","body":"Hello"}]'
      ),
    });
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "send an email to a@b.com saying Hi" }),
    });
    const body = await res.json() as any;
    expect(body.reply).toBe("On it!");
    expect(body.reply).not.toContain("[ACTION:");
  });

  test("no action_id when response has no action tag", async () => {
    const { app } = buildApp({
      groqCall: mock(async () => "Just a plain reply."),
    });
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    const body = await res.json() as any;
    expect(body.action_id).toBeUndefined();
  });

  test("normalises 'calendar' type to 'calendar_create'", async () => {
    const { app, savedActions } = buildApp({
      groqCall: mock(async () =>
        '[ACTION: Schedule meeting | TYPE: calendar | DATA: {"title":"Sync","start":"2026-03-10 10:00","end":"2026-03-10 11:00"}]'
      ),
    });
    await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "schedule a sync tomorrow at 10am" }),
    });
    expect(savedActions[0].action.type).toBe("calendar_create");
  });
});

// ── Memory and context ────────────────────────────────────────────────────────

describe("POST /api/messages — memory", () => {
  test("fetches memory and relevant context before calling Groq", async () => {
    const fetchMemoryContext   = mock(async () => "FACTS:\n- likes coffee");
    const fetchRelevantContext = mock(async () => "RELEVANT: talked about coffee last week");
    const groqCall = mock(async (prompt: string) => {
      expect(prompt).toContain("likes coffee");
      expect(prompt).toContain("talked about coffee");
      return "Got it.";
    });
    const { app } = buildApp({ fetchMemoryContext, fetchRelevantContext, groqCall });
    await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "what do I like?" }),
    });
    expect(fetchMemoryContext).toHaveBeenCalledTimes(1);
    expect(fetchRelevantContext).toHaveBeenCalledTimes(1);
  });

  test("calls persistMemoryIntents with the raw LLM response", async () => {
    const raw = "Great goal! [GOAL: learn TypeScript | DEADLINE: 2026-06-01]";
    const persistMemoryIntents = mock(async (userId: string, response: string) => {
      expect(response).toBe(raw);
    });
    const { app } = buildApp({
      groqCall: mock(async () => raw),
      persistMemoryIntents,
    });
    await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "I want to learn TypeScript" }),
    });
    // Give fire-and-forget a tick to complete
    await new Promise((r) => setTimeout(r, 10));
    expect(persistMemoryIntents).toHaveBeenCalledTimes(1);
  });
});

// ── Web search ────────────────────────────────────────────────────────────────

describe("POST /api/messages — web search", () => {
  test("injects search results into prompt when Tavily enabled and query matches", async () => {
    const runWebSearch = mock(async () => "SEARCH: Bitcoin is at $80,000 today.");
    const groqCall = mock(async (prompt: string) => {
      expect(prompt).toContain("$80,000");
      return "Bitcoin price noted.";
    });
    const { app } = buildApp(
      {
        groqCall,
        runWebSearch,
        loadIntegrationFlags: mock(async () => ({ ...NO_INTEGRATIONS, tavilyEnabled: true })),
      }
    );
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "what is the current price of bitcoin?" }),
    });
    expect(res.status).toBe(200);
    expect(runWebSearch).toHaveBeenCalledTimes(1);
  });

  test("skips web search when Tavily not enabled", async () => {
    const runWebSearch = mock(async () => "should not be called");
    const { app } = buildApp({ runWebSearch });
    await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "what is the latest news?" }),
    });
    expect(runWebSearch).not.toHaveBeenCalled();
  });

  test("skips web search when web_search disabled on profile", async () => {
    const runWebSearch = mock(async () => "should not be called");
    const { app } = buildApp(
      {
        runWebSearch,
        loadIntegrationFlags: mock(async () => ({ ...NO_INTEGRATIONS, tavilyEnabled: true })),
      },
      { ...DEFAULT_PROFILE, web_search: false }
    );
    await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "latest news?" }),
    });
    expect(runWebSearch).not.toHaveBeenCalled();
  });
});

// ── GET /api/messages/history ─────────────────────────────────────────────────

describe("GET /api/messages/history", () => {
  test("returns conversation history", async () => {
    const history: HistoryMessage[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
    const { app } = buildApp({ fetchHistory: mock(async () => history) });
    const res = await app.request("/api/messages/history");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(history);
  });

  test("returns empty array when no history", async () => {
    const { app } = buildApp({ fetchHistory: mock(async () => []) });
    const res = await app.request("/api/messages/history");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
