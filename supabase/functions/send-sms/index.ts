// Supabase Edge Function: send-sms
// Sender felles-SMS til medlemmer via Sveve.
// Verifiserer at kaller er innlogget + whitelistet (RLS) før utsending.
// Sveve-credentials ligger som funksjons-secrets, aldri i frontend.
//
// Secrets som må settes (supabase secrets set ...):
//   SVEVE_USER     – Sveve brukernavn
//   SVEVE_PASSWD   – Sveve passord/API-passord
//   SVEVE_SENDER   – avsendernavn (alfanumerisk, maks 11 tegn), f.eks. "Fjedlavegen"
//
// SUPABASE_URL og SUPABASE_ANON_KEY injiseres automatisk av plattformen.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "Mangler innlogging" }, 401);

  // Klient med brukerens JWT -> RLS gjelder, så vi leser kun hvis whitelistet.
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: userData, error: userErr } = await supa.auth.getUser();
  if (userErr || !userData.user) return json({ error: "Ugyldig sesjon" }, 401);
  const email = userData.user.email ?? "";

  // Bekreft whitelist via RPC (samme sjekk som RLS bruker)
  const { data: allowed } = await supa.rpc("is_allowed");
  if (!allowed) return json({ error: "Ikke autorisert" }, 403);

  let payload: { message?: string; memberIds?: string[] };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Ugyldig JSON" }, 400);
  }

  const message = (payload.message ?? "").trim();
  if (!message) return json({ error: "Melding er tom" }, 400);

  // Hent mottakere. Hvis memberIds er oppgitt, kun de; ellers alle aktive.
  // RLS sørger for at dette kun fungerer for whitelistede.
  let query = supa.from("members").select("phone").eq("active", true);
  if (payload.memberIds && payload.memberIds.length > 0) {
    query = supa.from("members").select("phone").in("id", payload.memberIds);
  }
  const { data: members, error: memErr } = await query;
  if (memErr) return json({ error: "Kunne ikke hente medlemmer: " + memErr.message }, 500);

  const numbers = (members ?? [])
    .map((m) => (m.phone ?? "").replace(/\s+/g, ""))
    .filter((p) => p.length >= 8);

  if (numbers.length === 0) return json({ error: "Ingen gyldige mottakere" }, 400);

  // --- Send via Sveve ---
  const user = Deno.env.get("SVEVE_USER");
  const passwd = Deno.env.get("SVEVE_PASSWD");
  const sender = Deno.env.get("SVEVE_SENDER") ?? "Fjedlavegen";
  if (!user || !passwd) return json({ error: "SMS ikke konfigurert (mangler secrets)" }, 500);

  const body = new URLSearchParams({
    user,
    passwd,
    to: numbers.join(","),
    msg: message,
    from: sender,
    f: "json",
  });

  let okCount = 0;
  let sveveError: string | null = null;
  try {
    const resp = await fetch("https://sveve.no/SMS/SendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const result = await resp.json();
    // Sveve-svar: { response: { msgOkCount, stdSMSCount, ids, errors:[{number,message}] } }
    okCount = result?.response?.msgOkCount ?? 0;
    const errs = result?.response?.errors;
    if (Array.isArray(errs) && errs.length > 0) {
      sveveError = errs.map((e: { number?: string; message?: string }) =>
        `${e.number ?? ""}: ${e.message ?? ""}`).join("; ");
    } else if (result?.response?.fatalError) {
      sveveError = String(result.response.fatalError);
    }
  } catch (e) {
    sveveError = (e as Error).message;
  }

  // Logg forsøket (uansett utfall)
  await supa.from("sms_log").insert({
    sent_by: email,
    message,
    recipients: numbers.length,
    ok_count: okCount,
    error: sveveError,
  });

  if (sveveError && okCount === 0) {
    return json({ error: "Sveve: " + sveveError, okCount }, 502);
  }

  return json({ ok: true, okCount, recipients: numbers.length, warning: sveveError });
});
