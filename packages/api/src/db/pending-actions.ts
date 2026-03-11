/**
 * Pending actions DB helpers — replaces the in-memory Map from relay.ts.
 */

import type { PendingAction } from "@relay/core";
import { getServiceClient } from "./client.ts";

export interface PendingActionRow {
  id: string;
  user_id: string;
  action_type: string;
  description: string;
  data: string;
  status: "pending" | "executing" | "approved" | "rejected" | "expired";
  chat_id?: number | null;
  message_id?: number | null;
  result?: string | null;
  error?: string | null;
  created_at: string;
  expires_at: string;
}

/** Insert a new pending action and return its UUID. */
export async function insertPendingAction(
  userId: string,
  action: PendingAction,
  context: { chatId?: number; messageId?: number } = {}
): Promise<string> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("pending_actions")
    .insert({
      user_id: userId,
      action_type: action.type,
      description: action.description,
      data: action.data,
      chat_id: context.chatId ?? null,
      message_id: context.messageId ?? null,
    })
    .select("id")
    .single();

  if (error) throw new Error(`insertPendingAction: ${error.message}`);
  return data.id as string;
}

/** Fetch a pending action by ID — verifies ownership. Returns null if not found or not owned. */
export async function getPendingAction(
  userId: string,
  actionId: string
): Promise<PendingActionRow | null> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("pending_actions")
    .select("*")
    .eq("id", actionId)
    .eq("user_id", userId)
    .single();

  if (error?.code === "PGRST116") return null;
  if (error) throw new Error(`getPendingAction: ${error.message}`);
  return data as PendingActionRow;
}

/** Atomically claim an action for execution (pending → executing). Returns false if already claimed or expired.
 *  userId is required to prevent cross-user action execution (IDOR). */
export async function claimPendingAction(actionId: string, userId: string): Promise<boolean> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("pending_actions")
    .update({ status: "executing" })
    .eq("id", actionId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("id");

  if (error) throw new Error(`claimPendingAction: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Mark an action approved with its result string. Verifies ownership via userId. */
export async function resolvePendingAction(
  actionId: string,
  result: string,
  userId: string
): Promise<void> {
  const db = getServiceClient();
  const { error } = await db
    .from("pending_actions")
    .update({ status: "approved", result })
    .eq("id", actionId)
    .eq("user_id", userId);
  if (error) throw new Error(`resolvePendingAction: ${error.message}`);
}

/** List a user's pending (non-expired) actions, newest first. */
export async function listPendingActions(userId: string): Promise<PendingActionRow[]> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("pending_actions")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listPendingActions: ${error.message}`);
  return (data ?? []) as PendingActionRow[];
}

/** Mark an action as rejected or store an error message. Verifies ownership via userId. */
export async function rejectPendingAction(
  actionId: string,
  errorMsg: string | undefined,
  userId: string
): Promise<void> {
  const db = getServiceClient();
  const { error } = await db
    .from("pending_actions")
    .update({ status: "rejected", error: errorMsg ?? null })
    .eq("id", actionId)
    .eq("user_id", userId);
  if (error) throw new Error(`rejectPendingAction: ${error.message}`);
}
