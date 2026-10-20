import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  show(t);
  setTimeout(() => hide(t), 2800);
}

let members = [];
let editingId = null;
let currentEmail = null;

// Skriv en linje til endringsloggen (hvem gjorde hva). Feiler stille.
async function logActivity(message) {
  try {
    await sb.from("activity_log").insert({ actor_email: currentEmail, message });
  } catch (_) { /* ignorer loggfeil */ }
}

// ---------- Auth (magic link / passordløs e-post) ----------
$("sendLink").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  hide($("loginError"));
  hide($("loginInfo"));
  if (!email || !email.includes("@")) {
    const e = $("loginError");
    e.textContent = "Skriv en gyldig e-postadresse.";
    show(e);
    return;
  }
  const btn = $("sendLink");
  btn.disabled = true;
  btn.textContent = "Sender…";
  // emailRedirectTo må ligge i Supabase sin redirect-allowlist.
  const redirect = window.location.href.split("#")[0].split("?")[0];
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirect },
  });
  btn.disabled = false;
  btn.textContent = "Send innloggingslenke";
  if (error) {
    const e = $("loginError");
    e.textContent = error.message;
    show(e);
  } else {
    const i = $("loginInfo");
    i.textContent = "✉️ Sjekk e-posten din – klikk lenken for å logge inn. (Kan ligge i søppelpost.)";
    show(i);
  }
});

// Enter i e-postfeltet sender lenken
$("loginEmail").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("sendLink").click();
});

$("logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    hide($("app"));
    show($("login"));
    return;
  }
  // Sjekk whitelist (RLS-funksjon). Hvis ikke tillatt -> logg ut.
  const { data: allowed, error } = await sb.rpc("is_allowed");
  if (error || !allowed) {
    await sb.auth.signOut();
    hide($("app"));
    show($("login"));
    const e = $("loginError");
    e.textContent = "Denne kontoen har ikke tilgang. Kontakt administrator.";
    show(e);
    return;
  }
  currentEmail = session.user.email;
  $("userEmail").textContent = session.user.email;
  hide($("login"));
  show($("app"));
  await loadMembers();
  await loadDashboard();
  await loadSmsLog();
}

// Kjør boot() utenfor callback-stacken – å gjøre Supabase-kall direkte inne i
// onAuthStateChange kan låse klienten. setTimeout(…, 0) unngår det.
// Denne fyrer også INITIAL_SESSION ved lasting, så vi trenger ikke et eget boot()-kall.
sb.auth.onAuthStateChange((_event, _session) => setTimeout(boot, 0));

// ---------- Tabs ----------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    ["home", "members", "dues", "sms", "economy", "docs"].forEach((t) =>
      $("tab-" + t).classList.toggle("hidden", tab !== t));
    if (tab === "home") loadDashboard();
    if (tab === "sms") { renderPickList(); updateSmsRecipients(); }
    if (tab === "economy") loadTransactions();
    if (tab === "dues") loadDues();
    if (tab === "docs") loadDocuments();
  });
});

// ---------- Members ----------
async function loadMembers() {
  const { data, error } = await sb.from("members").select("*").order("name");
  if (error) { toast("Feil ved lasting: " + error.message); return; }
  members = data ?? [];
  renderMembers();
}

function renderMembers() {
  const q = $("search").value.trim().toLowerCase();
  const list = $("memberList");
  const filtered = members.filter((m) =>
    !q || m.name.toLowerCase().includes(q) || (m.phone ?? "").includes(q));

  list.innerHTML = "";
  filtered.forEach((m) => {
    const li = document.createElement("li");
    li.className = "member";
    li.innerHTML = `
      <div>
        <div class="name">${escapeHtml(m.name)}</div>
        <div class="sub">${escapeHtml(m.phone)}${m.unit ? " · " + escapeHtml(m.unit) : ""}</div>
      </div>
      <span class="badge ${m.active ? "" : "inactive"}">${m.active ? "Aktiv" : "Inaktiv"}</span>
    `;
    li.addEventListener("click", () => openModal(m));
    list.appendChild(li);
  });

  const active = members.filter((m) => m.active).length;
  $("memberCount").textContent = `${members.length} medlemmer · ${active} aktive`;
  $("membersEmpty").classList.toggle("hidden", members.length > 0);
  updateSmsRecipients();
}

