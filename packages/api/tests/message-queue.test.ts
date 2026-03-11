import { describe, expect, test, mock } from "bun:test";
import {
  enqueueMessage,
  drainMessageRetryQueue,
  RETRY_QUEUE_KEY,
  MAX_RETRY_AGE_MS,
  MAX_RETRIES,
  type QueuedMessage,
  type SaveMessageFn,
} from "../src/services/message-queue.ts";

// ── Mock Redis client ─────────────────────────────────────────────────────────

function makeMockRedis(initial: string[] = []) {
  // Simple in-memory LIST: lpush prepends, rpop removes from the right (FIFO)
  const store: Map<string, string[]> = new Map();
  if (initial.length) store.set(RETRY_QUEUE_KEY, [...initial]);

  return {
    lpush: mock(async (key: string, value: string) => {
      const list = store.get(key) ?? [];
      list.unshift(value); // prepend
      store.set(key, list);
      return list.length;
    }),
    rpop: mock(async (key: string) => {
      const list = store.get(key);
      if (!list || list.length === 0) return null;
      return list.pop() ?? null; // remove from right
    }),
    expire: mock(async () => 1),
    /** Helper: peek at queue without modifying it */
    peek: (key = RETRY_QUEUE_KEY) => (store.get(key) ?? []).slice(),
  };
}

function makeSaveFn(shouldFail = false): SaveMessageFn & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = async (userId: string, role: "user" | "assistant", content: string, meta: Record<string, unknown>) => {
    calls.push([userId, role, content, meta]);
    if (shouldFail) throw new Error("Supabase down");
  };
  (fn as any).calls = calls;
  return fn as SaveMessageFn & { calls: unknown[][] };
}

// ── enqueueMessage ────────────────────────────────────────────────────────────

describe("enqueueMessage", () => {
  test("pushes serialised QueuedMessage to RETRY_QUEUE_KEY", async () => {
    const redis = makeMockRedis();
    await enqueueMessage(
      { userId: "u1", role: "user", content: "hello", metadata: { channel: "api" } },
      redis as any
    );
    expect(redis.lpush).toHaveBeenCalledTimes(1);
    const [key, raw] = redis.lpush.mock.calls[0] as [string, string];
    expect(key).toBe(RETRY_QUEUE_KEY);
    const parsed = JSON.parse(raw) as QueuedMessage;
    expect(parsed.userId).toBe("u1");
    expect(parsed.role).toBe("user");
    expect(parsed.content).toBe("hello");
    expect(parsed.retries).toBe(0);
    expect(parsed.enqueuedAt).toBeGreaterThan(0);
  });

  test("sets a 25-hour TTL on the key", async () => {
    const redis = makeMockRedis();
    await enqueueMessage(
      { userId: "u1", role: "user", content: "hi", metadata: {} },
      redis as any
    );
    expect(redis.expire).toHaveBeenCalledWith(RETRY_QUEUE_KEY, 60 * 60 * 25);
  });
});

// ── drainMessageRetryQueue ────────────────────────────────────────────────────

describe("drainMessageRetryQueue — empty queue", () => {
  test("returns zeroes when queue is empty", async () => {
    const redis = makeMockRedis([]);
    const saveFn = makeSaveFn();
    const result = await drainMessageRetryQueue(saveFn, redis as any);
    expect(result).toEqual({ retried: 0, expired: 0, failed: 0 });
    expect(saveFn.calls).toHaveLength(0);
  });
});

describe("drainMessageRetryQueue — successful retries", () => {
  test("saves each queued message and returns correct count", async () => {
    const msg1: QueuedMessage = {
      userId: "u1", role: "user", content: "msg1",
      metadata: {}, enqueuedAt: Date.now(), retries: 0,
    };
    const msg2: QueuedMessage = {
      userId: "u1", role: "assistant", content: "msg2",
      metadata: { has_action: true }, enqueuedAt: Date.now(), retries: 1,
    };
    // In the mock, rpop() removes from the right (array .pop()).
    // To get FIFO drain order (msg1 first, msg2 second), msg1 must be at the
    // tail of the initial list — i.e. initialise as [msg2, msg1].
    const redis = makeMockRedis([JSON.stringify(msg2), JSON.stringify(msg1)]);
    const saveFn = makeSaveFn(false);
    const result = await drainMessageRetryQueue(saveFn, redis as any);
    expect(result).toEqual({ retried: 2, expired: 0, failed: 0 });
    expect(saveFn.calls).toHaveLength(2);
    const savedContents = (saveFn.calls as string[][]).map((c) => c[2]).sort();
    expect(savedContents).toEqual(["msg1", "msg2"].sort());
  });
});

