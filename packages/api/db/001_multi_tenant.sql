-- ============================================================
-- Migration 001: Multi-Tenant Foundation
-- ============================================================
-- Applies on top of the existing single-user schema (db/schema.sql).
-- Safe to run repeatedly — all statements use IF NOT EXISTS / IF EXISTS.
--
-- Order of operations:
--   1. New tables (user_profiles, user_integrations, pending_actions)
--   2. Alter existing tables (add user_id to messages, memory, logs)
--   3. Indexes
--   4. Drop permissive single-user RLS policies
--   5. Enable RLS on new tables + create per-user policies
--   6. Update helper RPCs to accept p_user_id
-- ============================================================


-- ============================================================
-- 1. NEW TABLES
-- ============================================================

-- User profiles — mirrors Supabase Auth's auth.users.
-- Holds per-user settings that replace flat files (.env, profile.md, topics.json).
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id       UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  -- Identity
  display_name  TEXT,
  telegram_id   TEXT UNIQUE,          -- Telegram numeric user ID (string for safety)

  -- Prompt & AI settings (replaces .env USER_NAME, USER_TIMEZONE, GROQ_CHAT_MODEL)
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  profile_md    TEXT,                 -- replaces config/profile.md, loaded into buildPrompt
  ai_model      TEXT DEFAULT 'llama-3.3-70b-versatile',
  max_history   INTEGER DEFAULT 10,

  -- Feature toggles (per-user overrides)
  voice_mode    BOOLEAN DEFAULT FALSE,
  web_search    BOOLEAN DEFAULT TRUE,

  -- Agent topic mapping (replaces topics.json flat file)
  -- Format: { "threadId": "agentKey" }  e.g. { "123": "research", "456": "finance" }
  agent_topics  JSONB DEFAULT '{}',

  -- Plan tier — controls rate limits and feature access
  plan          TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team'))
);

-- Integration secrets — one row per user per provider.
-- secrets_enc holds AES-256-GCM encrypted JSON (see packages/api/src/services/encrypt.ts).
-- The plaintext shape per provider:
--   google:      { access_token, refresh_token, expiry_date, client_id, client_secret }
--   notion:      { token, databases: NotionDatabasesMap }
--   vapi:        { api_key, phone_number_id, destination_phone }
--   elevenlabs:  { api_key, voice_id? }
--   tavily:      { api_key }
--   groq:        { api_key }
CREATE TABLE IF NOT EXISTS user_integrations (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  user_id         UUID NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN (
                    'google', 'notion', 'vapi', 'elevenlabs', 'tavily', 'groq'
                  )),
  enabled         BOOLEAN DEFAULT TRUE,
  secrets_enc     TEXT NOT NULL,       -- base64(iv[12] + authTag[16] + ciphertext)
  -- Non-sensitive metadata queryable without decryption
  -- e.g. { "email": "user@gmail.com", "scope": [...] }  for google
  --      { "databases": ["tasks", "docs"] }              for notion
  meta            JSONB DEFAULT '{}',
  UNIQUE (user_id, provider)
);

-- Pending actions — replaces the in-memory Map<string, PendingAction> in relay.ts.
-- Persists across restarts and works across multiple processes.
-- status lifecycle: pending → executing → approved | rejected | expired
CREATE TABLE IF NOT EXISTS pending_actions (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 minutes',
  user_id       UUID NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,

  -- Matches PendingAction from @relay/core
  action_type   TEXT NOT NULL,         -- 'note' | 'reminder' | 'email_send' | etc.
  description   TEXT NOT NULL,
  data          TEXT NOT NULL,         -- raw JSON string

  -- Telegram context needed to reply after approval
  chat_id       BIGINT,
  message_id    INTEGER,

  -- State machine
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'executing', 'approved', 'rejected', 'expired')),
  result        TEXT,                  -- confirmation string after execution
  error         TEXT                   -- error message if execution failed
);


