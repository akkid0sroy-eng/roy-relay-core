/**
 * Health endpoints.
 *
 * GET /health       — liveness probe: always 200 while the process is running.
 * GET /health/ready — readiness probe: pings Supabase + Redis and returns 200
 *                     only when all required dependencies are reachable.
 *
 * Designed with injectable deps so the route is fully testable without a live
 * Supabase or Redis connection.
 */

import { Hono } from "hono";
import { getServiceClient } from "../db/client.ts";
import { getRedisClient } from "../services/rate-limiter.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckStatus = "ok" | "fail" | "skipped";

export interface HealthChecks {
  supabase: CheckStatus;
  redis: CheckStatus;
}

export interface HealthDeps {
  checkSupabase: () => Promise<CheckStatus>;
  checkRedis: () => Promise<CheckStatus>;
}

// ── Timeout helper ────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const timeout = new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms));
  return Promise.race([promise, timeout]);
}

// ── Default dependency implementations ───────────────────────────────────────

async function _checkSupabase(): Promise<CheckStatus> {
  try {
    const { error } = await withTimeout(
      getServiceClient().from("user_profiles").select("count").limit(1),
      PROBE_TIMEOUT_MS,
      { error: new Error("timeout") }
    );
    return error ? "fail" : "ok";
  } catch {
    return "fail";
  }
}

async function _checkRedis(): Promise<CheckStatus> {
  if (!process.env.REDIS_URL) return "skipped";
  try {
    const result = await withTimeout(
      getRedisClient().ping(),
      PROBE_TIMEOUT_MS,
      null
    );
    return result === "PONG" ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

export const defaultHealthDeps: HealthDeps = {
  checkSupabase: _checkSupabase,
  checkRedis: _checkRedis,
};

// ── Route factory ─────────────────────────────────────────────────────────────

export function createHealthRoutes(deps: HealthDeps = defaultHealthDeps): Hono {
  const router = new Hono();

  // Liveness probe — always 200 while the process is alive
  router.get("/", (c) => c.json({ ok: true }));

  // Readiness probe — checks Supabase + Redis before accepting traffic
  router.get("/ready", async (c) => {
    const [supabaseResult, redisResult] = await Promise.all([
      deps.checkSupabase().catch((): CheckStatus => "fail"),
      deps.checkRedis().catch((): CheckStatus => "fail"),
    ]);

    const checks: HealthChecks = {
      supabase: supabaseResult,
      redis: redisResult,
    };

    // Ready when Supabase is ok AND Redis is either ok or skipped (not configured)
    const allOk =
      checks.supabase === "ok" &&
      (checks.redis === "ok" || checks.redis === "skipped");

    return c.json({ ok: allOk, checks }, allOk ? 200 : 503);
  });

  return router;
}
