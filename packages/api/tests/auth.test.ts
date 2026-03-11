/**
 * Auth route tests — fully offline, no real Supabase calls.
 *
 * Uses createAuthRoutes() with injected mock deps so every test exercises
 * the real production route handlers in src/routes/auth.ts.
 */

import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";
import { createAuthRoutes, type AuthDeps } from "../src/routes/auth.ts";

// ── Mock factories ─────────────────────────────────────────────────────────────

function makeAnonClient(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      signInWithOtp: mock(async () => ({ error: null })),
      exchangeCodeForSession: mock(async () => ({
        data: {
          session: {
            access_token: "access-tok",
            refresh_token: "refresh-tok",
            expires_in: 3600,
          },
          user: { id: "user-uuid", email: "alice@example.com", user_metadata: {} },
        },
        error: null,
      })),
      refreshSession: mock(async () => ({
        data: {
          session: {
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          },
        },
        error: null,
      })),
      ...overrides,
    },
  };
}

function makeServiceClient() {
  return {
    from: () => ({
      upsert: mock(async () => ({ error: null })),
    }),
  };
}

function makeUserScopedClient(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      signOut: mock(async () => ({ error: null })),
      ...overrides,
    },
  };
}

// ── App builder ────────────────────────────────────────────────────────────────

function buildApp(
  anonOverrides: Record<string, unknown> = {},
  depsOverrides: Partial<AuthDeps> = {}
) {
  const anonClient = makeAnonClient(anonOverrides);
  const serviceClient = makeServiceClient();
  const userScopedClient = makeUserScopedClient();

  const deps: AuthDeps = {
    getAnonClient: () => anonClient as any,
    getServiceClient: () => serviceClient as any,
    createUserScopedClient: () => userScopedClient as any,
    ...depsOverrides,
  };

  const app = new Hono();
  app.route("/auth", createAuthRoutes(deps));

  return { app, anonClient, serviceClient, userScopedClient };
}

// ── POST /auth/magic-link ─────────────────────────────────────────────────────

describe("POST /auth/magic-link", () => {
  test("returns 200 with confirmation message for valid email", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("Check your email");
  });

  test("returns 400 for missing email", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid email format", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "notanemail" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 500 when Supabase returns an error", async () => {
    const { app } = buildApp({
      signInWithOtp: mock(async () => ({ error: { message: "rate limited" } })),
    });
    const res = await app.request("/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    expect(res.status).toBe(500);
  });
});

// ── GET /auth/callback ────────────────────────────────────────────────────────

describe("GET /auth/callback", () => {
  test("sets HttpOnly cookies and returns user info (no tokens in body)", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/callback?code=valid-code-123");
    expect(res.status).toBe(200);

    const body = await res.json();
    // Tokens must NOT appear in the response body
    expect((body as any).access_token).toBeUndefined();
    expect((body as any).refresh_token).toBeUndefined();
    // User identity and expiry are safe to expose
    expect(body.user.email).toBe("alice@example.com");
    expect(body.expires_in).toBe(3600);

    // Access token set as HttpOnly cookie
    const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
    const allCookies = cookies.join("; ");
    expect(allCookies).toContain("at=access-tok");
    expect(allCookies).toContain("HttpOnly");
    // Refresh token also set as HttpOnly cookie
    expect(allCookies).toContain("rt=refresh-tok");
  });

  test("defaults next to / when redirect target is external (H3 open-redirect prevention)", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/callback?code=valid-code-123&next=https://evil.com/steal");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.next).toBe("/");
  });

  test("defaults next to / for protocol-relative redirect (H3)", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/callback?code=valid-code-123&next=//evil.com");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.next).toBe("/");
  });

  test("preserves valid relative next param", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/callback?code=valid-code-123&next=/dashboard");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.next).toBe("/dashboard");
  });

  test("returns 400 when code is missing", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/callback");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing code");
  });

  test("returns 400 when Supabase exchange fails", async () => {
    const { app } = buildApp({
      exchangeCodeForSession: mock(async () => ({
        data: { session: null, user: null },
        error: { message: "invalid code" },
      })),
    });
    const res = await app.request("/auth/callback?code=bad-code");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid or expired");
  });
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────

describe("POST /auth/refresh", () => {
  test("sets new cookies and returns expires_in (no tokens in body) — body token", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: "old-refresh-tok" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Tokens must NOT appear in the response body
    expect((body as any).access_token).toBeUndefined();
    expect((body as any).refresh_token).toBeUndefined();
    expect(body.expires_in).toBe(3600);
    // New tokens set as cookies
    const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
    expect(cookies.join("; ")).toContain("at=new-access");
  });

  test("accepts refresh token from rt cookie (browser flow)", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": "rt=cookie-refresh-tok",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expires_in).toBe(3600);
  });

  test("returns 401 when no token provided at all", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 when token is invalid", async () => {
    const { app } = buildApp({
      refreshSession: mock(async () => ({
        data: { session: null },
        error: { message: "invalid token" },
      })),
    });
    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: "expired" }),
    });
    expect(res.status).toBe(401);
  });
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────

describe("POST /auth/logout", () => {
  test("logs out and clears cookies — Bearer token", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Logged out.");
    // Both cookies cleared (Max-Age=0)
    const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
    const allCookies = cookies.join("; ");
    expect(allCookies).toContain("at=");
    expect(allCookies).toContain("Max-Age=0");
  });

  test("logs out and clears cookies — at cookie", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: "at=some-valid-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Logged out.");
  });

  test("returns 401 without any token or cookie", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/logout", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("returns 401 with malformed Authorization header", async () => {
    const { app } = buildApp();
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Authorization: "Basic sometoken" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 500 when Supabase signOut fails", async () => {
    const { app } = buildApp({}, {
      createUserScopedClient: () => ({
        auth: {
          signOut: mock(async () => ({ error: { message: "server error" } })),
        },
      }) as any,
    });
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { Authorization: "Bearer valid-token" },
    });
    expect(res.status).toBe(500);
  });
});
