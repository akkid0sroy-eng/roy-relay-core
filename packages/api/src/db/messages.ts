/**
 * Message history DB helpers — per-user, per-context conversation storage.
 */

import type { HistoryMessage } from "@relay/core";
import { getServiceClient } from "./client.ts";

/** Composite context key: userId + optional thread/topic ID. */
export function buildContextId(userId: string, threadId?: string): string {
  return threadId ? `${userId}:${threadId}` : userId;
}

/**
 * Load the last `limit` messages for a user+context from the DB,
 * returned in chronological order (oldest first) for LLM history.
 */
export async function getHistory(
  userId: string,
  contextId: string,
  limit = 10
): Promise<HistoryMessage[]> {
  const db = getServiceClient();

  // thread_id is the part after the colon, or null for the default context
  const threadId = contextId.includes(":") ? contextId.split(":").slice(1).join(":") : null;

  let query = db
    .from("messages")
    .select("role, content")
    .eq("user_id", userId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (threadId) {
    query = query.eq("thread_id", threadId);
  } else {
    query = query.is("thread_id", null);
  }

  const { data, error } = await query;
  if (error) throw new Error(`getHistory: ${error.message}`);

  // Reverse so oldest message is first (correct order for LLM context)
  return ((data ?? []) as HistoryMessage[]).reverse();
}

/** Persist a single message to the DB. */
export async function saveMessage(
  userId: string,
  role: "user" | "assistant",
  content: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const db = getServiceClient();
  const { error } = await db.from("messages").insert({
    user_id: userId,
    role,
    content,
    thread_id: (metadata.thread_id as string) ?? null,
    agent_key: (metadata.agent_key as string) ?? null,
    channel: (metadata.channel as string) ?? "api",
    metadata,
  });
  if (error) throw new Error(`saveMessage: ${error.message}`);
}
