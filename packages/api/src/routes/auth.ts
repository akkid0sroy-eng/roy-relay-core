/**
 * Auth routes — passwordless magic-link flow via Supabase Auth.
 *
 * POST /auth/magic-link   Send a sign-in link to an email address
 * GET  /auth/callback     Exchange the one-time code for a session
 * POST /auth/refresh      Refresh an expired access token
 * POST /auth/logout       Invalidate the current session
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { createClient } from "@supabase/supabase-js";
import { getAnonClient, getServiceClient } from "../db/client.ts";

// ── Cookie helpers ─────────────────────────────────────────────────────────────

const SECURE = process.env.NODE_ENV === "production";

function setAuthCookies(c: Parameters<typeof setCookie>[0], accessToken: string, refreshToken: string, expiresIn: number) {
  setCookie(c, "at", accessToken, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "Strict",
    maxAge: expiresIn,
    path: "/",
  });
  setCookie(c, "rt", refreshToken, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "Strict",
    maxAge: 30 * 24 * 60 * 60, // 30 days
    path: "/auth",              // sent only to /auth/* — not on every API request
  });
}

function clearAuthCookies(c: Parameters<typeof setCookie>[0]) {
  deleteCookie(c, "at", { path: "/" });
  deleteCookie(c, "rt", { path: "/auth" });
}

// ── Dependency injection ───────────────────────────────────────────────────────

type AnonClient = {
  auth: {
    signInWithOtp: (params: { email: string; options?: { data?: Record<string, string> } }) => Promise<{ error: { message: string } | null }>;
    exchangeCodeForSession: (code: string) => Promise<{
      data: {
        session: { access_token: string; refresh_token: string; expires_in: number } | null;
        user: { id: string; email?: string; user_metadata?: Record<string, string> } | null;
      };
      error: { message: string } | null;
    }>;
    refreshSession: (params: { refresh_token: string }) => Promise<{
      data: { session: { access_token: string; refresh_token: string; expires_in: number } | null };
      error: { message: string } | null;
    }>;
  };
};

type ServiceClient = {
  from: (table: string) => {
    upsert: (data: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => Promise<{ error: { message: string } | null }>;
  };
};

type UserScopedClient = {
  auth: {
    signOut: () => Promise<{ error: { message: string } | null }>;
  };
};

export interface AuthDeps {
  getAnonClient: () => AnonClient;
  getServiceClient: () => ServiceClient;
  /** Creates a Supabase client authenticated as the given user (for signOut). */
  createUserScopedClient: (token: string) => UserScopedClient;
}

// ── Route factory ──────────────────────────────────────────────────────────────

export function createAuthRoutes(deps: AuthDeps): Hono {
  const auth = new Hono();

  // ── POST /auth/magic-link ───────────────────────────────────────────────────

  auth.post(
    "/magic-link",
    zValidator(
      "json",
      z.object({
        email: z.string().email(),
        /** Optional: bind a Telegram user ID to this account at sign-up time */
        telegram_id: z.string().optional(),
        /** Optional: bind a WhatsApp phone number to this account at sign-up time */
        whatsapp_phone: z.string().optional(),
      })
    ),
    async (c) => {
      const { email, telegram_id, whatsapp_phone } = c.req.valid("json");
      const supabase = deps.getAnonClient();

      // Build metadata — only include fields that were provided
      const meta: Record<string, string> = {};
      if (telegram_id)    meta.telegram_id    = telegram_id;
      if (whatsapp_phone) meta.whatsapp_phone = whatsapp_phone;

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          // Store channel IDs in auth metadata so the callback can copy them
          // to user_profiles without a separate API call
          data: Object.keys(meta).length > 0 ? meta : undefined,
        },
      });

      if (error) {
        console.error("magic-link error:", error.message);
        return c.json({ error: "Failed to send magic link." }, 500);
      }

      return c.json({ message: "Check your email for a sign-in link." });
    }
  );

  // ── GET /auth/callback ──────────────────────────────────────────────────────

  auth.get("/callback", async (c) => {
    const code = c.req.query("code");
    // Validate next is a relative path — prevent open redirect to external URLs.
    // "/" and "/dashboard" are fine; "//evil.com" and "https://evil.com" are not.
    const rawNext = c.req.query("next") ?? "/";
    const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

    if (!code) {
      return c.json({ error: "Missing code parameter." }, 400);
    }

    const supabase = deps.getAnonClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error || !data.session) {
      console.error("callback exchange error:", error?.message);
      return c.json({ error: "Invalid or expired code." }, 400);
    }

    const { user, session } = data;

    // Upsert user_profiles row — creates on first login, updates channel IDs if provided.
    // Only include fields that are actually present in auth metadata — never overwrite
    // an existing telegram_id or whatsapp_phone with null on a plain re-login.
    const db = deps.getServiceClient();
    const profileData: Record<string, unknown> = {
      user_id:    user!.id,
      updated_at: new Date().toISOString(),
    };
    if (user!.user_metadata?.telegram_id)    profileData.telegram_id    = user!.user_metadata.telegram_id;
    if (user!.user_metadata?.whatsapp_phone) profileData.whatsapp_phone = user!.user_metadata.whatsapp_phone;

    await db.from("user_profiles").upsert(profileData, {
      onConflict: "user_id",
      ignoreDuplicates: false,
    });

    // Set tokens as HttpOnly cookies — never expose them in the response body.
    setAuthCookies(c, session.access_token, session.refresh_token, session.expires_in);

    // Return only non-sensitive session metadata and user identity.
    return c.json({
      user:       { id: user!.id, email: user!.email },
      expires_in: session.expires_in,
      next,
    });
  });

  // ── POST /auth/refresh ──────────────────────────────────────────────────────

  auth.post(
    "/refresh",
    zValidator("json", z.object({ refresh_token: z.string().optional() })),
    async (c) => {
      // Browser clients send the rt cookie automatically (path="/auth").
      // API / mobile clients may pass the token explicitly in the request body.
      const body = c.req.valid("json");
      const refreshToken = body.refresh_token ?? getCookie(c, "rt");

      if (!refreshToken) {
        return c.json({ error: "No refresh token provided." }, 401);
      }

      const supabase = deps.getAnonClient();
      const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });

      if (error || !data.session) {
        return c.json({ error: "Invalid or expired refresh token." }, 401);
      }

      setAuthCookies(c, data.session.access_token, data.session.refresh_token, data.session.expires_in);

      // Tokens are in cookies — return only the expiry so clients can schedule
      // the next refresh without reading the token value.
      return c.json({ expires_in: data.session.expires_in });
    }
  );

  // ── POST /auth/logout ───────────────────────────────────────────────────────

  auth.post("/logout", async (c) => {
    // Accept token from Authorization header (API/mobile) or at cookie (browser).
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : getCookie(c, "at");

    if (!token) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const userClient = deps.createUserScopedClient(token);
    const { error } = await userClient.auth.signOut();

    if (error) {
      console.error("logout error:", error.message);
      return c.json({ error: "Logout failed." }, 500);
    }

    // Clear both session cookies regardless of whether a Bearer header was used.
    clearAuthCookies(c);
    return c.json({ message: "Logged out." });
  });

  return auth;
}

// ── Default export with real Supabase implementations ─────────────────────────

export default createAuthRoutes({
  getAnonClient,
  getServiceClient,
  createUserScopedClient: (token) =>
    createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    ),
});
