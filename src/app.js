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

// ---------- Auth ----------
$("googleLogin").addEventListener("click", async () => {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.href.split("#")[0] },
  });
  if (error) {
    const e = $("loginError");
    e.textContent = error.message;
    show(e);
  }
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
  $("userEmail").textContent = session.user.email;
  hide($("login"));
  show($("app"));
  await loadMembers();
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
    ["members", "dues", "sms", "economy", "docs"].forEach((t) =>
      $("tab-" + t).classList.toggle("hidden", tab !== t));
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
  closeModal();
  toast(editingId ? "Medlem oppdatert" : "Medlem lagt til");
  await loadMembers();
});

$("modalDelete").addEventListener("click", async () => {
  if (!editingId) return;
  if (!confirm("Slette dette medlemmet?")) return;
  const { error } = await sb.from("members").delete().eq("id", editingId);
  if (error) { toast("Feil: " + error.message); return; }
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

$("sendSms").addEventListener("click", async () => {
  const message = $("smsText").value.trim();
  if (!message) { toast("Skriv en melding først"); return; }
  const ids = smsRecipientIds();
  if (ids.length === 0) { toast("Ingen mottakere valgt"); return; }
  if (!confirm(`Sende SMS til ${ids.length} mottakere?`)) return;

  const btn = $("sendSms");
  btn.disabled = true;
  btn.textContent = "Sender…";

  const { data: { session } } = await sb.auth.getSession();
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ message, memberIds: ids }),
    });
    const result = await resp.json();
    const r = $("smsResult");
    if (resp.ok) {
      r.className = "";
      r.textContent = `✅ Sendt til ${result.okCount} av ${result.recipients} mottakere.`;
      $("smsText").value = "";
      $("charCount").textContent = "0 tegn";
      await loadSmsLog();
    } else {
      r.className = "error";
      r.textContent = "❌ " + (result.error ?? "Ukjent feil");
    }
    show(r);
  } catch (e) {
    const r = $("smsResult");
    r.className = "error";
    r.textContent = "❌ Nettverksfeil: " + e.message;
    show(r);
  } finally {
    btn.disabled = false;
    btn.textContent = "Send til alle aktive medlemmer";
  }
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
  hide($("trxModal"));
  toast(editingTrxId ? "Post oppdatert" : "Post lagt til");
  await loadTransactions();
});

$("trxDelete").addEventListener("click", async () => {
  if (!editingTrxId) return;
  if (!confirm("Slette denne posten?")) return;
  const trx = transactions.find((t) => t.id === editingTrxId);
  if (trx?.receipt_path) await sb.storage.from("receipts").remove([trx.receipt_path]);
  const { error } = await sb.from("transactions").delete().eq("id", editingTrxId);
  if (error) { toast("Feil: " + error.message); return; }
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
  toast(`Opprettet ${newRows.length} kontingentlinjer`);
  await loadDues();
});

$("duesPurr").addEventListener("click", async () => {
  const year = +$("duesYear").value;
  const unpaidIds = dues.filter((d) => d.year === year && !d.paid).map((d) => d.member_id);
  if (unpaidIds.length === 0) { toast("Ingen ubetalte for " + year); return; }
  const defaultMsg = `Hei! Påminnelse om kontingent til Fjedlavegen veilag for ${year}. Vennlig hilsen styret.`;
  const message = prompt(`Purre-SMS til ${unpaidIds.length} ubetalte medlemmer:`, defaultMsg);
  if (!message) return;

  const { data: { session } } = await sb.auth.getSession();
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ message, memberIds: unpaidIds }),
  });
  const result = await resp.json();
  toast(resp.ok ? `Purring sendt til ${result.okCount} medlemmer` : "Feil: " + (result.error ?? ""));
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
  $("docTitle").value = ""; $("docFile").value = "";
  toast("Dokument lastet opp");
  await loadDocuments();
});

// ---------- Utils ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
