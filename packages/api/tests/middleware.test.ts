/**
 * Auth middleware tests — verifies JWT validation including audience claim.
 *
 * Uses Node.js crypto to mint test JWTs signed with the same HS256 algorithm
 * as Supabase, so we can test the full middleware path offline.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { createHmac } from "crypto";
import { Hono } from "hono";
import { authMiddleware } from "../src/middleware/auth.ts";

// ── JWT test helpers ───────────────────────────────────────────────────────────

const TEST_SECRET = "test-supabase-jwt-secret-32bytes!";

function signJwt(payload: Record<string, unknown>, secret = TEST_SECRET): string {
  const header  = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body    = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig     = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: "user-uuid",
    email: "alice@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    aud: "authenticated",
    role: "authenticated",
    ...overrides,
  };
}

// ── App builder ────────────────────────────────────────────────────────────────

function buildApp() {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;

  const app = new Hono();

  // Mount auth middleware + a simple protected route
  app.use("/protected", authMiddleware);
  app.get("/protected", (c) => c.json({ userId: c.get("userId") }));

  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("auth middleware — JWT audience validation", () => {
  test("accepts token with aud: 'authenticated'", async () => {
    const app   = buildApp();
    const token = signJwt(validClaims());
    const res   = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Note: authMiddleware makes a DB call for userPlan — it will error here
    // since there's no real Supabase client. We only care it gets past JWT validation.
    // A 500 from DB is fine; a 401 means JWT was rejected.
    expect(res.status).not.toBe(401);
  });

  test("rejects token with aud: 'service_role'", async () => {
    const app   = buildApp();
    const token = signJwt(validClaims({ aud: "service_role" }));
    const res   = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects token with no aud claim", async () => {
    const app   = buildApp();
    const { aud: _omit, ...claims } = validClaims();
    const token = signJwt(claims);
    const res   = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects token with wrong signature", async () => {
    const app   = buildApp();
    const token = signJwt(validClaims(), "wrong-secret-entirely");
    const res   = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects expired token", async () => {
    const app   = buildApp();
    const token = signJwt(validClaims({ exp: Math.floor(Date.now() / 1000) - 60 }));
    const res   = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects token with aud as array not containing 'authenticated'", async () => {
    const app   = buildApp();
    const token = signJwt(validClaims({ aud: ["realtime", "storage"] }));
    const res   = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("accepts token with aud as array containing 'authenticated'", async () => {
    const app   = buildApp();
    const token = signJwt(validClaims({ aud: ["authenticated", "realtime"] }));
    const res   = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).not.toBe(401);
  });

  test("returns 401 without any token", async () => {
    const app = buildApp();
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
  });
});
