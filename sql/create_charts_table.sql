-- Migration: create charts table for storing user charts for synastry

-- Enable uuid-ossp if not present (Supabase provides gen_random_uuid via pgcrypto, but include fallback)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS charts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL DEFAULT 'unnamed',
  visibility text NOT NULL DEFAULT 'private', -- 'private' | 'public' | 'shared'
  profile jsonb NOT NULL,
  chart jsonb NOT NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes to speed up user lookups and some JSONB operations
CREATE INDEX IF NOT EXISTS idx_charts_user_id ON charts(user_id);
CREATE INDEX IF NOT EXISTS idx_charts_visibility ON charts(visibility);

-- Example GIN index on profile->>birth for date queries (optional)
CREATE INDEX IF NOT EXISTS idx_charts_profile_birth ON charts ((profile->>'birth'));

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_timestamp ON charts;
CREATE TRIGGER set_timestamp
BEFORE UPDATE ON charts
FOR EACH ROW
EXECUTE PROCEDURE trigger_set_timestamp();