describe("drainMessageRetryQueue — expired messages", () => {
  test("discards messages older than MAX_RETRY_AGE_MS", async () => {
    const old: QueuedMessage = {
      userId: "u1", role: "user", content: "old",
      metadata: {}, enqueuedAt: Date.now() - MAX_RETRY_AGE_MS - 1_000, retries: 0,
    };
    const redis = makeMockRedis([JSON.stringify(old)]);
    const saveFn = makeSaveFn(false);
    const result = await drainMessageRetryQueue(saveFn, redis as any);
    expect(result).toEqual({ retried: 0, expired: 1, failed: 0 });
    expect(saveFn.calls).toHaveLength(0);
  });
});

describe("drainMessageRetryQueue — re-queue on save failure", () => {
  test("re-enqueues with retries+1 when save fails and retries < MAX_RETRIES", async () => {
    const msg: QueuedMessage = {
      userId: "u1", role: "user", content: "retry me",
      metadata: {}, enqueuedAt: Date.now(), retries: 2,
    };
    const redis = makeMockRedis([JSON.stringify(msg)]);
    const saveFn = makeSaveFn(true); // always fails
    const result = await drainMessageRetryQueue(saveFn, redis as any);
    // Not retried (save failed), not expired, not given up yet
    expect(result).toEqual({ retried: 0, expired: 0, failed: 0 });
    // Re-enqueued with retries = 3
    const requeued = JSON.parse(redis.peek()[0]) as QueuedMessage;
    expect(requeued.retries).toBe(3);
    expect(requeued.content).toBe("retry me");
  });

  test("drops message and counts as failed after MAX_RETRIES attempts", async () => {
    const msg: QueuedMessage = {
      userId: "u1", role: "user", content: "give up",
      metadata: {}, enqueuedAt: Date.now(), retries: MAX_RETRIES, // at the limit
    };
    const redis = makeMockRedis([JSON.stringify(msg)]);
    const saveFn = makeSaveFn(true);
    const result = await drainMessageRetryQueue(saveFn, redis as any);
    expect(result).toEqual({ retried: 0, expired: 0, failed: 1 });
    expect(redis.peek()).toHaveLength(0); // not re-enqueued
  });
});

describe("drainMessageRetryQueue — malformed JSON", () => {
  test("counts unparseable entries as failed and continues", async () => {
    const good: QueuedMessage = {
      userId: "u1", role: "user", content: "valid",
      metadata: {}, enqueuedAt: Date.now(), retries: 0,
    };
    const redis = makeMockRedis(["not-valid-json", JSON.stringify(good)]);
    const saveFn = makeSaveFn(false);
    const result = await drainMessageRetryQueue(saveFn, redis as any);
    expect(result.failed).toBe(1);
    expect(result.retried).toBe(1);
    expect(saveFn.calls[0][2]).toBe("valid");
  });
});

describe("drainMessageRetryQueue — batch size", () => {
  test("stops after batchSize even when queue has more items", async () => {
    const msgs = Array.from({ length: 5 }, (_, i): QueuedMessage => ({
      userId: "u1", role: "user", content: `msg${i}`,
      metadata: {}, enqueuedAt: Date.now(), retries: 0,
    }));
    const redis = makeMockRedis(msgs.map((m) => JSON.stringify(m)));
    const saveFn = makeSaveFn(false);
    const result = await drainMessageRetryQueue(saveFn, redis as any, 3); // batchSize=3
    expect(result.retried).toBe(3);
    expect(saveFn.calls).toHaveLength(3);
    expect(redis.peek()).toHaveLength(2); // 2 items remain
  });
});
