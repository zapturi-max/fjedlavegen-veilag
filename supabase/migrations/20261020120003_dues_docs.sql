-- Fjedlavegen veilag – kontingent + dokumentarkiv
-- Kjøres etter 0002_economy.sql.

-- =========================================================
-- Kontingent (én rad pr. medlem pr. år)
-- =========================================================
create table if not exists public.dues (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references public.members(id) on delete cascade,
  year       integer not null,
  amount     numeric(12,2) not null default 0,
  paid       boolean not null default false,
  paid_date  date,
  created_at timestamptz not null default now(),
  unique (member_id, year)
);

create index if not exists dues_year_idx on public.dues (year);

alter table public.dues enable row level security;
drop policy if exists dues_all on public.dues;
create policy dues_all on public.dues
  for all using (public.is_allowed()) with check (public.is_allowed());

-- =========================================================
-- Dokumentarkiv (vedtekter, referat, kart osv.)
-- =========================================================
create table if not exists public.documents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  file_path   text not null,            -- sti i storage-bucket 'documents'
  uploaded_by text,
  created_at  timestamptz not null default now()
);

alter table public.documents enable row level security;
drop policy if exists documents_all on public.documents;
create policy documents_all on public.documents
  for all using (public.is_allowed()) with check (public.is_allowed());

-- Privat storage-bucket for dokumenter
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists documents_select on storage.objects;
create policy documents_select on storage.objects
  for select using (bucket_id = 'documents' and public.is_allowed());

drop policy if exists documents_insert on storage.objects;
create policy documents_insert on storage.objects
  for insert with check (bucket_id = 'documents' and public.is_allowed());

drop policy if exists documents_delete on storage.objects;
create policy documents_delete on storage.objects
  for delete using (bucket_id = 'documents' and public.is_allowed());
