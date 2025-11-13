# Database: charts table (synastry)

This document describes the `charts` table and how to use the helper functions in `src/lib/charts.ts`.

## Migration

Run the SQL in `sql/create_charts_table.sql` in your Supabase SQL editor (SQL > New query) or via psql:

```bash
# run from project root
psql "${SUPABASE_DB_URL}" -f sql/create_charts_table.sql
```

Supabase usually provides `gen_random_uuid()` via `pgcrypto` extension which the migration enables.

## Table structure

- id: uuid primary key
- user_id: uuid of the Supabase user (profiles.id)
- name: text name for the chart
- visibility: text ('private' | 'public' | 'shared')
- profile: jsonb snapshot of the profile used to build the chart
- chart: jsonb the computed chart response
- meta: jsonb calculation metadata
- created_at, updated_at: timestamps

Indexes: user_id, visibility and a profile->>'birth' example index added.

## Usage from code

Import helpers:

```ts
import { saveChart, listUserCharts, getChartById, findCandidateChartsForSynastry } from '../lib/charts';
```

- `saveChart(userId, name, visibility, profile, chart, meta)` - saves and returns the saved row
- `listUserCharts(userId)` - returns array of user's charts
- `getChartById(id)` - returns single chart
- `findCandidateChartsForSynastry(userId, fromIso?, toIso?)` - finds other users' public/shared charts for synastry

## Security

- Protect inserts/reads server-side using Row Level Security (RLS) policies in Supabase. Example policy:

```sql
-- Allow users to manage their own charts
create policy "Users can insert their charts" on charts
for insert using (auth.role() = 'authenticated');

create policy "Users can select their charts" on charts
for select using (auth.uid() = user_id);

-- Public/shared selection policy example: allow reading public charts
create policy "Public charts" on charts
for select using (visibility = 'public');
```

Adjust policies to your app's needs.

## Next steps

- Add server-side RPC endpoints if you want custom search/synastry queries.
- Add tests for saving and retrieving charts.

