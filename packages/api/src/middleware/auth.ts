/**
 * Auth middleware — verifies the Supabase JWT locally (no network call) and
 * injects userId + userEmail into the Hono context.
 *
 * Supabase issues HS256 JWTs signed with SUPABASE_JWT_SECRET. We verify the
 * signature and expiry using Node.js crypto — one DB round-trip (for the plan
 * tier) instead of one Auth API call + one DB call.
 *
 * Falls back to the at cookie for browser clients that don't send a Bearer header.
 */

import { createMiddleware } from "hono/factory";
import { createHmac, timingSafeEqual } from "crypto";
import { getCookie } from "hono/cookie";
import { getServiceClient } from "../db/client.ts";

// Extend Hono's context variable types
declare module "hono" {
  interface ContextVariableMap {
    userId: string;
    userEmail: string;
    userPlan: "free" | "pro" | "team";
  }
}

// ── Local JWT verification ─────────────────────────────────────────────────────

interface JwtClaims {
  sub: string;
  email?: string;
  exp: number;
  role?: string;
  aud?: string | string[];
}

/**
 * Verify a Supabase HS256 JWT without a network call.
 * Returns the claims on success, null on invalid/expired token.
 */
function verifySupabaseJwt(token: string, secret: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header64, payload64, sig64] = parts;

  // Verify HMAC-SHA256 signature
  const expected = createHmac("sha256", secret)
    .update(`${header64}.${payload64}`)
    .digest("base64url");

  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig64))) return null;
  } catch {
    return null; // length mismatch — definitely wrong
  }

  // Parse and validate claims
  let claims: JwtClaims;
  try {
    claims = JSON.parse(Buffer.from(payload64, "base64url").toString());
  } catch {
    return null;
  }

  if (!claims.sub) return null;
  if (claims.exp < Date.now() / 1000) return null; // expired

  // Validate audience — Supabase user tokens carry aud: "authenticated".
  // Reject service_role tokens and tokens from other projects.
  const aud = claims.aud;
  const audList = Array.isArray(aud) ? aud : (aud ? [aud] : []);
  if (!audList.includes("authenticated")) return null;

  return claims;
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export const authMiddleware = createMiddleware(async (c, next) => {
  // Prefer Authorization: Bearer header (API / mobile clients).
  // Fall back to the at cookie set by /auth/callback (browser clients).
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : getCookie(c, "at");

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    console.error("SUPABASE_JWT_SECRET is not set — cannot verify tokens.");
    return c.json({ error: "Server misconfiguration." }, 500);
  }

  const claims = verifySupabaseJwt(token, jwtSecret);
  if (!claims) {
    // Debug: decode payload to see why verification failed
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      console.error("[auth] JWT rejected — payload:", JSON.stringify({ sub: payload.sub, aud: payload.aud, exp: payload.exp, now: Math.floor(Date.now()/1000) }));
    } catch { console.error("[auth] JWT rejected — could not decode payload"); }
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Load plan tier — needed by rate-limit middleware
  const db = getServiceClient();
  const { data: profile } = await db
    .from("user_profiles")
    .select("plan")
    .eq("user_id", claims.sub)
    .single();

  c.set("userId", claims.sub);
  c.set("userEmail", claims.email ?? "");
  c.set("userPlan", (profile?.plan as "free" | "pro" | "team") ?? "free");

  await next();
});
