/**
 * Auth middleware — verifies the Supabase JWT via the Supabase Auth API
 * and injects userId + userEmail into the Hono context.
 */

import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { createClient } from "@supabase/supabase-js";
import { getServiceClient } from "../db/client.ts";

const _authClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Extend Hono's context variable types
declare module "hono" {
  interface ContextVariableMap {
    userId: string;
    userEmail: string;
    userPlan: "free" | "pro" | "team";
  }
}

export const authMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : getCookie(c, "at");

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { data: { user }, error } = await _authClient.auth.getUser(token);
  if (error || !user) {
    console.error("[auth] getUser failed:", error?.message ?? "no user");
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Load plan tier
  const db = getServiceClient();
  const { data: profile } = await db
    .from("user_profiles")
    .select("plan")
    .eq("user_id", user.id)
    .single();

  c.set("userId", user.id);
  c.set("userEmail", user.email ?? "");
  c.set("userPlan", (profile?.plan as "free" | "pro" | "team") ?? "free");

  await next();
});