-- ============================================================
-- 2. ALTER EXISTING TABLES — add user_id (nullable for backfill)
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS
  user_id UUID REFERENCES user_profiles(user_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS
  thread_id TEXT;                      -- Telegram topic/thread ID

ALTER TABLE messages ADD COLUMN IF NOT EXISTS
  agent_key TEXT;                      -- which agent handled this message

ALTER TABLE memory ADD COLUMN IF NOT EXISTS
  user_id UUID REFERENCES user_profiles(user_id);

ALTER TABLE logs ADD COLUMN IF NOT EXISTS
  user_id UUID REFERENCES user_profiles(user_id);


-- ============================================================
-- 3. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_user_integrations_user
  ON user_integrations(user_id, provider);

CREATE INDEX IF NOT EXISTS idx_pending_actions_user
  ON pending_actions(user_id, status);

CREATE INDEX IF NOT EXISTS idx_pending_actions_expires
  ON pending_actions(expires_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_messages_user_id
  ON messages(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_user_id
  ON memory(user_id, type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_logs_user_id
  ON logs(user_id, created_at DESC);


-- ============================================================
-- 4. DROP PERMISSIVE SINGLE-USER RLS POLICIES
-- ============================================================

DROP POLICY IF EXISTS "Allow all for service role" ON messages;
DROP POLICY IF EXISTS "Allow all for service role" ON memory;
DROP POLICY IF EXISTS "Allow all for service role" ON logs;


-- ============================================================
-- 5. RLS — NEW TABLES + UPDATED POLICIES ON EXISTING TABLES
-- ============================================================
-- The API uses the service-role key server-side, which bypasses RLS.
-- These policies protect direct client-side access (future mobile app).

ALTER TABLE user_profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_actions   ENABLE ROW LEVEL SECURITY;

-- user_profiles: each user sees only their own row
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'users_own_profile' AND tablename = 'user_profiles') THEN
    CREATE POLICY "users_own_profile" ON user_profiles FOR ALL USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'users_own_integrations' AND tablename = 'user_integrations') THEN
    CREATE POLICY "users_own_integrations" ON user_integrations FOR ALL USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'users_own_actions' AND tablename = 'pending_actions') THEN
    CREATE POLICY "users_own_actions" ON pending_actions FOR ALL USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'users_own_messages' AND tablename = 'messages') THEN
    CREATE POLICY "users_own_messages" ON messages FOR ALL USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'users_own_memory' AND tablename = 'memory') THEN
    CREATE POLICY "users_own_memory" ON memory FOR ALL USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'users_own_logs' AND tablename = 'logs') THEN
    CREATE POLICY "users_own_logs" ON logs FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;


-- ============================================================
-- 6. UPDATE HELPER RPCs — add p_user_id parameter
-- ============================================================

-- get_recent_messages: now scoped to a user
CREATE OR REPLACE FUNCTION get_recent_messages(
  p_user_id     UUID,
  limit_count   INTEGER DEFAULT 20
)
RETURNS TABLE (
  id          UUID,
  created_at  TIMESTAMPTZ,
  role        TEXT,
  content     TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.created_at, m.role, m.content
  FROM messages m
  WHERE m.user_id = p_user_id
  ORDER BY m.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- get_active_goals: now scoped to a user
CREATE OR REPLACE FUNCTION get_active_goals(p_user_id UUID)
RETURNS TABLE (
  id        UUID,
  content   TEXT,
  deadline  TIMESTAMPTZ,
  priority  INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.deadline, m.priority
  FROM memory m
  WHERE m.user_id = p_user_id
    AND m.type = 'goal'
  ORDER BY m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- get_facts: now scoped to a user
CREATE OR REPLACE FUNCTION get_facts(p_user_id UUID)
RETURNS TABLE (
  id      UUID,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content
  FROM memory m
  WHERE m.user_id = p_user_id
    AND m.type = 'fact'
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- match_messages: semantic search scoped to a user
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding   VECTOR(1536),
  p_user_id         UUID,
  match_threshold   FLOAT DEFAULT 0.7,
  match_count       INT DEFAULT 10
)
RETURNS TABLE (
  id          UUID,
  content     TEXT,
  role        TEXT,
  created_at  TIMESTAMPTZ,
  similarity  FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.role,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM messages m
  WHERE m.user_id = p_user_id
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- match_memory: semantic search scoped to a user
CREATE OR REPLACE FUNCTION match_memory(
  query_embedding   VECTOR(1536),
  p_user_id         UUID,
  match_threshold   FLOAT DEFAULT 0.7,
  match_count       INT DEFAULT 10
)
RETURNS TABLE (
  id          UUID,
  content     TEXT,
  type        TEXT,
  created_at  TIMESTAMPTZ,
  similarity  FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.type,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memory m
  WHERE m.user_id = p_user_id
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- BACKFILL NOTE (run manually after seeding the first user)
-- ============================================================
-- After registering the original single-user via magic link, run:
--
--   UPDATE messages  SET user_id = '<your-uuid>' WHERE user_id IS NULL;
--   UPDATE memory    SET user_id = '<your-uuid>' WHERE user_id IS NULL;
--   UPDATE logs      SET user_id = '<your-uuid>' WHERE user_id IS NULL;
--
-- Then optionally make user_id NOT NULL:
--
--   ALTER TABLE messages ALTER COLUMN user_id SET NOT NULL;
--   ALTER TABLE memory   ALTER COLUMN user_id SET NOT NULL;
--   ALTER TABLE logs     ALTER COLUMN user_id SET NOT NULL;
-- ============================================================
