/**
 * Actions route — Human-in-the-Loop approval / rejection.
 *
 * POST /api/actions/:id/approve
 *   → claim action (pending → executing)
 *   → execute via @relay/core executeAction
 *   → resolve or reject in DB
 *   → return { ok, result? }
 *
 * POST /api/actions/:id/reject
 *   → mark as rejected immediately
 *
 * GET /api/actions/:id
 *   → fetch action status (owner-verified)
 *
 * All heavy dependencies are injected so the route is fully testable.
 */

import { Hono } from "hono";
import { executeAction } from "@relay/core";
import type { PendingAction, IntegrationLoaders } from "@relay/core";
import type { PendingActionRow } from "../db/pending-actions.ts";

// ── Dependency injection interface ────────────────────────────────────────────

export interface ActionDeps {
  listActions: (userId: string) => Promise<PendingActionRow[]>;
  fetchAction: (userId: string, actionId: string) => Promise<PendingActionRow | null>;
  claimAction: (actionId: string, userId: string) => Promise<boolean>;
  resolveAction: (actionId: string, result: string, userId: string) => Promise<void>;
  rejectAction: (actionId: string, errorMsg: string | undefined, userId: string) => Promise<void>;
  loadLoaders: (userId: string) => Promise<IntegrationLoaders>;
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function createActionRoutes(deps: ActionDeps): Hono {
  const actions = new Hono();

  // ── GET /api/actions ─────────────────────────────────────────────────────

  actions.get("/", async (c) => {
    const userId = c.get("userId");
    const rows = await deps.listActions(userId);
    return c.json(rows.map((row) => ({
      id:          row.id,
      type:        row.action_type,
      description: row.description,
      status:      row.status,
      created_at:  row.created_at,
      expires_at:  row.expires_at,
    })));
  });

  // ── GET /api/actions/:id ─────────────────────────────────────────────────

  actions.get("/:id", async (c) => {
    const userId = c.get("userId");
    const actionId = c.req.param("id");

    const row = await deps.fetchAction(userId, actionId);
    if (!row) return c.json({ error: "Action not found." }, 404);

    return c.json({
      id:          row.id,
      type:        row.action_type,
      description: row.description,
      status:      row.status,
      result:      row.result ?? undefined,
      error:       row.error ?? undefined,
      created_at:  row.created_at,
      expires_at:  row.expires_at,
    });
  });

  // ── POST /api/actions/:id/approve ─────────────────────────────────────────

  actions.post("/:id/approve", async (c) => {
    const userId = c.get("userId");
    const actionId = c.req.param("id");

    // 1. Verify ownership and check status
    const row = await deps.fetchAction(userId, actionId);
    if (!row) return c.json({ error: "Action not found." }, 404);
    if (row.status !== "pending") {
      return c.json({ error: `Action is already ${row.status}.` }, 409);
    }
    if (new Date(row.expires_at) < new Date()) {
      return c.json({ error: "Action has expired." }, 410);
    }

    // 2. Atomically claim (pending → executing) — replay protection + ownership enforcement
    const claimed = await deps.claimAction(actionId, userId);
    if (!claimed) {
      return c.json({ error: "Action already claimed by another request." }, 409);
    }

    // 3. Build the PendingAction from the DB row
    const action: PendingAction = {
      type:        row.action_type as PendingAction["type"],
      description: row.description,
      data:        row.data,
    };

    // 4. Load integration loaders for this user
    const loaders = await deps.loadLoaders(userId);

    // 5. Execute via @relay/core
    let result: string;
    try {
      result = await executeAction(action, {}, loaders);
      await deps.resolveAction(actionId, result, userId);
    } catch (err: any) {
      const msg = err.message ?? "Execution failed.";
      console.error("executeAction error:", msg);
      await deps.rejectAction(actionId, msg, userId).catch(() => {});
      return c.json({ error: "Action execution failed." }, 502);
    }

    return c.json({ ok: true, result });
  });

  // ── POST /api/actions/:id/reject ──────────────────────────────────────────

  actions.post("/:id/reject", async (c) => {
    const userId = c.get("userId");
    const actionId = c.req.param("id");

    const row = await deps.fetchAction(userId, actionId);
    if (!row) return c.json({ error: "Action not found." }, 404);
    if (row.status !== "pending") {
      return c.json({ error: `Action is already ${row.status}.` }, 409);
    }

    await deps.rejectAction(actionId, undefined, userId);
    return c.json({ ok: true });
  });

  return actions;
}

// ── Default implementations ───────────────────────────────────────────────────

import {
  listPendingActions,
  getPendingAction,
  claimPendingAction,
  resolvePendingAction,
  rejectPendingAction,
} from "../db/pending-actions.ts";
import { loadUserIntegrations } from "../db/load-integrations.ts";

export const defaultActionDeps: ActionDeps = {
  listActions:   listPendingActions,
  fetchAction:   getPendingAction,
  claimAction:   (id, userId) => claimPendingAction(id, userId),
  resolveAction: (id, result, userId) => resolvePendingAction(id, result, userId),
  rejectAction:  (id, msg, userId) => rejectPendingAction(id, msg, userId),
  loadLoaders:   async (userId) => {
    // Load the user's actual timezone so calendar events land in the right zone
    const { getServiceClient } = await import("../db/client.ts");
    const { data } = await getServiceClient()
      .from("user_profiles")
      .select("timezone")
      .eq("user_id", userId)
      .single();
    return loadUserIntegrations(userId, data?.timezone ?? "UTC");
  },
};

export default createActionRoutes(defaultActionDeps);
