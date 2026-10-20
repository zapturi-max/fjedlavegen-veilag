-- Fjedlavegen veilag – endringslogg (audit trail), synlig for whitelistede
create table if not exists public.activity_log (
  id          uuid primary key default gen_random_uuid(),
  actor_email text,
  message     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists activity_created_idx on public.activity_log (created_at desc);

alter table public.activity_log enable row level security;

drop policy if exists activity_select on public.activity_log;
create policy activity_select on public.activity_log
  for select using (public.is_allowed());

drop policy if exists activity_insert on public.activity_log;
create policy activity_insert on public.activity_log
  for insert with check (public.is_allowed());
