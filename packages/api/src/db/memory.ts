/**
 * Memory helpers — facts/goals context and memory intent processing.
 *
 * Mirrors the original bot's memory.ts but scoped per-user.
 * Semantic search (getRelevantContext) requires pgvector + the embed Edge Function.
 */

import { getServiceClient } from "./client.ts";

// ── Read helpers ──────────────────────────────────────────────────────────────

/**
 * Build a memory context string from the user's facts and active goals.
 * Injected into buildPrompt as `memoryContext`.
 */
export async function getMemoryContext(userId: string): Promise<string | undefined> {
  const db = getServiceClient();

  const { data, error } = await db
    .from("memory")
    .select("type, content, deadline")
    .eq("user_id", userId)
    .in("type", ["fact", "goal"])
    .order("created_at", { ascending: false })
    .limit(20);

  if (error || !data?.length) return undefined;

  const facts = data.filter((r) => r.type === "fact").map((r) => `- ${r.content}`);
  const goals = data
    .filter((r) => r.type === "goal")
    .map((r) => `- ${r.content}${r.deadline ? ` (by ${r.deadline})` : ""}`);

  const parts: string[] = [];
  if (facts.length) parts.push(`FACTS ABOUT USER:\n${facts.join("\n")}`);
  if (goals.length) parts.push(`ACTIVE GOALS:\n${goals.join("\n")}`);
  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * Semantic search over past messages and memory.
 * Returns a formatted context string, or undefined if nothing relevant.
 *
 * Requires the embed Edge Function to be running and pgvector to be enabled.
 * Fails gracefully — a search error never blocks the message response.
 */
export async function getRelevantContext(
  userId: string,
  query: string
): Promise<string | undefined> {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) return undefined;

    const res = await fetch(`${supabaseUrl}/functions/v1/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, user_id: userId, limit: 5 }),
    });

    if (!res.ok) return undefined;
    const results = await res.json() as Array<{ content: string; similarity: number }>;
    if (!results.length) return undefined;

    const lines = results.map((r) => `- ${r.content}`).join("\n");
    return `RELEVANT CONTEXT:\n${lines}`;
  } catch {
    return undefined;
  }
}

// ── Write helpers ─────────────────────────────────────────────────────────────

const REMEMBER_RE = /\[REMEMBER:\s*([^\]]+)\]/gi;
const GOAL_RE = /\[GOAL:\s*([^\]|]+?)(?:\s*\|\s*DEADLINE:\s*([^\]]+))?\]/gi;
const DONE_RE = /\[DONE:\s*([^\]]+)\]/gi;

/** Maximum memory items inserted per LLM response (M3). */
const MAX_MEMORY_INSERTS = 5;

/** Escape ilike wildcard characters in a search term (M4). */
function escapeIlike(text: string): string {
  return text.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Extract and persist memory tags from an LLM response.
 * Tags are processed silently — errors never surface to the user.
 */
export async function processMemoryIntents(
  userId: string,
  response: string
): Promise<void> {
  const db = getServiceClient();
  const inserts: Array<{
    user_id: string;
    type: string;
    content: string;
    deadline?: string | null;
  }> = [];

  for (const match of response.matchAll(REMEMBER_RE)) {
    inserts.push({ user_id: userId, type: "fact", content: match[1].trim() });
  }

  for (const match of response.matchAll(GOAL_RE)) {
    inserts.push({
      user_id: userId,
      type: "goal",
      content: match[1].trim(),
      deadline: match[2]?.trim() ?? null,
    });
  }

  // Cap inserts to prevent a rogue LLM response from flooding the memory table
  if (inserts.length) {
    const { error } = await db.from("memory").insert(inserts.slice(0, MAX_MEMORY_INSERTS));
    if (error) console.error("processMemoryIntents insert error:", error.message);
  }

  // Mark goals as completed — escape wildcards to prevent unintended broad matches
  for (const match of response.matchAll(DONE_RE)) {
    const searchText = escapeIlike(match[1].trim());
    const { error } = await db
      .from("memory")
      .update({ type: "completed_goal", completed_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("type", "goal")
      .ilike("content", `%${searchText}%`);
    if (error) console.error("processMemoryIntents done error:", error.message);
  }
}
