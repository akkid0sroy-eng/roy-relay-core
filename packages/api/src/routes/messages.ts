/**
 * Messages route — the core message processing pipeline.
 *
 * POST /api/messages
 *   body: { content, thread_id?, channel? }
 *   → load user profile + integration flags
 *   → load conversation history
 *   → optional web search
 *   → load memory context
 *   → build prompt + call Groq
 *   → parse action intent
 *   → save messages + pending action
 *   → return { reply, action_id?, action_description? }
 *
 * GET /api/messages/history
 *   → recent conversation history for the user
 *
 * All heavy dependencies are injected via MessageDeps so the route
 * is fully testable without Groq, Supabase, or Tavily calls.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { buildPrompt, needsWebSearch, parseActionIntent } from "@relay/core";
import type { HistoryMessage, PromptConfig, PendingAction } from "@relay/core";
import { getServiceClient } from "../db/client.ts";
import { callGroq } from "../services/groq.ts";
import { getHistory, saveMessage, buildContextId } from "../db/messages.ts";
import { getMemoryContext, getRelevantContext, processMemoryIntents } from "../db/memory.ts";
import { insertPendingAction } from "../db/pending-actions.ts";
import { listIntegrations } from "../db/integrations.ts";
import { enqueueMessage } from "../services/message-queue.ts";

// ── Dependency injection interface ────────────────────────────────────────────

export interface MessageDeps {
  groqCall: (prompt: string, opts: { history: HistoryMessage[]; model: string; apiKey?: string }) => Promise<string>;
  fetchHistory: (userId: string, contextId: string, limit: number) => Promise<HistoryMessage[]>;
  persistMessage: (userId: string, role: "user" | "assistant", content: string, meta: Record<string, unknown>) => Promise<void>;
  fetchMemoryContext: (userId: string) => Promise<string | undefined>;
  fetchRelevantContext: (userId: string, query: string) => Promise<string | undefined>;
  persistMemoryIntents: (userId: string, response: string) => Promise<void>;
  storePendingAction: (userId: string, action: PendingAction) => Promise<string>;
  loadUserProfile: (userId: string) => Promise<UserProfile | null>;
  loadIntegrationFlags: (userId: string) => Promise<IntegrationFlags>;
  runWebSearch?: (query: string, userId: string) => Promise<string | undefined>;
  /** Enqueue a failed message for retry. Defaults to the Redis retry queue. */
  failedMessageEnqueue?: (userId: string, role: "user" | "assistant", content: string, meta: Record<string, unknown>) => Promise<void>;
}

export interface UserProfile {
  timezone: string;
  display_name?: string;
  profile_md?: string;
  ai_model: string;
  max_history: number;
  web_search: boolean;
}

export interface IntegrationFlags {
  gmailEnabled: boolean;
  calendarEnabled: boolean;
  notionEnabled: boolean;
  vapiEnabled: boolean;
  tavilyEnabled: boolean;
  groqApiKey?: string;
}

// ── Default implementations ───────────────────────────────────────────────────

async function defaultLoadUserProfile(userId: string): Promise<UserProfile | null> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("user_profiles")
    .select("timezone, display_name, profile_md, ai_model, max_history, web_search")
    .eq("user_id", userId)
    .single();
  if (error || !data) return null;
  return data as UserProfile;
}

async function defaultLoadIntegrationFlags(userId: string): Promise<IntegrationFlags> {
  const rows = await listIntegrations(userId);
  const enabled = new Set(rows.filter((r) => r.enabled).map((r) => r.provider));
  return {
    gmailEnabled:    enabled.has("google"),
    calendarEnabled: enabled.has("google"),
    notionEnabled:   enabled.has("notion"),
    vapiEnabled:     enabled.has("vapi"),
    tavilyEnabled:   enabled.has("tavily"),
  };
}

export const defaultMessageDeps: MessageDeps = {
  groqCall:               (p, o) => callGroq(p, { history: o.history, model: o.model, apiKey: o.apiKey }),
  fetchHistory:           getHistory,
  persistMessage:         saveMessage,
  fetchMemoryContext:     getMemoryContext,
  fetchRelevantContext:   getRelevantContext,
  persistMemoryIntents:   processMemoryIntents,
  storePendingAction:     insertPendingAction,
  loadUserProfile:        defaultLoadUserProfile,
  loadIntegrationFlags:   defaultLoadIntegrationFlags,
  // Only wire in the retry queue when Redis is available
  failedMessageEnqueue: process.env.REDIS_URL
    ? (userId, role, content, meta) => enqueueMessage({ userId, role, content, metadata: meta })
    : undefined,
};

// ── Route factory ─────────────────────────────────────────────────────────────

