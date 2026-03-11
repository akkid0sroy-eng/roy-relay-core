/**
 * Tests for loadUserIntegrations().
 *
 * All external calls are injected via deps — no DB, no HTTP, no googleapis.
 * The tests verify the wiring logic: which loaders are populated, whether they
 * return the right shape, and that the auth client is shared between Gmail and Calendar.
 */

import { describe, expect, test, mock } from "bun:test";
import { loadUserIntegrations } from "../src/db/load-integrations.ts";
import type { GoogleSecrets } from "../src/services/google-auth.ts";
import { generateKey } from "../src/services/encrypt.ts";

// Encryption key required by makeTokenRefresher → encryptJson
process.env.ENCRYPTION_KEY = generateKey();
// Suppress the real DB client from trying to connect
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GOOGLE_SECRETS: GoogleSecrets = {
  access_token: "ya29.access",
  refresh_token: "1//refresh",
  expiry_date: Date.now() + 3_600_000, // valid for 1 hour
  client_id: "client-id",
  client_secret: "client-secret",
};

const NOTION_SECRETS = {
  token: "secret_notion",
  databases: {
    tasks: { id: "db-uuid-1", description: "Task tracker" },
  },
};

const VAPI_SECRETS = {
  api_key: "vapi-key",
  phone_number_id: "ph-uuid",
  destination_phone: "+14155551234",
};

// Mock auth client — tracks how many times it was built
function makeMockAuthClient() {
  let buildCount = 0;
  const authClient = { _type: "mock-oauth2-client" };
  const buildAuthClient = mock(async () => {
    buildCount++;
    return authClient as any;
  });
  return { buildAuthClient, getCount: () => buildCount, authClient };
}

// ── No integrations ───────────────────────────────────────────────────────────

describe("loadUserIntegrations — no integrations", () => {
  test("returns empty loaders when user has no integrations", async () => {
    const loaders = await loadUserIntegrations("user-1", "America/New_York", {
      fetchSecrets: async () => null,
    });
    expect(loaders.loadGmail).toBeUndefined();
    expect(loaders.loadCalendar).toBeUndefined();
    expect(loaders.loadNotion).toBeUndefined();
    expect(loaders.loadVapi).toBeUndefined();
  });
});

// ── Google (Gmail + Calendar) ─────────────────────────────────────────────────

describe("loadUserIntegrations — Google", () => {
  function makeGoogleDeps() {
    const { buildAuthClient, getCount, authClient } = makeMockAuthClient();
    const deps = {
      fetchSecrets: async <T>(_userId: string, provider: string) => {
        if (provider === "google") return GOOGLE_SECRETS as T;
        return null;
      },
      buildAuthClient,
    };
    return { deps, getCount, authClient };
  }

  test("loadGmail is defined when google secrets exist", async () => {
    const { deps } = makeGoogleDeps();
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    expect(loaders.loadGmail).toBeDefined();
  });

  test("loadCalendar is defined when google secrets exist", async () => {
    const { deps } = makeGoogleDeps();
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    expect(loaders.loadCalendar).toBeDefined();
  });

  test("loadGmail returns gmailEnabled: true", async () => {
    const { deps } = makeGoogleDeps();
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    const gmail = await loaders.loadGmail!();
    expect(gmail.gmailEnabled).toBe(true);
    expect(typeof gmail.sendEmail).toBe("function");
  });

  test("loadCalendar returns calendarEnabled: true", async () => {
    const { deps } = makeGoogleDeps();
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    const cal = await loaders.loadCalendar!();
    expect(cal.calendarEnabled).toBe(true);
    expect(typeof cal.createCalendarEvent).toBe("function");
  });

  test("auth client is built only once even when both Gmail and Calendar call it", async () => {
    const { deps, getCount } = makeGoogleDeps();
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    await loaders.loadGmail!();
    await loaders.loadCalendar!();
    // Both loaders share the same lazy promise — auth should be built exactly once
    expect(getCount()).toBe(1);
  });

  test("calling loadGmail multiple times does not rebuild the auth client", async () => {
    const { deps, getCount } = makeGoogleDeps();
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    await loaders.loadGmail!();
    await loaders.loadGmail!();
    await loaders.loadGmail!();
    expect(getCount()).toBe(1);
  });

  test("loadNotion and loadVapi are absent when only google secrets exist", async () => {
    const { deps } = makeGoogleDeps();
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    expect(loaders.loadNotion).toBeUndefined();
    expect(loaders.loadVapi).toBeUndefined();
  });
});

// ── Notion ────────────────────────────────────────────────────────────────────

describe("loadUserIntegrations — Notion", () => {
  const deps = {
    fetchSecrets: async <T>(_userId: string, provider: string) => {
      if (provider === "notion") return NOTION_SECRETS as T;
      return null;
    },
  };

  test("loadNotion is defined when notion secrets exist", async () => {
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    expect(loaders.loadNotion).toBeDefined();
  });

  test("loadNotion returns notionEnabled: true and createNotionPage function", async () => {
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    const notion = await loaders.loadNotion!();
    expect(notion.notionEnabled).toBe(true);
    expect(typeof notion.createNotionPage).toBe("function");
  });

  test("loadGmail, loadCalendar, loadVapi are absent when only notion configured", async () => {
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    expect(loaders.loadGmail).toBeUndefined();
    expect(loaders.loadCalendar).toBeUndefined();
    expect(loaders.loadVapi).toBeUndefined();
  });
});

// ── VAPI ──────────────────────────────────────────────────────────────────────

describe("loadUserIntegrations — VAPI", () => {
  const deps = {
    fetchSecrets: async <T>(_userId: string, provider: string) => {
      if (provider === "vapi") return VAPI_SECRETS as T;
      return null;
    },
  };

  test("loadVapi is defined when vapi secrets exist", async () => {
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    expect(loaders.loadVapi).toBeDefined();
  });

  test("loadVapi returns vapiEnabled: true and makeVapiCall function", async () => {
    const loaders = await loadUserIntegrations("user-1", "UTC", deps);
    const vapi = await loaders.loadVapi!();
    expect(vapi.vapiEnabled).toBe(true);
    expect(typeof vapi.makeVapiCall).toBe("function");
  });
});

// ── All integrations ──────────────────────────────────────────────────────────

describe("loadUserIntegrations — all integrations configured", () => {
  const { buildAuthClient } = makeMockAuthClient();
  const deps = {
    fetchSecrets: async <T>(_userId: string, provider: string): Promise<T | null> => {
      if (provider === "google") return GOOGLE_SECRETS as T;
      if (provider === "notion") return NOTION_SECRETS as T;
      if (provider === "vapi")   return VAPI_SECRETS as T;
      return null;
    },
    buildAuthClient,
  };

  test("all four loaders are defined", async () => {
    const loaders = await loadUserIntegrations("user-1", "America/New_York", deps);
    expect(loaders.loadGmail).toBeDefined();
    expect(loaders.loadCalendar).toBeDefined();
    expect(loaders.loadNotion).toBeDefined();
    expect(loaders.loadVapi).toBeDefined();
  });

  test("timezone is threaded through to calendar loader", async () => {
    const tz = "Europe/Berlin";
    // We can't easily inspect what timezone was passed internally, but we can
    // verify the loader resolves without throwing when timezone is provided
    const loaders = await loadUserIntegrations("user-1", tz, deps);
    const cal = await loaders.loadCalendar!();
    expect(cal.calendarEnabled).toBe(true);
  });
});