$("search").addEventListener("input", renderMembers);

// ---------- Modal ----------
$("addBtn").addEventListener("click", () => openModal(null));
$("modalCancel").addEventListener("click", closeModal);

function openModal(m) {
  editingId = m ? m.id : null;
  $("modalTitle").textContent = m ? "Rediger medlem" : "Nytt medlem";
  $("mName").value = m?.name ?? "";
  $("mPhone").value = m?.phone ?? "";
  $("mEmail").value = m?.email ?? "";
  $("mUnit").value = m?.unit ?? "";
  $("mActive").checked = m ? m.active : true;
  $("modalDelete").classList.toggle("hidden", !m);
  hide($("modalError"));
  show($("modal"));
}
function closeModal() { hide($("modal")); editingId = null; }

$("modalSave").addEventListener("click", async () => {
  const name = $("mName").value.trim();
  const phone = $("mPhone").value.trim().replace(/\s+/g, "");
  if (!name || phone.length < 8) {
    const e = $("modalError");
    e.textContent = "Navn og gyldig telefon (min. 8 siffer) kreves.";
    show(e);
    return;
  }
  const row = {
    name,
    phone,
    email: $("mEmail").value.trim() || null,
    unit: $("mUnit").value.trim() || null,
    active: $("mActive").checked,
  };
  let error;
  if (editingId) {
    ({ error } = await sb.from("members").update(row).eq("id", editingId));
  } else {
    ({ error } = await sb.from("members").insert(row));
  }
  if (error) { toast("Feil: " + error.message); return; }
  const wasEdit = !!editingId;
  logActivity(wasEdit ? `endret medlem «${name}»` : `la til medlem «${name}»`);
  closeModal();
  toast(wasEdit ? "Medlem oppdatert" : "Medlem lagt til");
  await loadMembers();
});

$("modalDelete").addEventListener("click", async () => {
  if (!editingId) return;
  if (!confirm("Slette dette medlemmet?")) return;
  const m = members.find((x) => x.id === editingId);
  const { error } = await sb.from("members").delete().eq("id", editingId);
  if (error) { toast("Feil: " + error.message); return; }
  logActivity(`slettet medlem «${m ? m.name : ""}»`);
  closeModal();
  toast("Medlem slettet");
  await loadMembers();
});

// ---------- SMS ----------
let smsMode = "all";          // "all" | "pick"
const smsSelected = new Set();

$("smsText").addEventListener("input", () => {
  const len = $("smsText").value.length;
  $("charCount").textContent = `${len} tegn · ${Math.max(1, Math.ceil(len / 160))} SMS pr. mottaker`;
});

$("rcpAll").addEventListener("click", () => setSmsMode("all"));
$("rcpPick").addEventListener("click", () => setSmsMode("pick"));

function setSmsMode(mode) {
  smsMode = mode;
  $("rcpAll").classList.toggle("active", mode === "all");
  $("rcpPick").classList.toggle("active", mode === "pick");
  $("pickList").classList.toggle("hidden", mode !== "pick");
  updateSmsRecipients();
}

function renderPickList() {
  const box = $("pickList");
  box.innerHTML = "";
  members.filter((m) => m.active).forEach((m) => {
    const row = document.createElement("label");
    row.className = "pick-row";
    row.innerHTML = `<input type="checkbox" value="${m.id}" ${smsSelected.has(m.id) ? "checked" : ""} />
      <span>${escapeHtml(m.name)} <span class="muted small">${escapeHtml(m.phone)}</span></span>`;
    row.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) smsSelected.add(m.id); else smsSelected.delete(m.id);
      updateSmsRecipients();
    });
    box.appendChild(row);
  });
}

function smsRecipientIds() {
  if (smsMode === "pick") {
    return members.filter((m) => m.active && smsSelected.has(m.id)).map((m) => m.id);
  }
  return members.filter((m) => m.active).map((m) => m.id);
}

function updateSmsRecipients() {
  $("smsRecipients").textContent = `${smsRecipientIds().length} mottakere`;
}

