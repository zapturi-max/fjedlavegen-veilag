# CLAUDE.md – Fjedlavegen veilag

Webapp for Fjedlavegen veilag (velforening). Bruker: Anders (økonomiansvarlig, personlig
Gmail), Mads (leder). Begge iPhone. Appen skal være enkel og gratis i drift.

> ⚠️ **Dette repoet er OFFENTLIG.** Legg ALDRI inn persondata (medlemmers navn/adresse/
> telefon/e-post) eller hemmeligheter (DB-passord, access tokens, service_role-nøkkel).
> Persondata lever kun i Supabase-databasen. `anon key` i `src/config.js` er trygg (offentlig
> by design; RLS + whitelist beskytter dataene).

## Live
- App: https://zapturi-max.github.io/fjedlavegen-veilag/ (GitHub Pages, branch `main`, `/root`)
- Repo: github.com/zapturi-max/fjedlavegen-veilag (offentlig)
- Supabase project ref: `bkhmtytvarpcyfkscyqi` (region EU/Frankfurt)

## Stack
- **Frontend:** vanilla JS/HTML/CSS, INGEN build-steg. Deploy = `git push` (Pages bygger auto).
- **Backend:** Supabase – Postgres + Auth (magic link) + Storage. All tilgang bak RLS.
- **Auth:** passordløs **magic link** (e-post). Whitelist-tabell `allowed_emails` + `is_allowed()`
  avgjør hvem som slipper inn. Bytt-til-Google ble forkastet (for mye oppsett).
- **SMS:** INGEN tredjepart. «Åpne i Meldinger» bygger en `sms:`-lenke (mottakere + tekst) og
  åpner telefonens Meldinger-app; sendes gratis fra brukerens eget abonnement. Numre → `+47`.
  (Sveve var ~290 kr/mnd; GatewayAPI-signup feilet.) Edge Function `send-sms` ligger igjen men
  er UBRUKT – kan kobles på en betalt gateway hvis ekte masseutsending trengs.

## Filer
- `index.html` – app-skall (login + 7 faner: Hjem, Medlemmer, Kontingent, SMS, Økonomi,
  Dokumenter, Brøyting). **Cache-busting:** CSS/JS lenkes med `?v=N` – BUMP N ved hver endring
  i app.js/styles.css, ellers får brukerne gammel kode (vi har slitt med nettopp dette).
- `src/app.js` – all logikk (Supabase-klient via esm.sh CDN). `logActivity()` skriver til endringslogg
  ved alle mutasjoner; `loadDashboard()` fyller Hjem-fanen (nøkkeltall + siste aktivitet).
- `src/config.js` – Supabase URL + anon key (offentlig-trygt)
- `src/styles.css` – premium mobil-UI; Plus Jakarta Sans (Google Fonts), gradient-hero, ikon-brikker.
  Bunnmeny på mobil, toppmeny på PC (≥760px)
- `supabase/migrations/` – init (tabeller+RLS+whitelist), økonomi, kontingent+docs, activity_log, plowers
- DB-tabeller: allowed_emails, members, sms_log, transactions, dues, documents, activity_log, plowers.
  Endringslogg: `logActivity(msg)` kalles ved alle mutasjoner; vises på Hjem med navn-avatar (system = grå).
- `supabase/migrations/*_seed_members.sql` – **gitignored** (persondata, kun lokalt)
- `supabase/functions/send-sms/` – ubrukt Edge Function (Sveve-rester)

## Kommandoer
- Deploy frontend: `git push` (Pages rebygger på ~1 min)
- Kjør SQL mot DB: `supabase db query --linked "<sql>"`  ← BRUK DENNE, ikke psql
- Migrasjoner: `supabase db push -p <db-passord>` (CLI krever timestamp-filnavn: `YYYYMMDDHHMMSS_navn.sql`)
- Legg til whitelist-bruker: `supabase db query --linked "insert into allowed_emails (email,note) values ('x@y.no','rolle') on conflict do nothing;"`
- PATH: `export PATH="/opt/homebrew/bin:$PATH"` (supabase CLI + gh)

## Gotchas / kjøreregler
- Auto-mode-classifier BLOKKERER: direkte `psql` mot prod, og `git push -f` (force). Bruk
  `supabase db query --linked` for SQL, og unngå history-rewrite uten eksplisitt OK.
- GitHub Pages (gratis) krever OFFENTLIG repo – derfor må persondata holdes ute (se topp).
- Magic link krever at Site URL + Redirect URLs i Supabase Auth peker på Pages-URL-en.
- `sms:`-lenke med mange mottakere = én gruppesamtale i Meldinger (kan være uønsket).
- Edge Function-filnavn/migrasjoner: CLI vil ha timestamp-format.

## Åpne tråder / ideer
- Penere domene (f.eks. eget `.no`) i stedet for github.io-URL.
- Ev. «send til én og én»-modus for private SMS i stedet for gruppesamtale.
- Budsjett vs. faktisk (ble valgt bort tidligere), auto-inntektspost ved betalt kontingent.
- **Sikkerhetsgjeld:** DB-passord, Supabase access token og service_role-nøkkel havnet i en
  chat-logg under oppsett – bør roteres i Supabase-dashboard (Settings → Database / API).
