import type { ActionType, PendingAction } from "./types.ts";

// ── Regex constants ───────────────────────────────────────────────────────────

const SEARCH_TRIGGERS =
  /\b(latest|current|today|yesterday|this week|this month|now|recent|news|price|weather|score|standings?|live|breaking|update|what is|who is|when (is|was|did)|where is|how (much|many)|stock|market|rate|forecast)\b/i;

const ACTION_WORDS =
  /\b(save|add|create|send|schedule|remind|note|book|make|set|write|record)\b/i;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Parse JSON with a fallback value. Attempts basic trailing-comma repair
 * before giving up and returning the fallback.
 */
export function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const repaired = raw.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
    try {
      return JSON.parse(repaired) as T;
    } catch {
      return fallback;
    }
  }
}

/**
 * Strip prompt-injection tags from user input before it enters the LLM prompt.
 */
export function sanitizeUserInput(text: string): string {
  return text
    .replace(/\[ACTION:[^\]]*\]/gi, "[removed]")
    .replace(/\[REMEMBER:[^\]]*\]/gi, "[removed]")
    .replace(/\[GOAL:[^\]]*\]/gi, "[removed]")
    .replace(/\[DONE:[^\]]*\]/gi, "[removed]");
}

/**
 * Sanitize content from untrusted external sources (web search results, emails,
 * scraped pages) before injecting into the LLM prompt.
 *
 * Extends sanitizeUserInput with additional patterns that are highly anomalous
 * in search result text but are classic prompt-injection vectors:
 *   - Action / memory tags (same as user input)
 *   - "Ignore [all] [previous|prior|above] instructions" phrasing
 *   - Opening of a new system/user/assistant role block
 *   - Closing search_results tag that would escape the trust boundary wrapper
 */
export function sanitizeExternalContent(text: string): string {
  return sanitizeUserInput(text)
    // Classic "ignore instructions" injection
    .replace(/ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?/gi, "[removed]")
    // Role-block injection (e.g. "System:", "User:", "Assistant:")
    .replace(/^(system|user|assistant)\s*:/gim, "[removed]:")
    // Prevent escaping the <search_results> trust boundary the caller wraps around this text
    .replace(/<\/?\s*search_results\s*>/gi, "[removed]");
}

/**
 * Return true if the user query likely needs a live web search.
 * Slash commands and explicit action requests are excluded.
 */
export function needsWebSearch(text: string): boolean {
  if (text.startsWith("/")) return false;
  if (ACTION_WORDS.test(text)) return false;
  return SEARCH_TRIGGERS.test(text);
}

/**
 * Extract a single `[ACTION: ... | TYPE: ... | DATA: ...]` tag from an LLM
 * response. Returns the cleaned response text and the parsed action (or null).
 */
export function parseActionIntent(response: string): {
  clean: string;
  action: PendingAction | null;
} {
  const match = response.match(
    /\[ACTION:\s*([^|]+)\|\s*TYPE:\s*(\w+)\s*\|\s*DATA:\s*([\s\S]+?)\]/i
  );
  if (!match) return { clean: response, action: null };

  const rawType = match[2].trim().toLowerCase();
  // Normalize shorthand types the LLM commonly produces
  const typeMap: Record<string, ActionType> = {
    calendar: "calendar_create",
    email: "email_send",
    notion: "notion_create",
    call: "phone_call",
    phone: "phone_call",
  };
  const type: ActionType = (typeMap[rawType] ?? rawType) as ActionType;

  return {
    clean: response.replace(match[0], "").trim(),
    action: {
      description: match[1].trim(),
      type,
      data: match[3].trim(),
    },
  };
}
