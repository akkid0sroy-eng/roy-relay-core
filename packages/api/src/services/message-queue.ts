/**
 * Redis-backed retry queue for message persistence (R1 — Phase 2).
 *
 * When a `saveMessage` call fails (e.g. Supabase is temporarily down), the
 * calling code pushes the message payload here instead of silently dropping it.
 * A background drain loop (started in server.ts) retries saves periodically.
 *
 * Queue key:  relay:messages:retry  (Redis LIST, LPUSH in / RPOP out = FIFO)
 * Retention:  Messages older than MAX_RETRY_AGE_MS (24 h) are discarded.
 * Max retries: A message that fails 5 consecutive drain attempts is dropped.
 */

import type Redis from "ioredis";
import { getRedisClient } from "./rate-limiter.ts";
import type { saveMessage } from "../db/messages.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QueuedMessage {
  userId:    string;
  role:      "user" | "assistant";
  content:   string;
  metadata:  Record<string, unknown>;
  enqueuedAt: number;  // unix ms — used to discard stale entries
  retries:   number;   // incremented on each failed drain attempt
}

export type SaveMessageFn = typeof saveMessage;

export interface DrainResult {
  retried: number;  // successfully saved on this drain pass
  expired: number;  // discarded because enqueuedAt > MAX_RETRY_AGE_MS
  failed:  number;  // gave up after MAX_RETRIES attempts, or unparseable
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const RETRY_QUEUE_KEY   = "relay:messages:retry";
export const MAX_RETRY_AGE_MS  = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_RETRIES       = 5;
export const MAX_DRAIN_BATCH   = 50;                   // messages per drain cycle
export const DRAIN_INTERVAL_MS = 30_000;               // 30 s between drain cycles

// ── enqueueMessage ────────────────────────────────────────────────────────────

/**
 * Push a failed message onto the retry queue.
 *
 * @param msg     - Message fields that could not be saved to Supabase.
 * @param redis   - Optional Redis client (defaults to module singleton).
 */
export async function enqueueMessage(
  msg: Omit<QueuedMessage, "enqueuedAt" | "retries">,
  redis: Redis = getRedisClient()
): Promise<void> {
  const payload: QueuedMessage = { ...msg, enqueuedAt: Date.now(), retries: 0 };
  await redis.lpush(RETRY_QUEUE_KEY, JSON.stringify(payload));
  // 25-hour TTL on the list: ensures the key self-cleans even if the drain
  // loop is down for a full day and never pops the last entry.
  await redis.expire(RETRY_QUEUE_KEY, 60 * 60 * 25);
}

// ── drainMessageRetryQueue ────────────────────────────────────────────────────

/**
 * Pop up to `batchSize` messages from the retry queue and attempt to re-save
 * each one. Failed saves are re-enqueued with an incremented retry counter
 * until `MAX_RETRIES` is exceeded, after which the message is dropped.
 *
 * @param saveFn    - The `saveMessage` implementation (injected for testability).
 * @param redis     - Optional Redis client.
 * @param batchSize - Maximum messages to process in this pass.
 */
export async function drainMessageRetryQueue(
  saveFn: SaveMessageFn,
  redis: Redis = getRedisClient(),
  batchSize = MAX_DRAIN_BATCH
): Promise<DrainResult> {
  let retried = 0;
  let expired = 0;
  let failed  = 0;
  const now = Date.now();

  // Collect messages that need to be re-enqueued after the loop finishes.
  // We must NOT push them back during the loop — otherwise they would be
  // immediately re-popped in the same drain pass and processed again.
  const toRequeue: QueuedMessage[] = [];

  for (let i = 0; i < batchSize; i++) {
    const raw = await redis.rpop(RETRY_QUEUE_KEY);
    if (!raw) break; // queue empty

    let msg: QueuedMessage;
    try {
      msg = JSON.parse(raw) as QueuedMessage;
    } catch {
      failed++;
      continue;
    }

    // Discard messages that are too old to be useful
    if (now - msg.enqueuedAt > MAX_RETRY_AGE_MS) {
      expired++;
      continue;
    }

    try {
      await saveFn(msg.userId, msg.role, msg.content, msg.metadata);
      retried++;
    } catch {
      if (msg.retries < MAX_RETRIES) {
        toRequeue.push({ ...msg, retries: msg.retries + 1 });
      } else {
        // Give up — drop the message after MAX_RETRIES consecutive failures
        failed++;
        console.error(
          `[message-queue] Dropping message after ${MAX_RETRIES} retries:`,
          { userId: msg.userId, role: msg.role, enqueuedAt: new Date(msg.enqueuedAt).toISOString() }
        );
      }
    }
  }

  // Flush re-queued messages back to Redis after the batch is fully processed
  for (const m of toRequeue) {
    await redis.lpush(RETRY_QUEUE_KEY, JSON.stringify(m));
  }

  if (retried > 0 || expired > 0 || failed > 0) {
    console.log(
      `[message-queue] drain complete: retried=${retried} expired=${expired} failed=${failed}`
    );
  }

  return { retried, expired, failed };
}

// ── startDrainLoop ────────────────────────────────────────────────────────────

/**
 * Start the periodic background drain loop.
 * Call once at server startup when `REDIS_URL` is configured.
 * Returns the interval handle so it can be cleared in tests.
 *
 * @param saveFn   - `saveMessage` implementation.
 * @param redis    - Optional Redis client.
 * @param interval - Milliseconds between drain passes (default: 30 s).
 */
export function startDrainLoop(
  saveFn: SaveMessageFn,
  redis?: Redis,
  interval = DRAIN_INTERVAL_MS
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    drainMessageRetryQueue(saveFn, redis).catch((err) =>
      console.error("[message-queue] drain error:", err.message)
    );
  }, interval);
}