// Normaliser til +47 for norske 8-sifrede numre
function toMsisdn(raw) {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length === 8) return "+47" + d;
  if (d.startsWith("47") && d.length === 10) return "+" + d;
  return raw;
}

// Åpner iPhone/Android sin Meldinger-app med mottakere + ferdig tekst
function openMessages(numbers, message) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const sep = isIOS ? "&" : "?";
  const recips = numbers.map(toMsisdn).join(",");
  window.location.href = `sms:${recips}${sep}body=${encodeURIComponent(message)}`;
}

$("sendSms").addEventListener("click", async () => {
  const message = $("smsText").value.trim();
  if (!message) { toast("Skriv en melding først"); return; }
  const ids = new Set(smsRecipientIds());
  const recipients = members.filter((m) => ids.has(m.id));
  if (recipients.length === 0) { toast("Ingen mottakere valgt"); return; }

  // Logg at utsending ble startet (klient-side; RLS tillater whitelistet)
  const { data: { user } } = await sb.auth.getUser();
  await sb.from("sms_log").insert({
    sent_by: user?.email ?? null,
    message,
    recipients: recipients.length,
    ok_count: null,
    error: null,
  });
  loadSmsLog();
  logActivity(`startet SMS-utsending til ${recipients.length} mottakere`);

  const r = $("smsResult");
  r.className = "";
  r.textContent = `✉️ Åpner Meldinger med ${recipients.length} mottakere – trykk Send der. (Sendes fra din egen telefon.)`;
  show(r);

  openMessages(recipients.map((m) => m.phone), message);
});

async function loadSmsLog() {
  const { data } = await sb.from("sms_log").select("*").order("created_at", { ascending: false }).limit(10);
  const list = $("smsLog");
  list.innerHTML = "";
  (data ?? []).forEach((l) => {
    const li = document.createElement("li");
    li.className = "log-item";
    const when = new Date(l.created_at).toLocaleString("no-NO");
    li.innerHTML = `
      <div>${escapeHtml(l.message)}</div>
      <div class="when">${when} · ${l.ok_count ?? 0}/${l.recipients} sendt${l.error ? " · ⚠️ " + escapeHtml(l.error) : ""}</div>
    `;
    list.appendChild(li);
  });
}

// ---------- Økonomi ----------
let transactions = [];
let editingTrxId = null;
let trxKind = "expense";

const kr = (n) => new Intl.NumberFormat("no-NO", { maximumFractionDigits: 0 }).format(n) + " kr";

async function loadTransactions() {
  const { data, error } = await sb.from("transactions").select("*").order("trx_date", { ascending: false });
  if (error) { toast("Feil: " + error.message); return; }
  transactions = data ?? [];
  buildYearFilter();
  renderEconomy();
}

function buildYearFilter() {
  const sel = $("yearFilter");
  const years = [...new Set(transactions.map((t) => new Date(t.trx_date).getFullYear()))].sort((a, b) => b - a);
  if (years.length === 0) years.push(new Date().getFullYear());
  const current = sel.value || years[0];
  sel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
  sel.value = years.includes(+current) ? current : years[0];
}

$("yearFilter").addEventListener("change", renderEconomy);

