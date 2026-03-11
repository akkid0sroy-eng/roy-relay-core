import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { rateLimitMiddleware } from "../src/middleware/rate-limit.ts";
import { NoopRateLimiter, type RateLimiter, type RateLimitResult } from "../src/services/rate-limiter.ts";
import { getPlanLimit, PLAN_LIMITS } from "../src/services/rate-limiter.ts";

// ── Plan limits ───────────────────────────────────────────────────────────────

describe("getPlanLimit", () => {
  test("free plan returns 20 req/min", () => {
    expect(getPlanLimit("free")).toBe(20);
  });

  test("pro plan returns 100 req/min", () => {
    expect(getPlanLimit("pro")).toBe(100);
  });

  test("enterprise plan returns 1000 req/min", () => {
    expect(getPlanLimit("enterprise")).toBe(1000);
  });

  test("unknown plan defaults to free", () => {
    expect(getPlanLimit("unknown_plan")).toBe(20);
  });
});

// ── NoopRateLimiter ───────────────────────────────────────────────────────────

describe("NoopRateLimiter", () => {
  test("always allows requests", async () => {
    const limiter = new NoopRateLimiter();
    const result = await limiter.check("user-1", 20, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(20);
    expect(result.limit).toBe(20);
  });
});

// ── Rate-limit middleware ─────────────────────────────────────────────────────

function buildApp(limiter: RateLimiter, plan = "free") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", "user-uuid");
    c.set("userPlan", plan);
    await next();
  });
  app.use("*", rateLimitMiddleware({ limiter }));
  app.get("/api/test", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimitMiddleware", () => {
  test("allows request when under limit", async () => {
    const app = buildApp(new NoopRateLimiter());
    const res = await app.request("/api/test");
    expect(res.status).toBe(200);
  });

  test("injects rate-limit headers on allowed request", async () => {
    const app = buildApp(new NoopRateLimiter(), "free");
    const res = await app.request("/api/test");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("20");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  test("returns 429 when limit exceeded", async () => {
    const blocked: RateLimiter = {
      async check(_key, limit, windowMs): Promise<RateLimitResult> {
        return { allowed: false, remaining: 0, limit, resetAt: Date.now() + windowMs };
      },
    };
    const app = buildApp(blocked);
    const res = await app.request("/api/test");
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error).toContain("Rate limit");
    expect(typeof body.retry_after).toBe("number");
  });

  test("includes Retry-After header on 429", async () => {
    const blocked: RateLimiter = {
      async check(_key, limit, windowMs): Promise<RateLimitResult> {
        return { allowed: false, remaining: 0, limit, resetAt: Date.now() + 30_000 };
      },
    };
    const app = buildApp(blocked);
    const res = await app.request("/api/test");
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(30);
  });

  test("pro plan uses higher limit in headers", async () => {
    const app = buildApp(new NoopRateLimiter(), "pro");
    const res = await app.request("/api/test");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("100");
  });

  test("fails open when rate limiter throws", async () => {
    const broken: RateLimiter = {
      async check(): Promise<RateLimitResult> {
        throw new Error("Redis connection refused");
      },
    };
    const app = buildApp(broken);
    const res = await app.request("/api/test");
    // Should allow through, not 500 or 429
    expect(res.status).toBe(200);
  });

  test("does not expose Redis error details in the response body (M3)", async () => {
    // Simulate a Redis error whose message contains a credential-bearing URL
    const broken: RateLimiter = {
      async check(): Promise<RateLimitResult> {
        throw new Error("connect ECONNREFUSED redis://:s3cr3t@redis.internal:6379/0");
      },
    };
    const app = buildApp(broken);
    const res = await app.request("/api/test");
    expect(res.status).toBe(200); // fails open
    const text = await res.text();
    // The Redis URL / credential must never appear in the HTTP response
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("redis://");
    expect(text).not.toContain("ECONNREFUSED");
  });

  test("passes through when no userId set (unauthenticated)", async () => {
    const app = new Hono();
    app.use("*", rateLimitMiddleware({ limiter: new NoopRateLimiter() }));
    app.get("/api/test", (c) => c.json({ ok: true }));
    const res = await app.request("/api/test");
    expect(res.status).toBe(200);
  });
});
