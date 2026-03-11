/**
 * User profile routes — read and update the current user's settings.
 *
 * All routes require the authMiddleware to have run first (userId in context).
 *
 * GET    /api/users/me              Return the current user's profile
 * PATCH  /api/users/me              Update settings (timezone, profile_md, etc.)
 * DELETE /api/users/me              Permanently delete account + all data (GDPR Art.17)
 * GET    /api/users/me/agents       Return the thread → agent mapping
 * PATCH  /api/users/me/agents       Register or unregister a topic thread
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { deleteCookie } from "hono/cookie";
import { getServiceClient } from "../db/client.ts";

const users = new Hono();

// ── GET /api/users/me ─────────────────────────────────────────────────────────

users.get("/me", async (c) => {
  const userId = c.get("userId");
  const db = getServiceClient();

  const { data, error } = await db
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    return c.json({ error: "Profile not found." }, 404);
  }

  return c.json(data);
});

// ── PATCH /api/users/me ───────────────────────────────────────────────────────

export const updateSchema = z.object({
  display_name: z.string().max(100).optional(),
  timezone: z
    .string()
    .max(60)
    .refine((tz) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Invalid IANA timezone identifier")
    .optional(),
  profile_md:  z.string().max(10_000).optional(),
  voice_mode:  z.boolean().optional(),
  web_search:  z.boolean().optional(),
  // Validate model IDs to alphanumeric + hyphens/dots/colons — prevents garbage
  // values from silently causing every subsequent Groq call to fail.
  ai_model: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "Invalid model identifier")
    .optional(),
  max_history: z.number().int().min(1).max(50).optional(),
});

users.patch(
  "/me",
  zValidator("json", updateSchema),
  async (c) => {
    const userId = c.get("userId");
    const updates = c.req.valid("json");
    const db = getServiceClient();

    const { data, error } = await db
      .from("user_profiles")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .select()
      .single();

    if (error) {
      console.error("profile update error:", error.message);
      return c.json({ error: "Failed to update profile." }, 500);
    }

    return c.json(data);
  }
);

// ── DELETE /api/users/me ──────────────────────────────────────────────────────
// Permanently deletes the account (GDPR Article 17 — Right to Erasure).
//
// Sequence:
//   1. Best-effort: revoke live Google OAuth tokens so the grant is cleared on
//      Google's side even though our copy is about to be deleted.
//   2. Delete the Supabase Auth user — this cascades (via FK) to:
//        user_profiles → messages, memory, logs, user_integrations, pending_actions
//   3. Clear session cookies.
//   4. Return 204 No Content.

users.delete("/me", async (c) => {
  const userId = c.get("userId");
  const db = getServiceClient();

  // 1. Revoke Google OAuth — best-effort; never block deletion if this fails.
  try {
    const { getSecrets } = await import("../db/integrations.ts");
    const google = await getSecrets<{ access_token?: string; refresh_token?: string }>(
      userId,
      "google"
    );
    // Prefer revoking the refresh_token — it invalidates all derived access tokens.
    const tokenToRevoke = google?.refresh_token ?? google?.access_token;
    if (tokenToRevoke) {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }
      );
      // Non-2xx responses (e.g. already-expired tokens) are silently ignored —
      // the important thing is that the local secrets are about to be deleted.
    }
  } catch {
    // Non-fatal — proceed with local deletion even if revocation call fails.
  }

  // 2. Delete the Supabase Auth user.
  //    The FK cascade on user_profiles.user_id → auth.users.id removes the
  //    profile row and all child rows (messages, memory, integrations, actions).
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) {
    console.error("deleteUser auth error:", error.message);
    return c.json({ error: "Failed to delete account. Please try again." }, 500);
  }

  // 3. Clear session cookies — the tokens are now invalid server-side.
  deleteCookie(c, "at", { path: "/" });
  deleteCookie(c, "rt", { path: "/auth" });

  // 4. Respond with 204 No Content — nothing left to return.
  return c.body(null, 204);
});

// ── GET /api/users/me/agents ──────────────────────────────────────────────────

users.get("/me/agents", async (c) => {
  const userId = c.get("userId");
  const db = getServiceClient();

  const { data, error } = await db
    .from("user_profiles")
    .select("agent_topics")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    return c.json({ error: "Profile not found." }, 404);
  }

  return c.json(data.agent_topics ?? {});
});

// ── PATCH /api/users/me/agents ────────────────────────────────────────────────

const agentSchema = z.object({
  /** Telegram thread/topic ID */
  thread_id: z.string(),
  /** Agent key to register, or null to unregister */
  agent_key: z.enum(["general", "research", "content", "finance", "strategy", "critic"]).nullable(),
});

users.patch(
  "/me/agents",
  zValidator("json", agentSchema),
  async (c) => {
    const userId = c.get("userId");
    const { thread_id, agent_key } = c.req.valid("json");
    const db = getServiceClient();

    // Load current topics to do a safe merge
    const { data: current, error: fetchError } = await db
      .from("user_profiles")
      .select("agent_topics")
      .eq("user_id", userId)
      .single();

    if (fetchError || !current) {
      return c.json({ error: "Profile not found." }, 404);
    }

    const topics: Record<string, string | null> = current.agent_topics ?? {};

    if (agent_key === null) {
      delete topics[thread_id];
    } else {
      topics[thread_id] = agent_key;
    }

    const { data, error } = await db
      .from("user_profiles")
      .update({ agent_topics: topics, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .select("agent_topics")
      .single();

    if (error) {
      console.error("agent topics update error:", error.message);
      return c.json({ error: "Failed to update agent topics." }, 500);
    }

    return c.json(data.agent_topics);
  }
);

export default users;