export function createMessageRoutes(deps: MessageDeps = defaultMessageDeps): Hono {
  const messages = new Hono();

  // ── POST /api/messages ────────────────────────────────────────────────────

  messages.post(
    "/",
    zValidator(
      "json",
      z.object({
        content:   z.string().min(1).max(10_000),
        thread_id: z.string().max(256).optional(),
        channel:   z.enum(["api", "telegram", "whatsapp"]).default("api"),
      })
    ),
    async (c) => {
      const userId = c.get("userId");
      const { content, thread_id, channel } = c.req.valid("json");

      // 1. Load user profile
      const profile = await deps.loadUserProfile(userId);
      if (!profile) return c.json({ error: "User profile not found." }, 404);

      // 2. Load integration flags
      const flags = await deps.loadIntegrationFlags(userId);

      // 3. Build PromptConfig from profile + flags
      const promptConfig: PromptConfig = {
        userName:        profile.display_name,
        userTimezone:    profile.timezone,
        profileContext:  profile.profile_md,
        tavilyEnabled:   flags.tavilyEnabled,
        gmailEnabled:    flags.gmailEnabled,
        calendarEnabled: flags.calendarEnabled,
        notionEnabled:   flags.notionEnabled,
        vapiEnabled:     flags.vapiEnabled,
      };

      // 4. Load conversation history
      const contextId = buildContextId(userId, thread_id);
      const history = await deps.fetchHistory(userId, contextId, profile.max_history);

      // 5. Optional web search
      let searchResults: string | undefined;
      if (profile.web_search && flags.tavilyEnabled && needsWebSearch(content)) {
        try {
          searchResults = await deps.runWebSearch?.(content, userId);
        } catch (err: any) {
          console.warn("Web search failed:", err.message);
        }
      }

      // 6. Memory context
      const [memoryContext, relevantContext] = await Promise.all([
        deps.fetchMemoryContext(userId),
        deps.fetchRelevantContext(userId, content),
      ]);

      // 7. Build prompt
      const prompt = buildPrompt(content, promptConfig, {
        memoryContext,
        relevantContext,
        searchResults,
      });

      // 8. Call Groq
      let rawResponse: string;
      try {
        rawResponse = await deps.groqCall(prompt, {
          history,
          model: profile.ai_model,
          apiKey: flags.groqApiKey,
        });
      } catch (err: any) {
        console.error("Groq call failed:", err.message);
        return c.json({ error: "AI service unavailable. Please try again." }, 503);
      }

      // 9. Parse action intent
      const { clean: reply, action } = parseActionIntent(rawResponse);

      // 10. Store pending action if found
      let action_id: string | undefined;
      if (action) {
        try {
          action_id = await deps.storePendingAction(userId, action);
        } catch (err: any) {
          console.error("Failed to store pending action:", err.message);
          // Non-fatal — reply still goes back without the action
        }
      }

      // 11. Persist messages (fire-and-forget with Redis retry queue on failure)
      // Each save is attempted independently so a failure on one doesn't abort
      // the others. On failure, the message is pushed to the Redis retry queue
      // (if REDIS_URL is set) rather than silently dropped.
      const meta = { thread_id: thread_id ?? null, channel };
      const persistWithRetry = async (
        role: "user" | "assistant",
        msgContent: string,
        msgMeta: Record<string, unknown>
      ): Promise<void> => {
        try {
          await deps.persistMessage(userId, role, msgContent, msgMeta);
        } catch (err: any) {
          console.warn(`[messages] save failed, enqueuing for retry: ${err.message}`);
          if (deps.failedMessageEnqueue) {
            await deps.failedMessageEnqueue(userId, role, msgContent, msgMeta)
              .catch((qErr) => console.error("[messages] enqueue failed:", qErr.message));
          }
        }
      };

      Promise.all([
        persistWithRetry("user", content, meta),
        persistWithRetry("assistant", reply, { ...meta, has_action: !!action }),
        deps.persistMemoryIntents(userId, rawResponse).catch(
          (err) => console.error("[messages] persistMemoryIntents failed:", err.message)
        ),
      ]).catch(() => {}); // individual errors already handled above

      return c.json({
        reply,
        ...(action_id && {
          action_id,
          action_description: action!.description,
        }),
      });
    }
  );

  // ── GET /api/messages/history ─────────────────────────────────────────────

  messages.get("/history", async (c) => {
    const userId = c.get("userId");
    const thread_id = c.req.query("thread_id");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);

    const contextId = buildContextId(userId, thread_id);
    try {
      const history = await deps.fetchHistory(userId, contextId, limit);
      return c.json(history);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  return messages;
}

export default createMessageRoutes();
