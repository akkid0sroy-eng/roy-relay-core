/**
 * loadUserIntegrations — the bridge between the encrypted DB and @relay/core.
 *
 * Reads enabled integrations for a user, decrypts their secrets, and returns
 * an IntegrationLoaders object that executeAction() from @relay/core accepts
 * directly. Each loader is lazy — it only builds the auth client when called.
 *
 * The optional `deps` argument enables full injection in tests without any
 * real DB calls or HTTP requests.
 */

import type { IntegrationLoaders, NotionDatabasesMap } from "@relay/core";
import { getSecrets, type Provider } from "./integrations.ts";
import {
  getPerUserAuthClient,
  type GoogleSecrets,
  type OnTokenRefresh,
} from "../services/google-auth.ts";
import { sendEmail } from "../services/gmail.ts";
import { createCalendarEvent } from "../services/calendar.ts";
import { createNotionPage } from "../services/notion.ts";
import { makeVapiCall, type VapiSecrets } from "../services/vapi.ts";
import { encryptJson, decryptJson } from "../services/encrypt.ts";
import { getServiceClient } from "./client.ts";

// ── Injected dependencies interface (for testing) ─────────────────────────────

export interface LoadIntegrationsDeps {
  /** Fetch + decrypt secrets for a provider. Defaults to the real DB query. */
  fetchSecrets?: <T>(userId: string, provider: Provider) => Promise<T | null>;
  /** Build a Google auth client. Defaults to the real OAuth2 flow. */
  buildAuthClient?: typeof getPerUserAuthClient;
}

// ── Internal token-refresh callback ──────────────────────────────────────────

function makeTokenRefresher(userId: string): OnTokenRefresh {
  return async (updated) => {
    const db = getServiceClient();

    // Read the current row including updated_at for optimistic concurrency control.
    // We need the raw encrypted blob so we can re-encrypt the merged result.
    const { data: current, error } = await db
      .from("user_integrations")
      .select("secrets_enc, updated_at")
      .eq("user_id", userId)
      .eq("provider", "google")
      .single();

    if (error || !current) return;

    let existing: GoogleSecrets;
    try {
      existing = decryptJson<GoogleSecrets>(current.secrets_enc);
    } catch {
      return; // can't decrypt — skip to avoid corrupting the row
    }

    const merged = { ...existing, ...updated };

    // Optimistic lock: only commit if updated_at matches what we read.
    // If someone else updated (e.g. user re-connected Google, parallel refresh),
    // we skip — their version already contains newer tokens.
    const { data: result } = await db
      .from("user_integrations")
      .update({
        secrets_enc: encryptJson(merged),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("provider", "google")
      .eq("updated_at", current.updated_at)
      .select("id");

    if (!result || result.length === 0) {
      console.warn(`Google token refresh skipped for user ${userId} — concurrent update detected.`);
    } else {
      console.log(`Google tokens refreshed for user ${userId}`);
    }
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

export async function loadUserIntegrations(
  userId: string,
  userTimezone: string,
  deps: LoadIntegrationsDeps = {}
): Promise<IntegrationLoaders> {
  const fetchSecrets = deps.fetchSecrets ?? getSecrets;
  const buildAuthClient = deps.buildAuthClient ?? getPerUserAuthClient;

  const loaders: IntegrationLoaders = {};

  // ── Google (Gmail + Calendar) ─────────────────────────────────────────────
  const googleSecrets = await fetchSecrets<GoogleSecrets>(userId, "google");
  if (googleSecrets) {
    const onRefresh = makeTokenRefresher(userId);

    // Both loaders share a single auth client built on first call
    let authClientPromise: Promise<ReturnType<typeof getPerUserAuthClient>> | null = null;
    const getAuth = () => {
      if (!authClientPromise) {
        authClientPromise = buildAuthClient(googleSecrets, onRefresh);
      }
      return authClientPromise;
    };

    loaders.loadGmail = async () => {
      const auth = await getAuth();
      return {
        gmailEnabled: true,
        sendEmail: (p) => sendEmail(auth, p),
      };
    };

    loaders.loadCalendar = async () => {
      const auth = await getAuth();
      return {
        calendarEnabled: true,
        createCalendarEvent: (p) => createCalendarEvent(auth, p, userTimezone),
      };
    };
  }

  // ── Notion ────────────────────────────────────────────────────────────────
  const notionSecrets = await fetchSecrets<{
    token: string;
    databases: NotionDatabasesMap;
  }>(userId, "notion");

  if (notionSecrets) {
    loaders.loadNotion = async () => ({
      notionEnabled: true,
      createNotionPage: (p) =>
        createNotionPage(notionSecrets.token, notionSecrets.databases, p),
    });
  }

  // ── VAPI ──────────────────────────────────────────────────────────────────
  const vapiSecrets = await fetchSecrets<VapiSecrets>(userId, "vapi");

  if (vapiSecrets) {
    loaders.loadVapi = async () => ({
      vapiEnabled: true,
      makeVapiCall: (p) => makeVapiCall(vapiSecrets, p),
    });
  }

  return loaders;
}
