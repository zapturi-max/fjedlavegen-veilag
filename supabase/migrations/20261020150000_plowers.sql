-- Fjedlavegen veilag – register over brøytere (snøbrøyting-kontakter)
create table if not exists public.plowers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  price       text,          -- pris (fritekst, f.eks. "1500 kr/time")
  callout_fee text,          -- utrykningsgebyr
  comment     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists plowers_touch on public.plowers;
create trigger plowers_touch before update on public.plowers
  for each row execute function public.touch_updated_at();

alter table public.plowers enable row level security;
drop policy if exists plowers_all on public.plowers;
create policy plowers_all on public.plowers
  for all using (public.is_allowed()) with check (public.is_allowed());
