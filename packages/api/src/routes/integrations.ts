/**
 * Integration routes — connect, list, and disconnect third-party providers.
 *
 * GET    /api/integrations                          List all (no secrets)
 * GET    /api/integrations/:provider/status         Connection status
 * GET    /api/integrations/google/auth-url          Get OAuth URL to open in browser
 * POST   /api/integrations/google/connect           Exchange OAuth code → store tokens
 * POST   /api/integrations/notion/connect           Validate + store Notion token
 * POST   /api/integrations/vapi/connect             Validate + store VAPI credentials
 * POST   /api/integrations/:provider/connect        Generic API-key providers
 * DELETE /api/integrations/:provider                Disconnect (deletes row)
 *
 * The route factory accepts an optional validators argument so tests can
 * inject mocks without any real HTTP calls.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  listIntegrations,
  getIntegration,
  upsertIntegration,
  deleteIntegration,
  type Provider,
  type IntegrationRow,
} from "../db/integrations.ts";
import {
  defaultValidators,
  buildGoogleAuthUrl,
  type IntegrationValidators,
} from "../services/integration-validators.ts";
import type { NotionDatabasesMap } from "@relay/core";

// Injectable DB operations — lets tests use an in-memory store
export interface IntegrationDb {
  list(userId: string): Promise<IntegrationRow[]>;
  get(userId: string, provider: Provider): Promise<IntegrationRow | null>;
  upsert(userId: string, provider: Provider, secrets: unknown, meta: Record<string, unknown>): Promise<IntegrationRow>;
  delete(userId: string, provider: Provider): Promise<void>;
}

const defaultDb: IntegrationDb = {
  list: listIntegrations,
  get: getIntegration,
  upsert: upsertIntegration,
  delete: deleteIntegration,
};

export function createIntegrationRoutes(
  validators: IntegrationValidators = defaultValidators,
  db: IntegrationDb = defaultDb
): Hono {
  const integrations = new Hono();

  // ── GET /api/integrations ───────────────────────────────────────────────────

  integrations.get("/", async (c) => {
    const userId = c.get("userId");
    try {
      const rows = await db.list(userId);
      return c.json(rows);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── GET /api/integrations/:provider/status ──────────────────────────────────

  integrations.get("/:provider/status", async (c) => {
    const userId = c.get("userId");
    const provider = c.req.param("provider") as Provider;
    try {
      const row = await db.get(userId, provider);
      return c.json({
        provider,
        connected: !!row,
        enabled: row?.enabled ?? false,
        meta: row?.meta ?? {},
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── Shared redirect_uri validator ────────────────────────────────────────────
  // Used by both /google/auth-url (generates the URL) and /google/connect (exchanges the code).
  // Origin comparison prevents open-redirect and code-harvesting via a malicious redirect target.
  // startsWith() is deliberately avoided — "https://api.example.com.evil.com" would pass it.

  function isAllowedRedirectUri(uri: string): boolean {
    const apiBase = process.env.API_BASE_URL;
    if (!apiBase) return false;
    try {
      return new URL(apiBase).origin === new URL(uri).origin;
    } catch {
      return false;
    }
  }

  // ── GET /api/integrations/google/auth-url ───────────────────────────────────

  integrations.get("/google/auth-url", (c) => {
    const redirectUri = c.req.query("redirect_uri");
    if (!redirectUri)
      return c.json({ error: "redirect_uri query param is required." }, 400);

    if (!isAllowedRedirectUri(redirectUri)) {
      return c.json({ error: "redirect_uri is not allowed." }, 400);
    }

    try {
      const url = buildGoogleAuthUrl(redirectUri);
      return c.json({ url });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── POST /api/integrations/google/connect ───────────────────────────────────

  integrations.post(
    "/google/connect",
    zValidator(
      "json",
      z.object({
        code: z.string().min(1),
        redirect_uri: z.string().url(),
      })
    ),
    async (c) => {
      const userId = c.get("userId");
      const { code, redirect_uri } = c.req.valid("json");
      if (!isAllowedRedirectUri(redirect_uri)) {
        return c.json({ error: "redirect_uri is not allowed." }, 400);
      }
      try {
        const { secrets, meta } = await validators.validateGoogle(code, redirect_uri);
        const row = await db.upsert(userId, "google", secrets, meta);
        return c.json({ provider: "google", enabled: row.enabled, meta: row.meta });
      } catch (err: any) {
        return c.json({ error: err.message }, 422);
      }
    }
  );

  // ── POST /api/integrations/notion/connect ───────────────────────────────────

  integrations.post(
    "/notion/connect",
    zValidator(
      "json",
      z.object({
        token: z.string().min(1),
        /** Optional pre-configured databases map */
        databases: z.record(z.unknown()).optional(),
      })
    ),
    async (c) => {
      const userId = c.get("userId");
      const { token, databases } = c.req.valid("json");
      try {
        const { meta } = await validators.validateNotion(token);
        const secrets = { token, databases: (databases ?? {}) as NotionDatabasesMap };
        const row = await db.upsert(userId, "notion", secrets, {
          ...meta,
          database_count: Object.keys(databases ?? {}).length,
        });
        return c.json({ provider: "notion", enabled: row.enabled, meta: row.meta });
      } catch (err: any) {
        return c.json({ error: err.message }, 422);
      }
    }
  );

  // ── POST /api/integrations/vapi/connect ─────────────────────────────────────

  integrations.post(
    "/vapi/connect",
    zValidator(
      "json",
      z.object({
        api_key: z.string().min(1),
        phone_number_id: z.string().min(1),
        destination_phone: z.string().min(7),
      })
    ),
    async (c) => {
      const userId = c.get("userId");
      const body = c.req.valid("json");
      try {
        const ok = await validators.validateVapi(body.api_key, body.phone_number_id);
        if (!ok) return c.json({ error: "VAPI credentials are invalid." }, 422);
        const row = await db.upsert(userId, "vapi", body, {
          phone_number_id: body.phone_number_id,
        });
        return c.json({ provider: "vapi", enabled: row.enabled, meta: row.meta });
      } catch (err: any) {
        return c.json({ error: err.message }, 422);
      }
    }
  );

  // ── POST /api/integrations/:provider/connect (generic API-key providers) ────
  // Handles: elevenlabs, tavily, groq

  const genericSchema = z.object({ api_key: z.string().min(1) });
  const genericProviders: Provider[] = ["elevenlabs", "tavily", "groq"];

  integrations.post(
    "/:provider/connect",
    zValidator("json", genericSchema),
    async (c) => {
      const provider = c.req.param("provider") as Provider;
      if (!genericProviders.includes(provider)) {
        return c.json({ error: `Unknown provider: ${provider}` }, 400);
      }

      const userId = c.get("userId");
      const { api_key } = c.req.valid("json");

      try {
        let valid = false;
        if (provider === "elevenlabs") valid = await validators.validateElevenLabs(api_key);
        else if (provider === "tavily")    valid = await validators.validateTavily(api_key);
        else if (provider === "groq")      valid = await validators.validateGroq(api_key);

        if (!valid) return c.json({ error: `Invalid ${provider} API key.` }, 422);

        const row = await db.upsert(userId, provider, { api_key }, {});
        return c.json({ provider, enabled: row.enabled, meta: row.meta });
      } catch (err: any) {
        return c.json({ error: err.message }, 422);
      }
    }
  );

  // ── DELETE /api/integrations/:provider ─────────────────────────────────────

  integrations.delete("/:provider", async (c) => {
    const userId = c.get("userId");
    const provider = c.req.param("provider") as Provider;
    try {
      await db.delete(userId, provider);
      return c.json({ provider, connected: false });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  return integrations;
}

/** Default export uses real validators — imported by index.ts */
export default createIntegrationRoutes();