function renderEconomy() {
  const year = +$("yearFilter").value;
  const rows = transactions.filter((t) => new Date(t.trx_date).getFullYear() === year);

  const income = rows.filter((t) => t.kind === "income").reduce((s, t) => s + Number(t.amount), 0);
  const expense = rows.filter((t) => t.kind === "expense").reduce((s, t) => s + Number(t.amount), 0);
  $("sumIncome").textContent = kr(income);
  $("sumExpense").textContent = "−" + kr(expense);
  const result = income - expense;
  $("sumResult").textContent = (result < 0 ? "−" : "") + kr(Math.abs(result));
  $("sumResult").className = result < 0 ? "neg" : "pos";

  // Per kategori
  const byCat = {};
  rows.forEach((t) => {
    const key = `${t.kind}|${t.category}`;
    byCat[key] = (byCat[key] ?? 0) + Number(t.amount);
  });
  const catList = $("categorySummary");
  catList.innerHTML = "";
  Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([key, sum]) => {
    const [kind, cat] = key.split("|");
    const li = document.createElement("li");
    li.className = "cat-item";
    li.innerHTML = `<span>${escapeHtml(cat)} <span class="muted small">(${kind === "income" ? "inntekt" : "utgift"})</span></span>
      <span class="${kind === "income" ? "pos" : "neg"}">${kind === "income" ? "" : "−"}${kr(sum)}</span>`;
    catList.appendChild(li);
  });

  // Posteringer
  const list = $("trxList");
  list.innerHTML = "";
  rows.forEach((t) => {
    const li = document.createElement("li");
    li.className = "trx";
    const d = new Date(t.trx_date).toLocaleDateString("no-NO");
    li.innerHTML = `
      <div>
        <div class="desc">${escapeHtml(t.description)}</div>
        <div class="meta">${d} · ${escapeHtml(t.category)}${t.receipt_path ? ' · <span class="clip">📎 bilag</span>' : ""}</div>
      </div>
      <div class="amt ${t.kind === "income" ? "pos" : "neg"}">${t.kind === "income" ? "" : "−"}${kr(Number(t.amount))}</div>
    `;
    li.addEventListener("click", () => openTrxModal(t));
    list.appendChild(li);
  });
  $("trxEmpty").classList.toggle("hidden", rows.length > 0);
}

// Modal
$("addTrxBtn").addEventListener("click", () => openTrxModal(null));
$("trxCancel").addEventListener("click", () => hide($("trxModal")));
$("kindExpense").addEventListener("click", () => setKind("expense"));
$("kindIncome").addEventListener("click", () => setKind("income"));

function setKind(k) {
  trxKind = k;
  $("kindExpense").classList.toggle("active", k === "expense");
  $("kindIncome").classList.toggle("active", k === "income");
}

function openTrxModal(t) {
  editingTrxId = t ? t.id : null;
  $("trxModalTitle").textContent = t ? "Rediger post" : "Ny post";
  setKind(t ? t.kind : "expense");
  $("tDesc").value = t?.description ?? "";
  $("tAmount").value = t?.amount ?? "";
  $("tDate").value = t ? t.trx_date : new Date().toISOString().slice(0, 10);
  $("tCategory").value = t?.category ?? "";
  $("tReceipt").value = "";
  $("trxDelete").classList.toggle("hidden", !t);
  const cur = $("tReceiptCurrent");
  if (t?.receipt_path) {
    cur.innerHTML = `📎 Lagret bilag – <a href="#" id="viewReceipt">vis</a>`;
    show(cur);
  } else { hide(cur); }
  hide($("trxError"));
  show($("trxModal"));

  const vr = $("viewReceipt");
  if (vr) vr.addEventListener("click", async (e) => {
    e.preventDefault();
    const { data } = await sb.storage.from("receipts").createSignedUrl(t.receipt_path, 120);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  });
}

