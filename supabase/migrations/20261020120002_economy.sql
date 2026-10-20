-- Fjedlavegen veilag – økonomi/regnskap med bilag
-- Kjøres etter 0001_init.sql.

-- =========================================================
-- Transaksjoner (utgifter og inntekter)
-- =========================================================
create table if not exists public.transactions (
  id           uuid primary key default gen_random_uuid(),
  trx_date     date not null default current_date,
  kind         text not null check (kind in ('expense', 'income')),  -- utgift / inntekt
  description  text not null,
  amount       numeric(12,2) not null check (amount >= 0),
  category     text not null default 'Annet',
  receipt_path text,                      -- sti i storage-bucket 'receipts'
  created_by   text,
  created_at   timestamptz not null default now()
);

create index if not exists trx_date_idx on public.transactions (trx_date);
create index if not exists trx_kind_idx on public.transactions (kind);

alter table public.transactions enable row level security;

drop policy if exists trx_all on public.transactions;
create policy trx_all on public.transactions
  for all using (public.is_allowed()) with check (public.is_allowed());

-- =========================================================
-- Storage-bucket for kvitteringer (privat)
-- =========================================================
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- Kun whitelistede kan lese/laste opp/slette filer i bucket 'receipts'
drop policy if exists receipts_select on storage.objects;
create policy receipts_select on storage.objects
  for select using (bucket_id = 'receipts' and public.is_allowed());

drop policy if exists receipts_insert on storage.objects;
create policy receipts_insert on storage.objects
  for insert with check (bucket_id = 'receipts' and public.is_allowed());

drop policy if exists receipts_delete on storage.objects;
create policy receipts_delete on storage.objects
  for delete using (bucket_id = 'receipts' and public.is_allowed());

-- Regnskapssammendrag pr. år/kategori beregnes i frontend (app.js),
-- så vi unngår en SQL-view som kan omgå RLS.
