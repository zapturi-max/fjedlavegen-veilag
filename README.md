# Fjedlavegen veilag

Webapp for medlemsregister, felles-SMS og regnskap/budsjett for Fjedlavegen veilag.

- **Frontend:** statisk HTML/CSS/JS (ingen build) → GitHub Pages
- **Backend:** Supabase (Postgres + Google-innlogging + Storage + Edge Function)
- **SMS:** Sveve, via Edge Function (passord skjult i backend)

Tilgang er låst til whitelistede e-poster (deg + Mads) via Row Level Security.

---

## Oppsett – engangsjobb

### 1. Supabase-prosjekt
1. Opprett konto på [supabase.com](https://supabase.com) → **New project** (velg region EU, f.eks. Frankfurt).
2. Når prosjektet er klart: **SQL Editor** → kjør migrasjonene i rekkefølge:
   `0001_init.sql` → `0002_economy.sql` → `0003_dues_docs.sql`, og til slutt
   `0100_seed_members.sql` for å importere medlemslista (kun én gang).
3. I `0001_init.sql`: bytt ut `mads@example.com` med Mads sin faktiske Google-e-post.
4. **Project Settings → API**: kopier **Project URL** og **anon public key** inn i
   `src/config.js`.

### 2. Google-innlogging
1. [Google Cloud Console](https://console.cloud.google.com) → nytt prosjekt → **APIs & Services → Credentials → Create OAuth client ID** (type: Web application).
2. **Authorized redirect URI:** `https://<din-ref>.supabase.co/auth/v1/callback`
3. Kopier Client ID + Secret.
4. Supabase → **Authentication → Providers → Google** → lim inn, skru på.
5. Supabase → **Authentication → URL Configuration** → legg til GitHub Pages-URL-en
   (f.eks. `https://<bruker>.github.io/fjedlavegen-veilag/`) under **Redirect URLs**.

> Whitelisten i `allowed_emails` avgjør hvem som slipper inn – Google-innlogging alene
> er ikke nok. Legg til nye medlemmer av styret der ved behov (SQL Editor).

### 3. Sveve (SMS)
1. Opprett konto på [sveve.no](https://sveve.no), kjøp SMS-pakke, lag et API-brukernavn/passord.
2. Installer Supabase CLI og deploy funksjonen:
   ```bash
   supabase login
   supabase link --project-ref <din-ref>
   supabase functions deploy send-sms
   supabase secrets set SVEVE_USER=... SVEVE_PASSWD=... SVEVE_SENDER=Fjedlavegen
   ```
   (`SVEVE_SENDER` = avsendernavn, maks 11 tegn.)

### 4. GitHub Pages
1. Lag et **privat** repo, push dette prosjektet.
2. **Settings → Pages** → Source: `main` / `/root`.
3. Åpne URL-en, logg inn med Google. Ferdig.

> Frontend-filene er trygge å ha i repoet: `anon key` er designet for å være offentlig,
> og RLS + whitelist beskytter all data. Sveve-passordet ligger **kun** som secret i Supabase.

---

## Daglig bruk
- **Medlemmer:** søk, legg til, rediger, slett. «Aktiv»-haken styrer hvem som får SMS.
- **Kontingent:** opprett årets kontingent for alle aktive, huk av betalt, se betalt/utestående,
  og send purre-SMS kun til de som ikke har betalt.
- **Send SMS:** til alle aktive eller et utvalg du huker av. Logg vises nederst.
- **Økonomi:** registrer utgifter/inntekter med kvittering, se regnskap pr. år og kategori,
  eksporter CSV til årsmøtet.
- **Dokumenter:** last opp vedtekter, årsmøtereferat, kart o.l. til privat arkiv.

> Kontingent og Økonomi er bevisst adskilt: å huke av «betalt» fører ikke automatisk en
> inntektspost i regnskapet. Vil du ha det koblet, si fra.