$("trxSave").addEventListener("click", async () => {
  const description = $("tDesc").value.trim();
  const amount = parseFloat($("tAmount").value);
  if (!description || isNaN(amount) || amount < 0) {
    const e = $("trxError");
    e.textContent = "Beskrivelse og gyldig beløp kreves.";
    show(e);
    return;
  }

  $("trxSave").disabled = true;
  $("trxSave").textContent = "Lagrer…";

  // Last opp kvittering hvis valgt
  let receiptPath = undefined;
  const file = $("tReceipt").files[0];
  if (file) {
    const ext = file.name.split(".").pop();
    const path = `${new Date().getFullYear()}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await sb.storage.from("receipts").upload(path, file);
    if (upErr) {
      const e = $("trxError");
      e.textContent = "Opplasting feilet: " + upErr.message;
      show(e);
      $("trxSave").disabled = false; $("trxSave").textContent = "Lagre";
      return;
    }
    receiptPath = path;
  }

  const row = {
    kind: trxKind,
    description,
    amount,
    trx_date: $("tDate").value,
    category: $("tCategory").value.trim() || "Annet",
  };
  if (receiptPath !== undefined) row.receipt_path = receiptPath;

  let error;
  if (editingTrxId) {
    ({ error } = await sb.from("transactions").update(row).eq("id", editingTrxId));
  } else {
    ({ error } = await sb.from("transactions").insert(row));
  }
  $("trxSave").disabled = false; $("trxSave").textContent = "Lagre";
  if (error) { toast("Feil: " + error.message); return; }
  const wasEdit = !!editingTrxId;
  const kindLabel = trxKind === "income" ? "inntekt" : "utgift";
  logActivity(wasEdit
    ? `endret postering «${description}»`
    : `la til ${kindLabel} «${description}» (${trxKind === "income" ? "" : "−"}${kr(amount)})`);
  hide($("trxModal"));
  toast(wasEdit ? "Post oppdatert" : "Post lagt til");
  await loadTransactions();
});

$("trxDelete").addEventListener("click", async () => {
  if (!editingTrxId) return;
  if (!confirm("Slette denne posten?")) return;
  const trx = transactions.find((t) => t.id === editingTrxId);
  if (trx?.receipt_path) await sb.storage.from("receipts").remove([trx.receipt_path]);
  const { error } = await sb.from("transactions").delete().eq("id", editingTrxId);
  if (error) { toast("Feil: " + error.message); return; }
  logActivity(`slettet postering «${trx ? trx.description : ""}»`);
  hide($("trxModal"));
  toast("Post slettet");
  await loadTransactions();
});

// CSV-eksport for årsmøte / regnskap
$("exportCsv").addEventListener("click", () => {
  const year = +$("yearFilter").value;
  const rows = transactions.filter((t) => new Date(t.trx_date).getFullYear() === year);
  const header = "Dato;Type;Beskrivelse;Kategori;Beløp\n";
  const body = rows.map((t) =>
    [t.trx_date, t.kind === "income" ? "Inntekt" : "Utgift", t.description.replace(/;/g, ","), t.category, String(t.amount).replace(".", ",")].join(";")
  ).join("\n");
  const blob = new Blob(["﻿" + header + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `regnskap-fjedlavegen-${year}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// boot() trigges av onAuthStateChange sin INITIAL_SESSION – ikke kall den eksplisitt her.

// ---------- Kontingent ----------
let dues = [];

async function loadDues() {
  if (members.length === 0) await loadMembers();
  const { data, error } = await sb.from("dues").select("*");
  if (error) { toast("Feil: " + error.message); return; }
  dues = data ?? [];
  buildDuesYear();
  renderDues();
}

function buildDuesYear() {
  const sel = $("duesYear");
  const years = [...new Set(dues.map((d) => d.year))];
  const now = new Date().getFullYear();
  if (!years.includes(now)) years.push(now);
  years.sort((a, b) => b - a);
  const current = sel.value || now;
  sel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
  sel.value = years.includes(+current) ? current : years[0];
}

$("duesYear").addEventListener("change", renderDues);

function renderDues() {
  const year = +$("duesYear").value;
  const rows = dues.filter((d) => d.year === year);
  const byMember = (id) => members.find((m) => m.id === id);

  let paidSum = 0, owedSum = 0, paidCount = 0;
  const list = $("duesList");
  list.innerHTML = "";

  rows
    .map((d) => ({ d, m: byMember(d.member_id) }))
    .filter((x) => x.m)
    .sort((a, b) => a.m.name.localeCompare(b.m.name, "no"))
    .forEach(({ d, m }) => {
      if (d.paid) { paidSum += Number(d.amount); paidCount++; } else { owedSum += Number(d.amount); }
      const li = document.createElement("li");
      li.className = "dues-row" + (d.paid ? " paid" : "");
      li.innerHTML = `
        <input type="checkbox" ${d.paid ? "checked" : ""} />
        <span class="name">${escapeHtml(m.name)}</span>
        <span class="muted small">${kr(Number(d.amount))}</span>`;
      li.querySelector("input").addEventListener("change", async (e) => {
        const paid = e.target.checked;
        const { error } = await sb.from("dues")
          .update({ paid, paid_date: paid ? new Date().toISOString().slice(0, 10) : null })
          .eq("id", d.id);
        if (error) { toast("Feil: " + error.message); e.target.checked = !paid; return; }
        logActivity(`merket «${m.name}» som ${paid ? "betalt" : "ubetalt"} kontingent ${d.year}`);
        await loadDues();
      });
      list.appendChild(li);
    });

  $("duesPaid").textContent = kr(paidSum);
  $("duesOwed").textContent = kr(owedSum);
  $("duesStatus").textContent = `${paidCount} / ${rows.length} betalt`;
  $("duesEmpty").classList.toggle("hidden", rows.length > 0);
}

$("duesGenerate").addEventListener("click", async () => {
  const year = +$("duesYear").value;
  const amount = parseFloat($("duesAmount").value);
  if (isNaN(amount) || amount < 0) { toast("Oppgi et gyldig beløp"); return; }
  const existing = new Set(dues.filter((d) => d.year === year).map((d) => d.member_id));
  const newRows = members.filter((m) => m.active && !existing.has(m.id))
    .map((m) => ({ member_id: m.id, year, amount, paid: false }));
  if (newRows.length === 0) { toast("Alle aktive har allerede kontingent for " + year); return; }
  const { error } = await sb.from("dues").insert(newRows);
  if (error) { toast("Feil: " + error.message); return; }
  logActivity(`opprettet kontingent (${kr(amount)}) for ${newRows.length} medlemmer – ${year}`);
  toast(`Opprettet ${newRows.length} kontingentlinjer`);
  await loadDues();
});

$("duesPurr").addEventListener("click", async () => {
  const year = +$("duesYear").value;
  const unpaidIds = new Set(dues.filter((d) => d.year === year && !d.paid).map((d) => d.member_id));
  const unpaid = members.filter((m) => unpaidIds.has(m.id));
  if (unpaid.length === 0) { toast("Ingen ubetalte for " + year); return; }
  const defaultMsg = `Hei! Påminnelse om kontingent til Fjedlavegen veilag for ${year}. Vennlig hilsen styret.`;
  const message = prompt(`Purre-SMS til ${unpaid.length} ubetalte medlemmer (åpnes i Meldinger):`, defaultMsg);
  if (!message) return;
  openMessages(unpaid.map((m) => m.phone), message);
});

// ---------- Dokumenter ----------
let documents = [];

async function loadDocuments() {
  const { data, error } = await sb.from("documents").select("*").order("created_at", { ascending: false });
  if (error) { toast("Feil: " + error.message); return; }
  documents = data ?? [];
  renderDocuments();
}

function renderDocuments() {
  const list = $("docList");
  list.innerHTML = "";
  documents.forEach((doc) => {
    const li = document.createElement("li");
    li.className = "doc-item";
    const when = new Date(doc.created_at).toLocaleDateString("no-NO");
    li.innerHTML = `
      <div>
        <div class="title">${escapeHtml(doc.title)}</div>
        <div class="when">${when}</div>
      </div>
      <div class="doc-actions">
        <button class="linkbtn open">Åpne</button>
        <button class="linkbtn danger del">Slett</button>
      </div>`;
    li.querySelector(".open").addEventListener("click", async () => {
      const { data } = await sb.storage.from("documents").createSignedUrl(doc.file_path, 120);
      if (data?.signedUrl) window.open(data.signedUrl, "_blank");
    });
    li.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`Slette "${doc.title}"?`)) return;
      await sb.storage.from("documents").remove([doc.file_path]);
      await sb.from("documents").delete().eq("id", doc.id);
      logActivity(`slettet dokument «${doc.title}»`);
      toast("Dokument slettet");
      await loadDocuments();
    });
    list.appendChild(li);
  });
  $("docsEmpty").classList.toggle("hidden", documents.length > 0);
}

