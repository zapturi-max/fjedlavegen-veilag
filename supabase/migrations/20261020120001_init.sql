-- Fjedlavegen veilag – databaseskjema
-- Kjøres i Supabase SQL Editor (eller via `supabase db push`).

-- =========================================================
-- 1) Whitelist: kun disse e-postene får lese/skrive noe
-- =========================================================
create table if not exists public.allowed_emails (
  email text primary key,
  note  text,
  added_at timestamptz not null default now()
);

-- Legg inn de to som skal ha tilgang (bytt ut ved behov):
-- Legg inn de som skal ha tilgang (deres Google-innloggings-e-poster).
-- MERK: dette repoet er offentlig – ikke commit faktiske e-poster her.
-- Legg dem i stedet inn via Supabase SQL Editor / dashboard, f.eks.:
--   insert into public.allowed_emails (email, note)
--   values ('navn@gmail.com', 'Rolle') on conflict (email) do nothing;
insert into public.allowed_emails (email, note) values
  ('REPLACE_ME@example.com', 'Placeholder – bytt ut i dashboard')
on conflict (email) do nothing;

-- Hjelpefunksjon: er den innloggede brukeren whitelistet?
create or replace function public.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- =========================================================
-- 2) Medlemmer
-- =========================================================
create table if not exists public.members (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text not null,              -- 8-sifret norsk nr eller +47...
  email       text,
  unit        text,                       -- bolig/eiendom/gnr-bnr e.l.
  active      boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists members_name_idx on public.members (name);

-- oppdater updated_at automatisk
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists members_touch on public.members;
create trigger members_touch before update on public.members
  for each row execute function public.touch_updated_at();

-- =========================================================
-- 3) SMS-logg (hvem sendte hva, når – nyttig revisjonsspor)
-- =========================================================
create table if not exists public.sms_log (
  id           uuid primary key default gen_random_uuid(),
  sent_by      text,                      -- e-post på avsender
  message      text not null,
  recipients   integer not null,          -- antall mottakere
  ok_count     integer,
  error        text,
  created_at   timestamptz not null default now()
);

-- =========================================================
-- 4) Row Level Security – lås alt til whitelistede brukere
-- =========================================================
alter table public.members        enable row level security;
alter table public.sms_log        enable row level security;
alter table public.allowed_emails enable row level security;

-- members: full tilgang for whitelistede
drop policy if exists members_all on public.members;
create policy members_all on public.members
  for all using (public.is_allowed()) with check (public.is_allowed());

-- sms_log: whitelistede kan lese + sette inn
drop policy if exists sms_log_select on public.sms_log;
create policy sms_log_select on public.sms_log
  for select using (public.is_allowed());

drop policy if exists sms_log_insert on public.sms_log;
create policy sms_log_insert on public.sms_log
  for insert with check (public.is_allowed());

-- allowed_emails: whitelistede kan se lista (men ikke endre fra appen)
drop policy if exists allowed_select on public.allowed_emails;
create policy allowed_select on public.allowed_emails
  for select using (public.is_allowed());
