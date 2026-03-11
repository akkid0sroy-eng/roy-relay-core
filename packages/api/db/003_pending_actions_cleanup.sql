-- ============================================================
-- Migration 003: Automated cleanup of expired pending_actions
-- ============================================================
-- Requires the pg_cron extension (enabled by default on Supabase).
-- Safe to run multiple times — uses OR REPLACE on the function and
-- cron.schedule which is idempotent on the job name.
--
-- What this does:
--   1. Creates (or replaces) a cleanup function that:
--        • Marks pending/executing rows as "expired" once expires_at has passed
--        • Hard-deletes rows that have been expired/approved/rejected for > 7 days
--          (keeps the last 7 days for audit/debugging, then purges)
--   2. Schedules the function to run every 10 minutes via pg_cron.
-- ============================================================

-- ── 1. Enable pg_cron extension ───────────────────────────────────────────────
-- This is a no-op if already enabled; safe to run repeatedly.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── 2. Cleanup function ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION cleanup_pending_actions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  marked_expired   INTEGER;
  hard_deleted     INTEGER;
BEGIN
  -- Step 1: Transition stale pending/executing rows → expired
  --   "pending"   rows: haven't been approved or rejected within the TTL window
  --   "executing" rows: integration call took longer than the TTL (extremely rare,
  --                     indicates a hung process); safe to expire after TTL
  UPDATE pending_actions
  SET    status = 'expired'
  WHERE  status IN ('pending', 'executing')
  AND    expires_at < NOW();

  GET DIAGNOSTICS marked_expired = ROW_COUNT;

  -- Step 2: Hard-delete terminal rows older than 7 days
  --   Terminal states: approved, rejected, expired.
  --   We keep 7 days for incident investigation and HitL audit trail.
  DELETE FROM pending_actions
  WHERE  status IN ('approved', 'rejected', 'expired')
  AND    created_at < NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS hard_deleted = ROW_COUNT;

  -- Log a summary to the Postgres log (visible in Supabase Logs → Postgres)
  RAISE LOG 'cleanup_pending_actions: marked_expired=%, hard_deleted=%',
            marked_expired, hard_deleted;
END;
$$;

-- ── 3. Schedule with pg_cron ──────────────────────────────────────────────────
-- Runs every 10 minutes. The job name is a stable identifier — calling
-- cron.schedule with the same name replaces the existing schedule (idempotent).
--
-- pg_cron syntax: minute hour day-of-month month day-of-week
--   */10 * * * *  → every 10 minutes

SELECT cron.schedule(
  'cleanup-pending-actions',   -- stable job name
  '*/10 * * * *',              -- every 10 minutes
  $$SELECT cleanup_pending_actions()$$
);

-- ── 4. Verify ─────────────────────────────────────────────────────────────────
-- After running this migration, confirm the job is registered:
--
--   SELECT jobid, jobname, schedule, command, active
--   FROM   cron.job
--   WHERE  jobname = 'cleanup-pending-actions';
--
-- To run the cleanup manually at any time:
--
--   SELECT cleanup_pending_actions();
--
-- To unschedule:
--
--   SELECT cron.unschedule('cleanup-pending-actions');