$("docUpload").addEventListener("click", async () => {
  const title = $("docTitle").value.trim();
  const file = $("docFile").files[0];
  if (!title || !file) { toast("Oppgi tittel og velg fil"); return; }
  const btn = $("docUpload");
  btn.disabled = true; btn.textContent = "Laster opp…";
  const ext = file.name.split(".").pop();
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await sb.storage.from("documents").upload(path, file);
  if (upErr) { toast("Opplasting feilet: " + upErr.message); btn.disabled = false; btn.textContent = "Last opp"; return; }
  const { error } = await sb.from("documents").insert({ title, file_path: path });
  btn.disabled = false; btn.textContent = "Last opp";
  if (error) { toast("Feil: " + error.message); return; }
  logActivity(`lastet opp dokument «${title}»`);
  $("docTitle").value = ""; $("docFile").value = "";
  toast("Dokument lastet opp");
  await loadDocuments();
});

// ---------- Hjem / Dashboard ----------
async function loadDashboard() {
  const year = new Date().getFullYear();
  $("dashHi").textContent = greeting();
  $("dashSub").textContent = `Oversikt for ${year}`;

  if (members.length === 0) await loadMembers();
  const active = members.filter((m) => m.active).length;
  $("stMembers").textContent = active;
  $("stMembersSub").textContent = `av ${members.length} totalt`;

  const [{ data: trx }, { data: dueRows }, { count: docCount }] = await Promise.all([
    sb.from("transactions").select("kind,amount,trx_date"),
    sb.from("dues").select("year,amount,paid"),
    sb.from("documents").select("*", { count: "exact", head: true }),
  ]);

  const thisYear = (trx ?? []).filter((t) => new Date(t.trx_date).getFullYear() === year);
  const income = thisYear.filter((t) => t.kind === "income").reduce((s, t) => s + Number(t.amount), 0);
  const expense = thisYear.filter((t) => t.kind === "expense").reduce((s, t) => s + Number(t.amount), 0);
  $("stIncome").textContent = kr(income);
  $("stExpense").textContent = "−" + kr(expense);
  const result = income - expense;
  $("stResult").textContent = (result < 0 ? "−" : "") + kr(Math.abs(result));
  $("stResult").className = "stat-val " + (result < 0 ? "neg" : "pos");

  const duesYear = (dueRows ?? []).filter((d) => d.year === year);
  const paidRows = duesYear.filter((d) => d.paid);
  $("stDues").textContent = duesYear.length ? `${paidRows.length}/${duesYear.length}` : "–";
  $("stDuesSub").textContent = duesYear.length
    ? `${kr(paidRows.reduce((s, d) => s + Number(d.amount), 0))} inn`
    : "ikke opprettet";

  $("stDocs").textContent = docCount ?? 0;

  await loadActivity();
}

