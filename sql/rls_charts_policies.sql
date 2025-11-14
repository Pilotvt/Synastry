-- Row Level Security policies for charts table (Supabase)

-- Enable RLS
ALTER TABLE IF EXISTS charts ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to insert rows (they must set user_id to their own uid)
CREATE POLICY IF NOT EXISTS allow_insert_authenticated ON charts
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- Allow owners to select their own charts
CREATE POLICY IF NOT EXISTS select_own ON charts
FOR SELECT
TO authenticated
USING (auth.uid() = user_id OR visibility = 'public');

-- Allow owners to update/delete their own charts
CREATE POLICY IF NOT EXISTS modify_own ON charts
FOR UPDATE, DELETE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Allow public selection of charts with visibility = 'public' for anonymous/select (optional)
-- Supabase exposes 'anon' role for unauthenticated; adjust if needed.
CREATE POLICY IF NOT EXISTS select_public ON charts
FOR SELECT
TO anon
USING (visibility = 'public');

-- Note: adapt policies for 'shared' behaviour if you need per-user sharing lists.
