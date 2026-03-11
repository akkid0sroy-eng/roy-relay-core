import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createHealthRoutes } from "../src/routes/health.ts";
import type { HealthDeps } from "../src/routes/health.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(deps: HealthDeps): Hono {
  const app = new Hono();
  app.route("/health", createHealthRoutes(deps));
  return app;
}

const okDeps: HealthDeps = {
  checkSupabase: async () => "ok",
  checkRedis: async () => "ok",
};

const skippedRedisDeps: HealthDeps = {
  checkSupabase: async () => "ok",
  checkRedis: async () => "skipped",
};

const supabaseDownDeps: HealthDeps = {
  checkSupabase: async () => "fail",
  checkRedis: async () => "ok",
};

const redisDownDeps: HealthDeps = {
  checkSupabase: async () => "ok",
  checkRedis: async () => "fail",
};

const bothDownDeps: HealthDeps = {
  checkSupabase: async () => "fail",
  checkRedis: async () => "fail",
};

const throwingDeps: HealthDeps = {
  checkSupabase: async () => { throw new Error("network error"); },
  checkRedis: async () => { throw new Error("connection refused"); },
};

// ── GET /health ───────────────────────────────────────────────────────────────

describe("GET /health", () => {
  test("returns 200 { ok: true } always", async () => {
    const app = makeApp(okDeps);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  test("returns 200 even when deps are down", async () => {
    const app = makeApp(bothDownDeps);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

// ── GET /health/ready ─────────────────────────────────────────────────────────

describe("GET /health/ready", () => {
  test("returns 200 when both Supabase and Redis are ok", async () => {
    const app = makeApp(okDeps);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.supabase).toBe("ok");
    expect(body.checks.redis).toBe("ok");
  });

  test("returns 200 when Redis is skipped (no REDIS_URL)", async () => {
    const app = makeApp(skippedRedisDeps);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.redis).toBe("skipped");
  });

  test("returns 503 when Supabase is down", async () => {
    const app = makeApp(supabaseDownDeps);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.supabase).toBe("fail");
  });

  test("returns 503 when Redis is down (configured but unreachable)", async () => {
    const app = makeApp(redisDownDeps);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.redis).toBe("fail");
  });

  test("returns 503 when both deps are down", async () => {
    const app = makeApp(bothDownDeps);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.supabase).toBe("fail");
    expect(body.checks.redis).toBe("fail");
  });

  test("returns 503 and catches thrown errors from check functions", async () => {
    const app = makeApp(throwingDeps);
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.supabase).toBe("fail");
    expect(body.checks.redis).toBe("fail");
  });

  test("response body does not contain internal error details", async () => {
    const app = makeApp(throwingDeps);
    const res = await app.request("/health/ready");
    const text = await res.text();
    expect(text).not.toContain("network error");
    expect(text).not.toContain("connection refused");
  });
});
