create table if not exists public.profile_blocks (
    blocker_id uuid not null references auth.users (id) on delete cascade,
    blocked_id uuid not null references auth.users (id) on delete cascade,
    blocked_at timestamptz not null default timezone('utc', now()),
    primary key (blocker_id, blocked_id)
);

comment on table public.profile_blocks is 'Списки блокировки пользователей (blocker скрывает blocked).';
comment on column public.profile_blocks.blocker_id is 'Пользователь, который блокирует.';
comment on column public.profile_blocks.blocked_id is 'Пользователь, которого скрывают.';
comment on column public.profile_blocks.blocked_at is 'Метка времени добавления в чёрный список.';

create index if not exists profile_blocks_blocked_id_idx on public.profile_blocks (blocked_id);
create index if not exists profile_blocks_blocked_at_idx on public.profile_blocks (blocked_at desc);

alter table public.profile_blocks enable row level security;

drop policy if exists "Users can see their blocklist" on public.profile_blocks;
create policy "Users can see their blocklist"
    on public.profile_blocks
    for select
    using (auth.uid() = blocker_id);

drop policy if exists "Users can add to blocklist" on public.profile_blocks;
create policy "Users can add to blocklist"
    on public.profile_blocks
    for insert
    with check (auth.uid() = blocker_id);

drop policy if exists "Users can delete blocklist entries" on public.profile_blocks;
create policy "Users can delete blocklist entries"
    on public.profile_blocks
    for delete
    using (auth.uid() = blocker_id);

-- Обновления таблицы не требуются, поэтому политика UPDATE не создаётся.
