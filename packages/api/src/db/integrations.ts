/**
 * DB helpers for the user_integrations table.
 *
 * secrets_enc is NEVER returned by list/status queries — only loaded
 * server-side by loadUserIntegrations() in Step 8.
 */

import { getServiceClient } from "./client.ts";
import { encryptJson, decryptJson } from "../services/encrypt.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Provider =
  | "google"
  | "notion"
  | "vapi"
  | "elevenlabs"
  | "tavily"
  | "groq";

export interface IntegrationRow {
  id: string;
  user_id: string;
  provider: Provider;
  enabled: boolean;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** List all integrations for a user — no secrets returned. */
export async function listIntegrations(userId: string): Promise<IntegrationRow[]> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("user_integrations")
    .select("id, user_id, provider, enabled, meta, created_at, updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`listIntegrations: ${error.message}`);
  return (data ?? []) as IntegrationRow[];
}

/** Get a single integration row (no secrets). Returns null if not found. */
export async function getIntegration(
  userId: string,
  provider: Provider
): Promise<IntegrationRow | null> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("user_integrations")
    .select("id, user_id, provider, enabled, meta, created_at, updated_at")
    .eq("user_id", userId)
    .eq("provider", provider)
    .single();

  if (error?.code === "PGRST116") return null; // not found
  if (error) throw new Error(`getIntegration: ${error.message}`);
  return data as IntegrationRow;
}

/** Read and decrypt secrets for a provider. Returns null if not stored. */
export async function getSecrets<T>(
  userId: string,
  provider: Provider
): Promise<T | null> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("user_integrations")
    .select("secrets_enc")
    .eq("user_id", userId)
    .eq("provider", provider)
    .single();

  if (error?.code === "PGRST116") return null;
  if (error) throw new Error(`getSecrets: ${error.message}`);
  return decryptJson<T>(data.secrets_enc);
}

/** Upsert (create or replace) an integration row. */
export async function upsertIntegration(
  userId: string,
  provider: Provider,
  secrets: unknown,
  meta: Record<string, unknown> = {}
): Promise<IntegrationRow> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("user_integrations")
    .upsert(
      {
        user_id: userId,
        provider,
        enabled: true,
        secrets_enc: encryptJson(secrets),
        meta,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" }
    )
    .select("id, user_id, provider, enabled, meta, created_at, updated_at")
    .single();

  if (error) throw new Error(`upsertIntegration: ${error.message}`);
  return data as IntegrationRow;
}

/** Disable an integration (keeps secrets for potential re-enable). */
export async function disableIntegration(
  userId: string,
  provider: Provider
): Promise<void> {
  const db = getServiceClient();
  const { error } = await db
    .from("user_integrations")
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("provider", provider);

  if (error) throw new Error(`disableIntegration: ${error.message}`);
}

/** Fully delete an integration row (user must re-authenticate to reconnect). */
export async function deleteIntegration(
  userId: string,
  provider: Provider
): Promise<void> {
  const db = getServiceClient();
  const { error } = await db
    .from("user_integrations")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);

  if (error) throw new Error(`deleteIntegration: ${error.message}`);
}