function firstName(email) {
  const n = (email || "").split("@")[0].split(/[.\-_]/)[0];
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : "";
}

function greeting() {
  const h = new Date().getHours();
  const t = h < 10 ? "God morgen" : h < 18 ? "Hei" : "God kveld";
  const name = firstName(currentEmail);
  return `${t}${name ? " " + name : ""} 👋`;
}

async function loadActivity() {
  const { data } = await sb.from("activity_log").select("*")
    .order("created_at", { ascending: false }).limit(40);
  const list = $("activityList");
  list.innerHTML = "";
  (data ?? []).forEach((a) => {
    const li = document.createElement("li");
    li.className = "act-item";
    const who = a.actor_email ? firstName(a.actor_email) : "System";
    li.innerHTML = `
      <span class="act-ico">${iconFor(a.message)}</span>
      <div>
        <div class="act-msg">${escapeHtml(a.message)}</div>
        <div class="act-meta">${escapeHtml(who)} · ${timeAgo(a.created_at)}</div>
      </div>`;
    list.appendChild(li);
  });
  $("activityEmpty").classList.toggle("hidden", (data ?? []).length > 0);
}

function iconFor(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("medlem")) return "👤";
  if (m.includes("kontingent") || m.includes("betalt")) return "✅";
  if (m.includes("utgift") || m.includes("inntekt") || m.includes("postering") || m.includes("regnskap")) return "💰";
  if (m.includes("dokument")) return "📄";
  if (m.includes("sms") || m.includes("melding")) return "✉️";
  if (m.includes("opprettet") || m.includes("app") || m.includes("lansert")) return "🚀";
  return "•";
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "nå nettopp";
  const mn = Math.floor(s / 60); if (mn < 60) return `${mn} min siden`;
  const h = Math.floor(mn / 60); if (h < 24) return `${h} t siden`;
  const d = Math.floor(h / 24); if (d < 7) return `${d} d siden`;
  return new Date(iso).toLocaleDateString("no-NO");
}

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
