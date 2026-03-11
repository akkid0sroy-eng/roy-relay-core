/**
 * Rate-limit middleware for Hono.
 *
 * Reads `userId` and `userPlan` from context (set by authMiddleware),
 * applies per-plan sliding-window limits, and injects rate-limit headers.
 *
 * On limit exceeded: 429 with Retry-After header.
 * On Redis failure: fails open (allows the request) to avoid outages.
 */

import type { Context, Next } from "hono";
import { getPlanLimit, getRateLimiter, type RateLimiter } from "../services/rate-limiter.ts";

export interface RateLimitOptions {
  windowMs?: number;  // default: 60_000 (1 minute)
  limiter?: RateLimiter;
}

export function rateLimitMiddleware(opts: RateLimitOptions = {}) {
  const windowMs = opts.windowMs ?? 60_000;

  return async (c: Context, next: Next) => {
    const userId = c.get("userId") as string | undefined;
    if (!userId) return next(); // unauthenticated — let auth middleware reject

    const plan = (c.get("userPlan") as string | undefined) ?? "free";
    const limit = getPlanLimit(plan);
    const key = `rl:${userId}`;

    const limiter = opts.limiter ?? getRateLimiter();

    let result;
    try {
      result = await limiter.check(key, limit, windowMs);
    } catch {
      // Fail open — don't block users if Redis is down.
      // err.message is intentionally omitted: Redis URLs may contain credentials
      // (redis://:password@host) and would be exposed in log aggregators.
      console.warn("Rate limiter unavailable, failing open.");
      return next();
    }

    // Always inject informational headers
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      const retryAfterSec = Math.ceil((result.resetAt - Date.now()) / 1000);
      c.header("Retry-After", String(retryAfterSec));
      return c.json(
        { error: "Rate limit exceeded. Please slow down.", retry_after: retryAfterSec },
        429
      );
    }

    return next();
  };
}
