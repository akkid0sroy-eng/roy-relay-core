-- ============================================================
-- Migration 002: WhatsApp support
-- ============================================================
-- Adds whatsapp_phone to user_profiles so the webhook can
-- route incoming messages to the correct user account.
--
-- Safe to run repeatedly — uses IF NOT EXISTS / IF EXISTS.
-- ============================================================

-- Add WhatsApp phone number (stored as sent by Meta, no + prefix)
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT UNIQUE;

-- Fast lookup by phone on every inbound webhook call
CREATE INDEX IF NOT EXISTS idx_user_profiles_whatsapp_phone
  ON user_profiles(whatsapp_phone)
  WHERE whatsapp_phone IS NOT NULL;

-- ============================================================
-- RLS: existing "users_own_profile" policy covers the new
-- column automatically — no additional policy needed.
-- ============================================================
