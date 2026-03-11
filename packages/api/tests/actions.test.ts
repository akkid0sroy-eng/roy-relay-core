import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";
import { createActionRoutes, type ActionDeps } from "../src/routes/actions.ts";
import type { PendingActionRow } from "../src/db/pending-actions.ts";
import type { IntegrationLoaders } from "@relay/core";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    id:          "action-uuid-1",
    user_id:     "user-uuid",
    action_type: "note",
    description: "Save workout note",
    data:        "ran 5km today",
    status:      "pending",
    chat_id:     null,
    message_id:  null,
    result:      null,
    error:       null,
    created_at:  "2026-03-09T10:00:00Z",
    expires_at:  "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

const NO_LOADERS: IntegrationLoaders = {};

// ── App builder ───────────────────────────────────────────────────────────────

function buildApp(overrides: Partial<ActionDeps> = {}) {
  const deps: ActionDeps = {
    fetchAction:   mock(async () => makeRow()),
    claimAction:   mock(async () => true),
    resolveAction: mock(async () => {}) as ActionDeps["resolveAction"],
    rejectAction:  mock(async () => {}) as ActionDeps["rejectAction"],
    loadLoaders:   mock(async () => NO_LOADERS),
    ...overrides,
  };

  const routes = createActionRoutes(deps);
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "user-uuid"); await next(); });
  app.route("/api/actions", routes);

  return { app, deps };
}

// ── GET /api/actions/:id ──────────────────────────────────────────────────────

describe("GET /api/actions/:id", () => {
  test("returns action details", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/actions/action-uuid-1");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe("action-uuid-1");
    expect(body.type).toBe("note");
    expect(body.description).toBe("Save workout note");
    expect(body.status).toBe("pending");
  });

  test("returns 404 when action not found", async () => {
    const { app } = buildApp({ fetchAction: mock(async () => null) });
    const res = await app.request("/api/actions/no-such-id");
    expect(res.status).toBe(404);
  });

  test("does not include null result/error in response", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/actions/action-uuid-1");
    const body = await res.json() as any;
    expect(body.result).toBeUndefined();
    expect(body.error).toBeUndefined();
  });

  test("includes result when action resolved", async () => {
    const { app } = buildApp({
      fetchAction: mock(async () =>
        makeRow({ status: "approved", result: "Note saved." })
      ),
    });
    const res = await app.request("/api/actions/action-uuid-1");
    const body = await res.json() as any;
    expect(body.status).toBe("approved");
    expect(body.result).toBe("Note saved.");
  });
});

// ── POST /api/actions/:id/approve ─────────────────────────────────────────────

describe("POST /api/actions/:id/approve", () => {
  test("claims, executes, resolves and returns ok + result", async () => {
    const resolveAction = mock(async () => {});
    const { app, deps } = buildApp({
      fetchAction: mock(async () =>
        makeRow({
          action_type: "notion_create",
          data: '{"title":"Test page","content":"Hello","database":"tasks"}',
        })
      ),
      loadLoaders: mock(async () => ({
        loadNotion: async () => ({
          createNotionPage: async (_p: any) => "Page created: https://notion.so/test",
          notionEnabled: true,
        }),
      })),
      resolveAction,
    });

    const res = await app.request("/api/actions/action-uuid-1/approve", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.result).toContain("notion.so");
    expect(deps.claimAction).toHaveBeenCalledWith("action-uuid-1", "user-uuid");
    expect(resolveAction).toHaveBeenCalledTimes(1);
  });

  test("returns 404 when action not found", async () => {
    const { app } = buildApp({ fetchAction: mock(async () => null) });
    const res = await app.request("/api/actions/no-such/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("returns 409 when action is not pending", async () => {
    const { app } = buildApp({
      fetchAction: mock(async () => makeRow({ status: "approved" })),
    });
    const res = await app.request("/api/actions/action-uuid-1/approve", { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toContain("approved");
  });

  test("returns 410 when action is expired", async () => {
    const { app } = buildApp({
      fetchAction: mock(async () =>
        makeRow({ expires_at: "2020-01-01T00:00:00Z" }) // past date
      ),
    });
    const res = await app.request("/api/actions/action-uuid-1/approve", { method: "POST" });
    expect(res.status).toBe(410);
    const body = await res.json() as any;
    expect(body.error).toContain("expired");
  });

  test("passes userId to resolveAction", async () => {
    const resolveAction = mock(async () => {}) as ActionDeps["resolveAction"];
    buildApp({
      fetchAction: mock(async () =>
        makeRow({ action_type: "note", data: "test" })
      ),
      resolveAction,
    });
    // userId injected as "user-uuid" by the test middleware
    // We verify the signature via the rejectAction test above; here just confirm resolveAction
    // is called with userId on a successful approve
    const { app } = buildApp({
      fetchAction: mock(async () =>
        makeRow({ action_type: "notion_create", data: '{"title":"T","content":"C","database":"tasks"}' })
      ),
      loadLoaders: mock(async () => ({
        loadNotion: async () => ({
          createNotionPage: async (_p: any) => "Page created: https://notion.so/x",
          notionEnabled: true,
        }),
      })),
      resolveAction,
    });
    await app.request("/api/actions/action-uuid-1/approve", { method: "POST" });
    expect(resolveAction).toHaveBeenCalledWith("action-uuid-1", expect.any(String), "user-uuid");
  });

  test("returns 409 when claim races (already claimed)", async () => {
    const { app } = buildApp({
      claimAction: mock(async () => false),
    });
    const res = await app.request("/api/actions/action-uuid-1/approve", { method: "POST" });
    expect(res.status).toBe(409);
  });

  test("returns 502 and rejects when execution throws", async () => {
    const rejectAction = mock(async () => {});
    const { app } = buildApp({
      loadLoaders: mock(async () => ({
        loadGmail: async () => { throw new Error("Gmail auth failed"); },
      })),
      rejectAction,
    });

    // Use an email_send action type so executeAction calls Gmail
    const { app: emailApp } = buildApp({
      fetchAction: mock(async () =>
        makeRow({ action_type: "email_send", data: '{"to":"a@b.com","subject":"Hi","body":"Hello"}' })
      ),
      loadLoaders: mock(async () => ({
        loadGmail: async () => { throw new Error("Gmail auth failed"); },
      })),
      rejectAction,
    });

    const res = await emailApp.request("/api/actions/action-uuid-1/approve", { method: "POST" });
    expect(res.status).toBe(502);
    expect(rejectAction).toHaveBeenCalledTimes(1);
  });
});

// ── POST /api/actions/:id/reject ──────────────────────────────────────────────

describe("POST /api/actions/:id/reject", () => {
  test("rejects a pending action", async () => {
    const rejectAction = mock(async () => {});
    const { app } = buildApp({ rejectAction });
    const res = await app.request("/api/actions/action-uuid-1/reject", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(rejectAction).toHaveBeenCalledWith("action-uuid-1", undefined, "user-uuid");
  });

  test("returns 404 when action not found", async () => {
    const { app } = buildApp({ fetchAction: mock(async () => null) });
    const res = await app.request("/api/actions/no-such/reject", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("returns 409 when action is not pending", async () => {
    const { app } = buildApp({
      fetchAction: mock(async () => makeRow({ status: "rejected" })),
    });
    const res = await app.request("/api/actions/action-uuid-1/reject", { method: "POST" });
    expect(res.status).toBe(409);
  });
});
