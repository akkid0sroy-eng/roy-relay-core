/**
 * Rate limiter — sliding window counter using Redis sorted sets.
 *
 * Each request adds the current timestamp as a member. Members older than
 * the window are pruned on every check. The count of remaining members is
 * the current request count within the window.
 *
 * A no-op implementation is exported for tests and zero-Redis environments.
 */

// ── Interface ─────────────────────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  remaining: number; // requests left in current window
  limit: number;     // total limit for the window
  resetAt: number;   // unix ms when the window resets
}

export interface RateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

// ── Plan limits ───────────────────────────────────────────────────────────────

export const PLAN_LIMITS: Record<string, { requestsPerMinute: number }> = {
  free:       { requestsPerMinute: 20 },
  pro:        { requestsPerMinute: 100 },
  enterprise: { requestsPerMinute: 1000 },
};

export function getPlanLimit(plan: string): number {
  return (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free).requestsPerMinute;
}

// ── Redis implementation ───────────────────────────────────────────────────────

import Redis from "ioredis";

let _redis: Redis | null = null;

export function getRedisClient(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    _redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    _redis.on("error", (err) => {
      // Non-fatal — rate limiter degrades gracefully if Redis is unavailable
      if (process.env.NODE_ENV !== "test") {
        console.warn("Redis error:", err.message);
      }
    });
  }
  return _redis;
}

export function resetRedisClient(): void {
  _redis = null;
}

export class RedisRateLimiter implements RateLimiter {
  private redis: Redis;

  constructor(redis?: Redis) {
    this.redis = redis ?? getRedisClient();
  }

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const resetAt = now + windowMs;

    // Sliding window: prune old entries, add current, count
    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(key, "-inf", windowStart);
    pipeline.zadd(key, now, `${now}-${Math.random()}`);
    pipeline.zcard(key);
    pipeline.pexpire(key, windowMs + 1000); // auto-expire the key

    const results = await pipeline.exec();
    const count = (results?.[2]?.[1] as number) ?? 0;

    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);

    return { allowed, remaining, limit, resetAt };
  }
}

// ── No-op implementation (for tests / Redis-less envs) ────────────────────────

export class NoopRateLimiter implements RateLimiter {
  async check(_key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    return { allowed: true, remaining: limit, limit, resetAt: Date.now() + windowMs };
  }
}

// ── Singleton for production use ──────────────────────────────────────────────

let _limiter: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!_limiter) {
    _limiter = process.env.REDIS_URL
      ? new RedisRateLimiter()
      : new NoopRateLimiter();
  }
  return _limiter;
}

export function setRateLimiter(limiter: RateLimiter): void {
  _limiter = limiter;
}
