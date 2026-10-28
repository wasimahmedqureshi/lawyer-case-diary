import { auth, db } from "./firebase-config.js";
import { TRIAL_DAYS, FEATURES, PLANS, PAYMENT } from "./config.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updateProfile, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, query, where,
  onSnapshot, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* =====================================================================
   helpers
   ===================================================================== */
window.__appBooted = true;   // set only if every import above loaded fine (used by the start-up watchdog)
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "₹" + Number(n).toLocaleString("en-IN");
const DAY = 86400000;
const MAX_FILE = 5 * 1024 * 1024;     // 5 MB per document
const CHUNK = 700000;                 // base64 characters per Firestore chunk (< 1 MiB doc limit)

function toast(msg, ms = 3400) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function addDaysISO(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}
function fmtDateObj(d) {
  return d ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
}
function fmtLongDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
}
function daysBetween(aISO, bISO) {
  return Math.round((new Date(bISO + "T00:00:00") - new Date(aISO + "T00:00:00")) / DAY);
}
function authMessage(e) {
  const map = {
    "auth/invalid-credential": "Wrong email or password.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/email-already-in-use": "This email is already registered. Please login.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Try again later.",
    "auth/network-request-failed": "Network error. Check your internet connection.",
    "auth/operation-not-allowed": "Email/Password sign-in is not enabled in Firebase Console."
  };
  return map[e.code] || e.message;
}

/* =====================================================================
   state
   ===================================================================== */
let currentUser = null;
let advocate = { name: "", enrolment: "" };
let account = { trialStart: null, subscribedUntil: null };
let cases = [];
let orders = [];
let editing = null;
let keptDocs = [];
let signupMode = false;
let signupInProgress = false;
let locked = false;               // true while the trial/plan has expired
let trialFixRequested = false;
let cart = null;                  // plan id or null
let checkoutOpen = false;
let screen = "splash";
let unsubCases = null, unsubAccount = null, unsubOrders = null, accessTimer = null;

const SCREENS = { splash: "splash", auth: "authScreen", plan: "planScreen", app: "appScreen" };
function showScreen(name) {
  screen = name;
  Object.entries(SCREENS).forEach(([k, id]) => $(id).classList.toggle("hidden", k !== name));
  window.scrollTo(0, 0);
}

/* =====================================================================
   authentication
   ===================================================================== */
function setAuthMode(signup) {
  signupMode = signup;
  $("tabLogin").classList.toggle("active", !signup);
  $("tabSignup").classList.toggle("active", signup);
  $("signupOnly").classList.toggle("hidden", !signup);
  $("authSubmit").textContent = signup ? `Create account · ${TRIAL_DAYS} days free` : "Login";
  $("authHeading").textContent = signup ? "Create your account" : "Welcome back";
  $("authSub").textContent = signup ? `Start your ${TRIAL_DAYS}-day free trial. No card needed.` : "Login to open your case diary.";
  $("authPassword").autocomplete = signup ? "new-password" : "current-password";
  $("authError").textContent = "";
}
$("tabLogin").onclick = () => setAuthMode(false);
$("tabSignup").onclick = () => setAuthMode(true);

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  $("authError").textContent = "";
  $("authSubmit").disabled = true;
  try {
    if (signupMode) {
      const name = $("authName").value.trim();
      if (!name) throw { code: "x", message: "Please enter the advocate name." };
      signupInProgress = true;
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      try {
        await updateProfile(cred.user, { displayName: name });
        await setDoc(doc(db, "advocates", cred.user.uid), {
          name, email, enrolment: $("authEnrol").value.trim(),
          trialStart: serverTimestamp(), createdAt: serverTimestamp()
        });
      } catch (inner) {
        await signOut(auth);
        throw inner;
      }
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (err) {
    $("authError").textContent = authMessage(err);
  } finally {
    signupInProgress = false;
    $("authSubmit").disabled = false;
  }
});

$("forgotBtn").onclick = async () => {
  const email = $("authEmail").value.trim();
  if (!email) { $("authError").textContent = "Enter your email above first."; return; }
  try {
    await sendPasswordResetEmail(auth, email);
    $("authError").textContent = "";
    toast("Password reset link sent to your email.");
  } catch (err) { $("authError").textContent = authMessage(err); }
};

$("logoutBtn").onclick = () => signOut(auth);
$("planLogout").onclick = () => signOut(auth);

function stopAll() {
  [unsubCases, unsubAccount, unsubOrders].forEach((u) => u && u());
  unsubCases = unsubAccount = unsubOrders = null;
  live.server = false; live.lastSync = null;
  clearInterval(accessTimer);
  accessTimer = null;
}

onAuthStateChanged(auth, (user) => {
  stopAll();
  currentUser = user;
  cases = []; orders = []; cart = null; checkoutOpen = false;
  locked = false; trialFixRequested = false;
  account = { trialStart: null, subscribedUntil: null };
  if (!user) { showScreen("auth"); return; }

  showScreen("splash");
  const accRef = doc(db, "advocates", user.uid);

  unsubAccount = onSnapshot(accRef, async (snap) => {
    if (!snap.exists()) {
      if (signupInProgress) return;               // the sign-up form is creating it right now
      try {
        await setDoc(accRef, {
          name: user.displayName || "", email: user.email || "", enrolment: "",
          trialStart: serverTimestamp(), createdAt: serverTimestamp()
        });
      } catch (err) { console.error(err); toast("Could not create your account profile: " + err.message); }
      return;
    }
    const d = snap.data({ serverTimestamps: "estimate" });
    if (!d.trialStart) {                          // older account without a trial date
      if (!trialFixRequested) {
        trialFixRequested = true;
        updateDoc(accRef, { trialStart: serverTimestamp() }).catch((e) => console.error(e));
      }
      return;
    }
    advocate = { name: d.name || user.displayName || user.email, enrolment: d.enrolment || "" };
    account = {
      trialStart: d.trialStart.toDate(),
      subscribedUntil: d.subscribedUntil ? d.subscribedUntil.toDate() : null
    };
    applyAccess();
  }, (err) => {
    console.error(err);
    showScreen("auth");
    $("authError").textContent = "Could not load your account: " + err.message;
  });

  unsubOrders = onSnapshot(query(collection(db, "orders"), where("uid", "==", user.uid)), (snap) => {
    orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    orders.sort((a, b) => (b.createdAt?.toMillis?.() ?? Date.now()) - (a.createdAt?.toMillis?.() ?? Date.now()));
    renderOrders();
  }, () => { /* orders are optional */ });

  accessTimer = setInterval(applyAccess, 60000);
});

/* =====================================================================
   trial / subscription state
   ===================================================================== */
function accessState() {
  const now = Date.now();
  if (account.subscribedUntil && account.subscribedUntil.getTime() > now) {
    return { status: "paid", daysLeft: Math.ceil((account.subscribedUntil.getTime() - now) / DAY), end: account.subscribedUntil };
  }
  const end = new Date(account.trialStart.getTime() + TRIAL_DAYS * DAY);
  if (now < end.getTime()) return { status: "trial", daysLeft: Math.ceil((end.getTime() - now) / DAY), end };
  return { status: "expired", daysLeft: 0, end };
}

function updatePill(st) {
  const p = $("planPill");
  p.classList.remove("warn", "ok");
  const s = st.daysLeft === 1 ? "" : "s";
  if (st.status === "paid") {
    p.textContent = `✔ Premium · ${st.daysLeft} day${s} left`;
    p.classList.add(st.daysLeft <= 7 ? "warn" : "ok");
  } else {
    p.textContent = `🎁 Free trial · ${st.daysLeft} day${s} left`;
    if (st.daysLeft <= 7) p.classList.add("warn");
  }
}

function applyAccess() {
  if (!currentUser || !account.trialStart) return;
  const st = accessState();
  $("advName").textContent = advocate.name;
  $("welcome").textContent = `Welcome, ${advocate.name}`;

  if (st.status === "expired") {
    if (unsubCases) { unsubCases(); unsubCases = null; }
    locked = true;
    openPlans();
    return;
  }
  updatePill(st);
  if (locked) {
    locked = false;
    showScreen("app");
    toast("✔ Subscription active. Thank you!");
  } else if (screen === "splash") {
    showScreen("app");
  }
  if (!unsubCases) startCases();
  if (screen === "plan") renderPlanHeader();
}

function startCases() {
  const q = query(collection(db, "cases"), where("advocateId", "==", currentUser.uid));
  unsubCases = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    live.server = !snap.metadata.fromCache;       // true = data confirmed by the Firebase server
    if (live.server) live.lastSync = new Date();
    updateLive();
    cases = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cases.sort((a, b) => (b.createdAt?.toMillis?.() ?? Date.now()) - (a.createdAt?.toMillis?.() ?? Date.now()));
    render();
  }, (err) => {
    console.error(err);
    live.server = false;
    updateLive();
    toast("Could not load cases: " + err.message);
  });
}

/* ---------- live connection indicator (green dot) ---------- */
const live = { server: false, lastSync: null };
function updateLive() {
  const el = $("liveDot");
  if (!el) return;
  const online = navigator.onLine !== false;
  let state = "connecting", label = "Connecting…", tip = "Connecting to the server…";
  if (!online) { state = "off"; label = "Offline"; tip = "No internet connection. Changes are saved on this device and will sync when you are back online."; }
  else if (live.server) {
    state = "on"; label = "Live";
    tip = "Live: connected to the backend database" + (live.lastSync ? ` · last synced ${live.lastSync.toLocaleTimeString("en-IN")}` : "");
  }
  el.className = "live " + state;
  el.title = tip;
  el.querySelector("b").textContent = label;
}
window.addEventListener("online", updateLive);
window.addEventListener("offline", updateLive);

/* =====================================================================
   plans · cart · checkout
   ===================================================================== */
$("planPill").onclick = () => openPlans();
$("planBack").onclick = () => { if (!locked) showScreen("app"); };

function openPlans() {
  showScreen("plan");
  $("planBack").classList.toggle("hidden", locked);
  renderPlanHeader();
  renderPlanGrid();
  renderCart();
  renderOrders();
  const parts = [];
  if (PAYMENT.supportWhatsApp) parts.push(`<a href="https://wa.me/${esc(PAYMENT.supportWhatsApp)}" target="_blank" rel="noopener">WhatsApp support</a>`);
  if (PAYMENT.supportEmail) parts.push(`<a href="mailto:${esc(PAYMENT.supportEmail)}">${esc(PAYMENT.supportEmail)}</a>`);
  $("planSupport").innerHTML = parts.length ? "Need help with payment? " + parts.join(" · ") : "";
}

function renderPlanHeader() {
  if (!account.trialStart) return;
  const st = accessState();
  const h = $("planHeading"), s = $("planSub");
  if (st.status === "expired") {
    h.textContent = `Your ${TRIAL_DAYS}-day free trial has ended`;
    s.textContent = "Subscribe to continue using Lawyer Case Diary. Your cases and documents are safe and will be back as soon as your plan is active.";
  } else if (st.status === "paid") {
    h.textContent = "Your plan is active";
    s.textContent = `Premium is valid until ${fmtDateObj(st.end)} (${st.daysLeft} days left). You can renew early below.`;
  } else {
    h.textContent = "Choose your plan";
    s.textContent = `You have ${st.daysLeft} day${st.daysLeft === 1 ? "" : "s"} of free trial left (until ${fmtDateObj(st.end)}). Subscribe any time to keep going without a break.`;
  }
}

function renderPlanGrid() {
  $("planGrid").innerHTML = PLANS.map((p) => `
    <div class="plan ${p.best ? "best" : ""}">
      ${p.tag ? `<div class="ribbon">${esc(p.tag)}</div>` : ""}
      <h3>${esc(p.name)}</h3>
      <div class="price">${money(p.price)}<small> / ${esc(p.period)}</small></div>
      <ul>${FEATURES.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      <button class="btn ${p.best ? "gold" : "primary"} block" type="button" data-act="add" data-plan="${esc(p.id)}">🛒 Add to cart</button>
    </div>`).join("");
}

function renderCart() {
  const plan = PLANS.find((p) => p.id === cart);
  const cartBox = $("cartBox"), coBox = $("checkoutBox");
  if (!plan) { cartBox.classList.add("hidden"); coBox.classList.add("hidden"); return; }

  cartBox.classList.remove("hidden");
  cartBox.innerHTML = `
    <h3 class="sec">🛒 Your cart</h3>
    <div class="cart-row">
      <div><b>Lawyer Case Diary — ${esc(plan.name)}</b><div class="muted small">${plan.days} days of full access</div></div>
      <div><b>${money(plan.price)}</b> &nbsp; <button class="btn sm danger" type="button" data-act="remove">Remove</button></div>
    </div>
    <div class="cart-total"><span>Total</span><span>${money(plan.price)}</span></div>
    ${checkoutOpen ? "" : `<div class="cart-actions"><button class="btn gold lg" type="button" data-act="checkout">Proceed to checkout →</button></div>`}`;

  if (!checkoutOpen) { coBox.classList.add("hidden"); return; }

  const upiLink = `upi://pay?pa=${encodeURIComponent(PAYMENT.upiId)}&pn=${encodeURIComponent(PAYMENT.payeeName)}&am=${plan.price}&cu=INR&tn=${encodeURIComponent("Lawyer Case Diary " + plan.name)}`;
  const notSet = /^yourupiid/i.test(PAYMENT.upiId);
  coBox.classList.remove("hidden");
  coBox.innerHTML = `
    <h3 class="sec">Checkout · ${money(plan.price)}</h3>
    ${notSet ? `<p class="error">Owner note: set your real UPI ID in <code>js/config.js</code> before publishing.</p>` : ""}
    <div class="steps">
      <div class="step"><div class="step-n">1</div><div>
        <b>Pay ${money(plan.price)} by UPI</b>
        <div class="upi-box"><span>${esc(PAYMENT.upiId)}</span><button class="btn sm" type="button" data-act="copy">Copy</button></div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn gold sm" href="${esc(upiLink)}">Pay with UPI app</a>
          ${PAYMENT.paymentLink ? `<a class="btn sm" href="${esc(PAYMENT.paymentLink)}" target="_blank" rel="noopener">Pay online</a>` : ""}
        </div>
      </div></div>
      <div class="step"><div class="step-n">2</div><div style="flex:1">
        <b>Enter your payment details</b>
        <label style="margin-top:8px">UPI transaction ID / UTR number
          <input id="payRef" type="text" placeholder="e.g. 4061xxxxxxx" />
        </label>
        <label>Your mobile number
          <input id="payPhone" type="tel" inputmode="numeric" maxlength="15" placeholder="10-digit mobile" />
        </label>
      </div></div>
      <div class="step"><div class="step-n">3</div><div style="flex:1">
        <b>Submit for activation</b>
        <p class="muted small" style="margin:4px 0 8px">Your plan is switched on after the payment is verified (usually within a few hours). This page updates by itself.</p>
        <div class="cart-actions" style="justify-content:flex-start">
          <button class="btn ghost" type="button" data-act="backcart">← Back</button>
          <button class="btn primary lg" type="button" data-act="submit" id="submitOrder">Submit payment</button>
        </div>
        <p id="checkoutError" class="error"></p>
      </div></div>
    </div>`;
}

function renderOrders() {
  const box = $("orderBox");
  if (!orders.length) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  box.innerHTML = `<h3 class="sec">Your payment requests</h3>` + orders.map((o) => {
    const ok = o.status === "approved";
    return `<div class="order-row">
      <span><b>${esc(o.planName)}</b> · ${money(o.amount)}</span>
      <span class="muted">Ref: ${esc(o.reference)}</span>
      <span class="badge ${ok ? "ok" : "warn"}">${ok ? "Activated" : "Pending verification"}</span>
    </div>`;
  }).join("");
}

$("planScreen").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "add") { cart = btn.dataset.plan; checkoutOpen = false; renderCart(); $("cartBox").scrollIntoView({ behavior: "smooth", block: "center" }); }
  if (act === "remove") { cart = null; checkoutOpen = false; renderCart(); }
  if (act === "checkout") { checkoutOpen = true; renderCart(); $("checkoutBox").scrollIntoView({ behavior: "smooth", block: "start" }); }
  if (act === "backcart") { checkoutOpen = false; renderCart(); }
  if (act === "copy") {
    try { await navigator.clipboard.writeText(PAYMENT.upiId); toast("UPI ID copied"); }
    catch (_) { toast("Copy not available — please type the UPI ID."); }
  }
  if (act === "submit") submitOrder();
});

async function submitOrder() {
  const plan = PLANS.find((p) => p.id === cart);
  if (!plan) return;
  const reference = ($("payRef").value || "").trim();
  const phone = ($("payPhone").value || "").replace(/\D/g, "");
  const err = $("checkoutError");
  err.textContent = "";
  if (reference.length < 6) { err.textContent = "Please enter the UPI transaction ID / UTR number."; return; }
  if (phone.length < 10) { err.textContent = "Please enter a valid mobile number."; return; }
  const btn = $("submitOrder");
  btn.disabled = true; btn.textContent = "Submitting…";
  try {
    await withTimeout(addDoc(collection(db, "orders"), {
      uid: currentUser.uid, email: currentUser.email || "", name: advocate.name,
      planId: plan.id, planName: plan.name, amount: plan.price, days: plan.days,
      reference, phone, status: "pending", createdAt: serverTimestamp()
    }), 20000, "Request timed out. Check your internet and try again.");
    cart = null; checkoutOpen = false;
    renderCart();
    toast("✔ Payment submitted. We will activate your plan after verification.", 6000);
    $("orderBox").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (e) {
    err.textContent = "Could not submit: " + (e.message || e);
    btn.disabled = false; btn.textContent = "Submit payment";
  }
}

/* =====================================================================
   case list rendering
   ===================================================================== */
function dayLabel(iso, today) {
  const n = daysBetween(today, iso);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n > 1) return `In ${n} days`;
  return `${-n} day${n === -1 ? "" : "s"} ago`;
}

function upItem(c, today, cls = "") {
  const [, m, d] = c.nextHearing.split("-");
  const mon = new Date(c.nextHearing + "T00:00:00").toLocaleDateString("en-IN", { month: "short" });
  return `<div class="up-item" data-edit="${esc(c.id)}">
    <div class="up-date ${cls}"><b>${esc(d)}</b><span>${esc(mon)}</span></div>
    <div>
      <div class="up-title">${esc(c.appellant)} vs ${esc(c.respondent)}</div>
      <div class="up-sub">${esc(c.caseNumber)} · ${esc(dayLabel(c.nextHearing, today))}</div>
    </div>
  </div>`;
}

function render() {
  const term = $("searchInput").value.trim().toLowerCase();
  const status = $("statusFilter").value;
  const today = todayISO();
  const weekEnd = addDaysISO(today, 7);
  const pending = cases.filter((c) => c.status !== "Disposed");

  $("statTotal").textContent = cases.length;
  $("statPending").textContent = pending.length;
  $("statDisposed").textContent = cases.length - pending.length;
  $("statWeek").textContent = pending.filter((c) => c.nextHearing >= today && c.nextHearing <= weekEnd).length;

  // side panels
  const upcoming = pending.filter((c) => c.nextHearing && c.nextHearing >= today)
    .sort((a, b) => a.nextHearing.localeCompare(b.nextHearing)).slice(0, 8);
  $("upcomingList").innerHTML = upcoming.length
    ? upcoming.map((c) => upItem(c, today, c.nextHearing === today ? "today" : "")).join("")
    : `<div class="up-empty">No upcoming hearings.</div>`;
  const overdue = pending.filter((c) => c.nextHearing && c.nextHearing < today)
    .sort((a, b) => b.nextHearing.localeCompare(a.nextHearing)).slice(0, 6);
  $("overduePanel").classList.toggle("hidden", !overdue.length);
  $("overdueList").innerHTML = overdue.map((c) => upItem(c, today, "late")).join("");

  // main list
  const filtered = cases.filter((c) => {
    if (status !== "all" && (c.status || "Pending") !== status) return false;
    if (!term) return true;
    const hay = [c.caseNumber, c.appellant, c.respondent, c.clientName, c.section, c.caseType, c.courtName,
      c.division, c.district, c.tehsil, c.village, c.khasra, c.notes, c.clientPhone].join(" ").toLowerCase();
    return hay.includes(term);
  });

  $("emptyMsg").classList.toggle("hidden", filtered.length > 0);
  $("caseList").innerHTML = filtered.map((c) => {
    const disposed = c.status === "Disposed";
    const isToday = !disposed && c.nextHearing === today;
    const late = !disposed && c.nextHearing && c.nextHearing < today;
    const docs = (c.documents || []).map((d) => d.url
      ? `<a class="doc-chip" href="${esc(d.url)}" target="_blank" rel="noopener">📎 ${esc(d.name)}</a>`
      : `<button class="doc-chip" type="button" data-open="${esc(c.id)}" data-file="${esc(d.id)}">📎 ${esc(d.name)}</button>`).join("");
    let badge;
    if (disposed) badge = `<span class="badge ok">Disposed ${esc(fmtDate(c.disposalDate))}</span>`;
    else if (isToday) badge = `<span class="badge warn">Hearing TODAY</span>`;
    else if (late) badge = `<span class="badge late">Date passed · ${esc(fmtDate(c.nextHearing))}</span>`;
    else if (c.nextHearing) badge = `<span class="badge">Next: ${esc(fmtDate(c.nextHearing))}</span>`;
    else badge = `<span class="badge">No hearing date</span>`;
    return `
    <article class="case-card ${disposed ? "disposed" : ""} ${isToday ? "today" : ""} ${late ? "late" : ""}">
      <div class="case-head"><span class="case-no">${esc(c.caseNumber)}</span>${badge}</div>
      <div class="parties"><b>${esc(c.appellant)}</b><span class="vs">vs</span><b>${esc(c.respondent)}</b></div>
      <div class="meta">
        <span><b>Type:</b> ${esc(c.caseType)}</span>
        <span><b>Section:</b> ${esc(c.section)}</span>
        <span><b>Court:</b> ${esc(c.courtName)}</span>
        ${c.clientName ? `<span><b>Client:</b> ${esc(c.clientName)}</span>` : ""}
        <span><b>Location:</b> ${esc([c.village, c.tehsil, c.district, c.division].filter(Boolean).join(", ") || "—")}</span>
        ${c.khasra ? `<span><b>Khasra:</b> ${esc(c.khasra)}</span>` : ""}
      </div>
      ${c.notes ? `<p class="muted" style="margin:8px 0 0">${esc(c.notes)}</p>` : ""}
      ${(c.hearingHistory || []).length ? `<p class="muted small" style="margin:6px 0 0"><b>Previous dates:</b> ${
        c.hearingHistory.slice(-5).map((h) => esc(fmtDate(h.date)) + (h.note ? ` (${esc(h.note)})` : "")).join(" · ")}</p>` : ""}
      ${miniRow(c)}
      <div class="case-actions">
        ${disposed ? "" : `<button class="btn sm gold" data-next="${esc(c.id)}" type="button">📅 Next date</button>`}
        <button class="btn sm" data-edit="${esc(c.id)}" type="button">✏️ Edit</button>
        <button class="btn sm danger" data-del="${esc(c.id)}" type="button">🗑 Delete</button>
        ${docs}
      </div>
    </article>`;
  }).join("");
  renderBanner(pending, today);
  refreshViews();
}

$("searchInput").addEventListener("input", render);
$("statusFilter").addEventListener("change", render);

function onListClick(e) {
  const edit = e.target.closest("[data-edit]");
  const del = e.target.closest("[data-del]");
  const open = e.target.closest("[data-open]");
  const nxt = e.target.closest("[data-next]");
  const sh = e.target.closest("[data-share]");
  if (sh) { const c = cases.find((x) => x.id === sh.dataset.share); if (c) openWhatsApp(phoneDigits(c.clientPhone), caseShareText(c)); return; }
  if (open) { openPreview(open.dataset.open, open.dataset.file); return; }
  if (nxt) { openDateModal(cases.find((c) => c.id === nxt.dataset.next)); return; }
  if (edit) openCaseModal(cases.find((c) => c.id === edit.dataset.edit));
  if (del) deleteCase(cases.find((c) => c.id === del.dataset.del));
}
$("caseList").addEventListener("click", onListClick);
$("upcomingList").addEventListener("click", onListClick);
$("overdueList").addEventListener("click", onListClick);

/* =====================================================================
   documents (stored inside Firestore as small chunks – no Storage needed)
   ===================================================================== */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error || new Error("Could not read the file."));
    r.readAsDataURL(file);
  });
}

async function saveFile(caseId, file, onProgress) {
  const b64 = await fileToBase64(file);
  const fileId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const n = Math.max(1, Math.ceil(b64.length / CHUNK));
  for (let i = 0; i < n; i++) {
    await withTimeout(
      setDoc(doc(db, "cases", caseId, "chunks", `${fileId}_${i}`), {
        fileId, index: i, data: b64.slice(i * CHUNK, (i + 1) * CHUNK)
      }),
      30000, "Upload timed out. Check your internet connection and the Firestore rules."
    );
    onProgress((i + 1) / n);
  }
  return { id: fileId, name: file.name, size: file.size, type: file.type || "application/octet-stream", chunks: n };
}

async function removeFileChunks(caseId, d) {
  if (!d.chunks) return;
  await Promise.all(Array.from({ length: d.chunks }, (_, i) =>
    deleteDoc(doc(db, "cases", caseId, "chunks", `${d.id}_${i}`)).catch(() => {})));
}

const blobCache = new Map();
async function loadDocBlob(caseId, d) {
  const key = caseId + "_" + d.id;
  if (blobCache.has(key)) return blobCache.get(key);
  const snaps = await withTimeout(
    Promise.all(Array.from({ length: d.chunks }, (_, i) => getDoc(doc(db, "cases", caseId, "chunks", `${d.id}_${i}`)))),
    40000, "Timed out while loading the document."
  );
  const b64 = snaps.map((s) => s.data().data).join("");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: d.type || "application/octet-stream" });
  if (blobCache.size > 4) blobCache.delete(blobCache.keys().next().value);
  blobCache.set(key, blob);
  return blob;
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
async function ensurePdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = PDFJS + "pdf.min.js";
    sc.onload = resolve;
    sc.onerror = () => reject(new Error("PDF viewer could not be loaded"));
    document.head.appendChild(sc);
  });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
  return window.pdfjsLib;
}

async function renderPdfPages(container, blob, token) {
  const lib = await ensurePdfJs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const maxPages = Math.min(pdf.numPages, 40);
  const width = Math.max(240, container.clientWidth - 6);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  container.innerHTML = "";
  for (let n = 1; n <= maxPages; n++) {
    if (container._tok !== token) return;
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (width / base.width) * dpr });
    const canvas = document.createElement("canvas");
    canvas.className = "pv-page";
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.width = width + "px";
    canvas.style.height = vp.height / dpr + "px";
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  }
  if (pdf.numPages > maxPages) {
    const note = document.createElement("p");
    note.className = "muted center";
    note.textContent = `Showing first ${maxPages} of ${pdf.numPages} pages. Download to see all.`;
    container.appendChild(note);
  }
}

// Draws a preview of document `d` of case `caseId` into `container`
async function renderPreview(container, caseId, d) {
  const token = Symbol();
  container._tok = token;
  container.innerHTML = `<div class="pv-loading"><span class="spin"></span> Loading preview…</div>`;
  try {
    const blob = await loadDocBlob(caseId, d);
    if (container._tok !== token) return blob;
    const type = (d.type || "").toLowerCase();
    const name = (d.name || "").toLowerCase();
    if (type.startsWith("image/")) {
      container.innerHTML = "";
      const img = document.createElement("img");
      img.className = "pv-img";
      img.alt = d.name;
      img.src = URL.createObjectURL(blob);
      container.appendChild(img);
    } else if (type === "application/pdf" || name.endsWith(".pdf")) {
      try {
        await renderPdfPages(container, blob, token);
      } catch (pdfErr) {
        console.warn("pdf.js failed, falling back to the browser viewer", pdfErr);
        container.innerHTML = "";
        const fr = document.createElement("iframe");
        fr.className = "pv-frame";
        fr.src = URL.createObjectURL(blob);
        container.appendChild(fr);
      }
    } else if (type.startsWith("text/") || name.endsWith(".txt")) {
      container.innerHTML = "";
      const pre = document.createElement("pre");
      pre.className = "pv-text";
      pre.textContent = (await blob.text()).slice(0, 30000);
      container.appendChild(pre);
    } else {
      container.innerHTML = `<div class="pv-loading">Preview is not available for this file type.<br/>Use <b>Download</b> to open it.</div>`;
    }
    return blob;
  } catch (err) {
    console.error(err);
    if (container._tok === token) container.innerHTML = `<p class="error">Could not load the preview: ${esc(err.message || err)}</p>`;
  }
}

let previewCurrent = null;
async function openPreview(caseId, fileId) {
  const c = cases.find((x) => x.id === caseId);
  const d = (c?.documents || []).find((x) => x.id === fileId);
  if (!d) return;
  previewCurrent = { caseId, d };
  $("previewTitle").textContent = d.name;
  $("previewModal").classList.remove("hidden");
  await renderPreview($("previewBody"), caseId, d);
}
$("closePreview").onclick = () => { $("previewModal").classList.add("hidden"); $("previewBody").innerHTML = ""; previewCurrent = null; };
$("previewDownload").onclick = async () => {
  if (!previewCurrent) return;
  try { triggerDownload(await loadDocBlob(previewCurrent.caseId, previewCurrent.d), previewCurrent.d.name); }
  catch (err) { toast("Could not download: " + (err.message || err), 5000); }
};

/* =====================================================================
   case modal
   ===================================================================== */
const form = $("caseForm");
const FIELDS = ["clientName", "appellant", "respondent", "caseType", "section", "courtName", "division",
  "district", "tehsil", "village", "khasra", "nextHearing", "status", "disposalDate", "notes",
  "clientPhone", "totalFee", "feeReceived"];

function toggleDisposal() {
  $("disposalWrap").classList.toggle("hidden", form.status.value !== "Disposed");
}
form.status.addEventListener("change", toggleDisposal);

function openCaseModal(c = null) {
  editing = c;
  form.reset();
  $("caseError").textContent = "";
  $("fileInput").value = "";
  $("uploadProgress").classList.add("hidden");
  $("uploadBar").style.width = "0";
  $("uploadLabel").textContent = "";
  $("caseModalTitle").textContent = c ? "Edit case" : "New case";
  $("caseNoPreview").textContent = c ? c.caseNumber : "Will be generated automatically on save";
  keptDocs = c ? [...(c.documents || [])] : [];
  if (c) FIELDS.forEach((f) => { if (form[f]) form[f].value = c[f] ?? ""; });
  else form.status.value = "Pending";
  toggleDisposal();
  renderExistingDocs();
  $("caseModal").classList.remove("hidden");
}
function closeCaseModal() { $("caseModal").classList.add("hidden"); editing = null; }

function renderExistingDocs() {
  $("existingDocs").innerHTML = keptDocs.map((d, i) => `
    <div class="doc-row">
      <span>📎 ${esc(d.name)}</span>
      <button class="btn sm danger" type="button" data-rm="${i}">Remove</button>
    </div>`).join("");
}
$("existingDocs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-rm]");
  if (!b) return;
  keptDocs.splice(Number(b.dataset.rm), 1);
  renderExistingDocs();
});

$("addBtn").onclick = () => openCaseModal(null);
$("fabAdd").onclick = () => openCaseModal(null);
$("closeCaseModal").onclick = closeCaseModal;
$("cancelCase").onclick = closeCaseModal;

async function createCaseWithNumber(uid, data) {
  const year = new Date().getFullYear();
  const counterRef = doc(db, "counters", uid);
  const caseRef = doc(collection(db, "cases"));
  const caseNumber = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const last = snap.exists() ? (snap.data()[`y${year}`] || 0) : 0;
    const next = last + 1;
    const number = `CD/${year}/${String(next).padStart(4, "0")}`;
    tx.set(counterRef, { [`y${year}`]: next }, { merge: true });
    tx.set(caseRef, {
      ...data, advocateId: uid, caseNumber: number,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    return number;
  });
  return { id: caseRef.id, caseNumber };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("caseError").textContent = "";
  const files = [...$("fileInput").files];
  const tooBig = files.find((f) => f.size > MAX_FILE);
  if (tooBig) { $("caseError").textContent = `"${tooBig.name}" is larger than 5 MB. Please compress or split it.`; return; }

  const data = {};
  FIELDS.forEach((f) => { data[f] = (form[f].value || "").trim(); });
  data.totalFee = Math.max(0, Number(data.totalFee) || 0);
  data.feeReceived = Math.max(0, Number(data.feeReceived) || 0);
  if (data.status !== "Disposed") data.disposalDate = "";
  if (data.status === "Disposed" && !data.disposalDate) {
    $("caseError").textContent = "Please enter the disposal date."; return;
  }

  $("saveCase").disabled = true;
  $("saveCase").textContent = "Saving…";
  try {
    const uid = currentUser.uid;
    let caseId, savedNumber = "", removedDocs = [];

    if (editing) {
      caseId = editing.id;
      savedNumber = editing.caseNumber;
      removedDocs = (editing.documents || []).filter((d) => !keptDocs.some((k) => k.id === d.id));
      await withTimeout(updateDoc(doc(db, "cases", caseId), { ...data, documents: keptDocs, updatedAt: serverTimestamp() }),
        20000, "Saving timed out. Check your internet connection.");
    } else {
      const created = await withTimeout(createCaseWithNumber(uid, { ...data, documents: [] }),
        20000, "Saving timed out. Check your internet connection and Firestore rules.");
      caseId = created.id;
      savedNumber = created.caseNumber;
    }

    let uploadWarning = "";
    let uploadedItems = [];
    if (files.length) {
      $("uploadProgress").classList.remove("hidden");
      const uploaded = [];
      try {
        for (let i = 0; i < files.length; i++) {
          $("uploadLabel").textContent = `Uploading ${i + 1} of ${files.length}: ${files[i].name}`;
          const item = await saveFile(caseId, files[i], (p) => {
            $("uploadBar").style.width = `${((i + p) / files.length) * 100}%`;
          });
          uploaded.push(item);
        }
      } catch (upErr) {
        console.error(upErr);
        uploadWarning = "Case saved, but a document could not be uploaded: " + (upErr.message || upErr) +
          " You can open the case with Edit and attach it again.";
      }
      if (uploaded.length) {
        uploadedItems = uploaded;
        await updateDoc(doc(db, "cases", caseId), { documents: [...keptDocs, ...uploaded], updatedAt: serverTimestamp() });
      }
    }

    await Promise.all(removedDocs.map((d) => removeFileChunks(caseId, d)));

    const wasEdit = !!editing;
    closeCaseModal();
    showSuccess(wasEdit ? "Case updated successfully" : "Case saved successfully", savedNumber, uploadWarning, caseId, uploadedItems);
  } catch (err) {
    console.error(err);
    $("caseError").textContent = "Save failed: " + (err.message || err);
  } finally {
    $("saveCase").disabled = false;
    $("saveCase").textContent = "Save case";
  }
});

let successDocs = { caseId: "", items: [] };
function showSuccess(title, caseNumber, warning = "", caseId = "", uploaded = []) {
  $("successTitle").textContent = title;
  $("successCaseNo").textContent = caseNumber || "";
  $("successWarn").textContent = warning;
  $("successWarn").classList.toggle("hidden", !warning);
  successDocs = { caseId, items: uploaded };
  const has = uploaded.length > 0;
  $("successBox").classList.toggle("wide", has);
  $("successDocsWrap").classList.toggle("hidden", !has);
  $("successDocList").innerHTML = uploaded.map((d, i) =>
    `<button class="doc-chip" type="button" data-sprev="${i}">👁 ${esc(d.name)}</button>`).join("");
  $("successPreview").innerHTML = "";
  $("successModal").classList.remove("hidden");
  if (has) renderPreview($("successPreview"), caseId, uploaded[0]);   // show the first uploaded document right away
}
$("successDocList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sprev]");
  if (b) renderPreview($("successPreview"), successDocs.caseId, successDocs.items[Number(b.dataset.sprev)]);
});
$("successOk").onclick = () => { $("successModal").classList.add("hidden"); $("successPreview").innerHTML = ""; };
$("successAdd").onclick = () => { $("successModal").classList.add("hidden"); $("successPreview").innerHTML = ""; openCaseModal(null); };

/* ---------- quick "next hearing date" update ---------- */
let dateCase = null;
function openDateModal(c) {
  if (!c) return;
  dateCase = c;
  $("dateCaseInfo").textContent = `${c.caseNumber} · ${c.appellant} vs ${c.respondent}` +
    (c.nextHearing ? ` · Current date: ${fmtDate(c.nextHearing)}` : " · No date set yet");
  $("newHearingDate").value = "";
  $("hearingNote").value = "";
  $("dateError").textContent = "";
  $("dateModal").classList.remove("hidden");
}
const closeDateModal = () => { $("dateModal").classList.add("hidden"); dateCase = null; };
$("closeDateModal").onclick = closeDateModal;
$("cancelDate").onclick = closeDateModal;
$("dateModal").addEventListener("click", (e) => {
  const b = e.target.closest("[data-plus]");
  if (!b || !dateCase) return;
  const base = dateCase.nextHearing || todayISO();
  $("newHearingDate").value = addDaysISO(base, Number(b.dataset.plus));
});
$("saveDate").onclick = async () => {
  if (!dateCase) return;
  const val = $("newHearingDate").value;
  const note = $("hearingNote").value.trim();
  if (!val) { $("dateError").textContent = "Please choose the new hearing date."; return; }
  if (val === dateCase.nextHearing) { $("dateError").textContent = "This is already the current hearing date."; return; }
  $("saveDate").disabled = true;
  try {
    const history = [...(dateCase.hearingHistory || [])];
    if (dateCase.nextHearing) history.push({ date: dateCase.nextHearing, note, on: todayISO() });
    await withTimeout(updateDoc(doc(db, "cases", dateCase.id), {
      nextHearing: val, hearingHistory: history, updatedAt: serverTimestamp()
    }), 20000, "Saving timed out. Check your internet connection.");
    closeDateModal();
    toast(`✔ Next hearing date set: ${fmtDate(val)}`);
  } catch (err) {
    $("dateError").textContent = "Could not save: " + (err.message || err);
  } finally {
    $("saveDate").disabled = false;
  }
};

async function deleteCase(c) {
  if (!c) return;
  if (!confirm(`Delete case ${c.caseNumber} (${c.appellant} vs ${c.respondent})?\nIts documents will also be deleted. This cannot be undone.`)) return;
  try {
    await Promise.all((c.documents || []).map((d) => removeFileChunks(c.id, d)));
    await deleteDoc(doc(db, "cases", c.id));
    toast("Case deleted.");
  } catch (err) {
    toast("Delete failed: " + err.message);
  }
}

/* =====================================================================
   hearings report (browser print → "Save as PDF")
   ===================================================================== */
$("reportBtn").onclick = () => {
  $("repFrom").value = todayISO();
  $("repTo").value = addDaysISO(todayISO(), 30);
  $("reportError").textContent = "";
  $("reportModal").classList.remove("hidden");
};
const closeReport = () => $("reportModal").classList.add("hidden");
$("closeReportModal").onclick = closeReport;
$("cancelReport").onclick = closeReport;

$("makePdf").onclick = () => {
  const from = $("repFrom").value, to = $("repTo").value;
  if (!from || !to || from > to) { $("reportError").textContent = "Choose a valid date range."; return; }

  const list = cases
    .filter((c) => c.status !== "Disposed" && c.nextHearing && c.nextHearing >= from && c.nextHearing <= to)
    .sort((a, b) => a.nextHearing.localeCompare(b.nextHearing) || a.caseNumber.localeCompare(b.caseNumber));
  if (!list.length) { $("reportError").textContent = "No pending hearings in this date range."; return; }

  const groups = {};
  list.forEach((c) => (groups[c.nextHearing] ||= []).push(c));
  const th = "border:1px solid #b9c4d6;padding:4px;text-align:left";
  const td = "border:1px solid #b9c4d6;padding:4px;vertical-align:top";

  const html = `
    <div style="font-family:'Segoe UI','Noto Sans','Noto Sans Devanagari',Arial,sans-serif;color:#111;width:100%">
      <div style="text-align:center;border-bottom:2px solid #0f2742;padding-bottom:8px;margin-bottom:12px">
        <div style="font-size:20px;font-weight:700;color:#0f2742">Upcoming Hearings Report</div>
        <div style="font-size:12px;margin-top:4px">Advocate: <b>${esc(advocate.name)}</b>${advocate.enrolment ? ` &nbsp;|&nbsp; Enrolment: ${esc(advocate.enrolment)}` : ""}</div>
        <div style="font-size:12px">Period: ${esc(fmtDate(from))} to ${esc(fmtDate(to))} &nbsp;|&nbsp; Total hearings: ${list.length}</div>
      </div>
      ${Object.keys(groups).map((date) => `
        <div style="page-break-inside:avoid;margin-bottom:14px">
          <div style="background:#0f2742;color:#fff;padding:5px 10px;font-weight:600;font-size:13px">
            ${esc(fmtLongDate(date))} &nbsp;(${groups[date].length} ${groups[date].length > 1 ? "cases" : "case"})
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed">
            <thead>
              <tr style="background:#e9eef6">
                <th style="${th};width:15%">Case No.</th>
                <th style="${th};width:27%">Appellant vs Respondent</th>
                <th style="${th};width:14%">Type / Section</th>
                <th style="${th};width:19%">Court</th>
                <th style="${th};width:25%">Village / Khasra / Notes</th>
              </tr>
            </thead>
            <tbody>
              ${groups[date].map((c) => `
                <tr style="page-break-inside:avoid">
                  <td style="${td}"><b>${esc(c.caseNumber)}</b></td>
                  <td style="${td}">${esc(c.appellant)}<br/><i>vs</i><br/>${esc(c.respondent)}${c.clientName ? `<br/><small>Client: ${esc(c.clientName)}</small>` : ""}</td>
                  <td style="${td}">${esc(c.caseType)}<br/>${esc(c.section)}</td>
                  <td style="${td}">${esc(c.courtName)}<br/><small>${esc([c.tehsil, c.district].filter(Boolean).join(", "))}</small></td>
                  <td style="${td}">${esc(c.village || "")}${c.khasra ? `<br/>Khasra: ${esc(c.khasra)}` : ""}${c.notes ? `<br/><small>${esc(c.notes)}</small>` : ""}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>`).join("")}
      <div style="font-size:10px;color:#666;text-align:right;margin-top:10px">Generated on ${esc(fmtDate(todayISO()))} · Lawyer Case Diary</div>
    </div>`;

  const fileTitle = `Hearings_${from}_to_${to}`;
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(frame);
  const fdoc = frame.contentWindow.document;
  fdoc.open();
  fdoc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${fileTitle}</title>
    <style>
      @page { size: A4 portrait; margin: 12mm; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      table { table-layout: fixed; width: 100%; }
      td, th { word-wrap: break-word; overflow-wrap: anywhere; }
      tr, thead { page-break-inside: avoid; }
    </style></head><body>${html}</body></html>`);
  fdoc.close();

  const oldTitle = document.title;
  const cleanup = () => { document.title = oldTitle; setTimeout(() => frame.remove(), 500); };
  setTimeout(() => {
    try {
      document.title = fileTitle;
      frame.contentWindow.focus();
      frame.contentWindow.onafterprint = cleanup;
      frame.contentWindow.print();
      closeReport();
      toast('In the print window choose "Save as PDF" to download.', 5000);
    } catch (err) {
      console.error(err);
      $("reportError").textContent = "Could not open print window: " + (err.message || err);
      cleanup();
    }
  }, 400);
};

/* =====================================================================
   v3 features: today banner · calendar · insights · WhatsApp · export · dark mode
   ===================================================================== */
const phoneDigits = (p) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  return d.length >= 11 ? d : "";
};
const feeBalance = (c) => Math.max(0, (Number(c.totalFee) || 0) - (Number(c.feeReceived) || 0));
const localISO = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const isPending = (c) => c.status !== "Disposed";

function openWhatsApp(phone, text) {
  const base = phone ? `https://wa.me/${phone}` : "https://wa.me/";
  window.open(`${base}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
}
function caseShareText(c) {
  return [
    "⚖️ *Case update*",
    `Case No.: ${c.caseNumber}`,
    `${c.appellant} vs ${c.respondent}`,
    `Court: ${c.courtName}`,
    `Type / Section: ${c.caseType} · ${c.section}`,
    c.status === "Disposed" ? `Status: Disposed on ${fmtDate(c.disposalDate)}` : (c.nextHearing ? `Next hearing: ${fmtDate(c.nextHearing)}` : "Next hearing: will be informed"),
    `— ${advocate.name}`
  ].join("\n");
}
function dayListText(iso) {
  const list = cases.filter((c) => isPending(c) && c.nextHearing === iso);
  return [`⚖️ *Hearings on ${fmtDate(iso)}* (${list.length})`, "",
    ...list.map((c, i) => `${i + 1}. ${c.caseNumber} — ${c.appellant} vs ${c.respondent}\n    ${c.courtName}`),
    "", `— ${advocate.name}`].join("\n");
}

function miniRow(c) {
  const ph = phoneDigits(c.clientPhone);
  const bits = [];
  if (ph) bits.push(`<a class="mini-btn call" href="tel:+${esc(ph)}">📞 Call</a>`);
  bits.push(ph
    ? `<button class="mini-btn wa" type="button" data-share="${esc(c.id)}">💬 WhatsApp client</button>`
    : `<button class="mini-btn" type="button" data-share="${esc(c.id)}">📤 Share</button>`);
  const total = Number(c.totalFee) || 0;
  if (total > 0) {
    const bal = feeBalance(c);
    bits.push(bal > 0
      ? `<span class="fee-chip">Fee ${money(total)} · Received ${money(Number(c.feeReceived) || 0)} · Balance ${money(bal)}</span>`
      : `<span class="fee-chip clear">Fee ${money(total)} received in full ✓</span>`);
  }
  return `<div class="mini-row">${bits.join("")}</div>`;
}

/* ---------- today banner ---------- */
function renderBanner(pending, today) {
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const tomorrow = addDaysISO(today, 1);
  const tdy = pending.filter((c) => c.nextHearing === today);
  const tmr = pending.filter((c) => c.nextHearing === tomorrow);
  const late = pending.filter((c) => c.nextHearing && c.nextHearing < today).length;
  const bal = cases.reduce((a, c) => a + feeBalance(c), 0);
  $("todayBanner").innerHTML = `
    <div style="z-index:1">
      <h2>नमस्ते, ${esc(advocate.name || "Advocate")} 👋</h2>
      <div class="hdate">${esc(greet)} · ${esc(fmtLongDate(today))}</div>
      <div class="hero-nums">
        <div class="hero-num gold"><b>${tdy.length}</b><span>Hearings today</span></div>
        <div class="hero-num"><b>${tmr.length}</b><span>Tomorrow</span></div>
        ${late ? `<div class="hero-num"><b>${late}</b><span>Dates passed</span></div>` : ""}
        ${bal ? `<div class="hero-num"><b>${money(bal)}</b><span>Fees pending</span></div>` : ""}
      </div>
      ${tdy.length ? `<ul class="hero-lines">${tdy.slice(0, 3).map((c) => `<li>• ${esc(c.appellant)} vs ${esc(c.respondent)} · ${esc(c.courtName)}</li>`).join("")}${tdy.length > 3 ? `<li>+ ${tdy.length - 3} more</li>` : ""}</ul>` : `<ul class="hero-lines"><li>No hearings today — a calm day ☕</li></ul>`}
    </div>
    <div class="hero-actions">
      ${tdy.length ? `<button class="btn gold" type="button" data-hero="today">📤 Share today's list</button>` : ""}
      ${tmr.length ? `<button class="btn" type="button" data-hero="tomorrow">📤 Share tomorrow's list</button>` : ""}
      <button class="btn" type="button" data-hero="cal">📆 Open calendar</button>
    </div>`;
}
$("todayBanner").addEventListener("click", (e) => {
  const b = e.target.closest("[data-hero]");
  if (!b) return;
  const t = todayISO();
  if (b.dataset.hero === "today") openWhatsApp("", dayListText(t));
  if (b.dataset.hero === "tomorrow") openWhatsApp("", dayListText(addDaysISO(t, 1)));
  if (b.dataset.hero === "cal") { calMonth = new Date(); calMonth.setDate(1); calSel = t; setView("calendar"); }
});

/* ---------- tabs ---------- */
let currentView = "cases";
function setView(v) {
  currentView = v;
  document.querySelectorAll(".vtab").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  $("viewCases").classList.toggle("hidden", v !== "cases");
  $("viewCalendar").classList.toggle("hidden", v !== "calendar");
  $("viewInsights").classList.toggle("hidden", v !== "insights");
  refreshViews();
}
function refreshViews() {
  if (currentView === "calendar") renderCalendar();
  if (currentView === "insights") renderInsights();
}
$("viewTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (b) setView(b.dataset.view);
});

/* ---------- calendar ---------- */
let calMonth = new Date(); calMonth.setDate(1);
let calSel = null;
function renderCalendar() {
  const today = todayISO();
  if (!calSel) calSel = today;
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const offset = new Date(y, m, 1).getDay();                      // Sunday first
  const byDate = {};
  cases.filter((c) => isPending(c) && c.nextHearing).forEach((c) => (byDate[c.nextHearing] ||= []).push(c));

  let cells = "";
  const rows = (offset + new Date(y, m + 1, 0).getDate()) > 35 ? 42 : 35;
  for (let i = 0; i < rows; i++) {
    const d = new Date(y, m, 1 - offset + i);
    const iso = localISO(d);
    const n = (byDate[iso] || []).length;
    cells += `<button type="button" data-day="${iso}" class="cal-cell ${d.getMonth() !== m ? "other" : ""} ${d.getDay() === 0 ? "sun" : ""} ${iso === today ? "today" : ""} ${iso === calSel ? "sel" : ""}">
      <span class="d">${d.getDate()}</span>
      ${n ? `<span class="cnt ${iso < today ? "late" : n >= 3 ? "many" : ""}">${n}</span>` : ""}
    </button>`;
  }
  const dayList = byDate[calSel] || [];
  $("viewCalendar").innerHTML = `
    <div class="cal-wrap">
      <div class="cal">
        <div class="cal-head">
          <h3>${esc(calMonth.toLocaleDateString("en-IN", { month: "long", year: "numeric" }))}</h3>
          <div class="cal-nav">
            <button class="btn sm" type="button" data-calnav="prev" aria-label="Previous month">‹</button>
            <button class="btn sm" type="button" data-calnav="today">Today</button>
            <button class="btn sm" type="button" data-calnav="next" aria-label="Next month">›</button>
          </div>
        </div>
        <div class="cal-grid">
          ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => `<div class="cal-dow">${w}</div>`).join("")}
          ${cells}
        </div>
        <div class="cal-legend">
          <span><i style="background:var(--s1)"></i>Hearings</span>
          <span><i style="background:var(--s2)"></i>3 or more</span>
          <span><i style="background:var(--danger)"></i>Date passed (pending)</span>
        </div>
      </div>
      <div class="panel">
        <h3 class="panel-title">${esc(fmtLongDate(calSel))}</h3>
        <p class="muted small" style="margin:-4px 0 6px">${dayList.length ? `${dayList.length} hearing${dayList.length > 1 ? "s" : ""}` : "No hearings on this day."}</p>
        ${dayList.map((c) => `
          <div class="day-case">
            <div class="t">${esc(c.appellant)} vs ${esc(c.respondent)}</div>
            <div class="s">${esc(c.caseNumber)} · ${esc(c.courtName)}</div>
            <div class="mini-row">
              <button class="mini-btn" type="button" data-next="${esc(c.id)}">📅 Next date</button>
              <button class="mini-btn" type="button" data-edit="${esc(c.id)}">✏️ Edit</button>
              <button class="mini-btn wa" type="button" data-share="${esc(c.id)}">💬 Share</button>
            </div>
          </div>`).join("")}
        ${dayList.length ? `<button class="btn sm block" type="button" data-shareday="${esc(calSel)}">📤 Share this day's list on WhatsApp</button>` : ""}
      </div>
    </div>`;
}
$("viewCalendar").addEventListener("click", (e) => {
  const day = e.target.closest("[data-day]");
  const nav = e.target.closest("[data-calnav]");
  const sd = e.target.closest("[data-shareday]");
  if (day) { calSel = day.dataset.day; renderCalendar(); return; }
  if (sd) { openWhatsApp("", dayListText(sd.dataset.shareday)); return; }
  if (nav) {
    if (nav.dataset.calnav === "today") { calMonth = new Date(); calMonth.setDate(1); calSel = todayISO(); }
    else calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + (nav.dataset.calnav === "next" ? 1 : -1), 1);
    renderCalendar();
    return;
  }
  onListClick(e);
});

/* ---------- insights (charts) ---------- */
function tally(list, keyFn) {
  const m = new Map();
  list.forEach((c) => { const k = (keyFn(c) || "—").toString().trim() || "—"; m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function donutSvg(items, total) {
  const R = 62, C = 2 * Math.PI * R;
  let acc = 0;
  const segs = items.map((it, i) => {
    const len = (it.n / total) * C;
    const dash = Math.max(len - (items.length > 1 ? 2.5 : 0), 0.6);
    const el = `<circle class="seg" cx="84" cy="84" r="${R}" fill="none" stroke="${it.color}" stroke-width="24"
      stroke-dasharray="${dash} ${C}" stroke-dashoffset="${-acc}" transform="rotate(-90 84 84)"><title>${esc(it.label)}: ${it.n} (${Math.round(it.n / total * 100)}%)</title></circle>`;
    acc += len;
    return el;
  }).join("");
  return `<svg class="donut" viewBox="0 0 168 168" role="img" aria-label="Cases by type">
    ${segs}
    <text x="84" y="82" text-anchor="middle" font-size="26" font-weight="800">${total}</text>
    <text x="84" y="100" text-anchor="middle" font-size="10" style="fill:var(--muted)">cases</text>
  </svg>`;
}
function vbars(vals, labels) {
  const max = Math.max(1, ...vals);
  return `<div class="vbars">${vals.map((v, i) => `
      <div class="vbar" title="${esc(labels[i])}: ${v}">
        <span class="val">${v}</span><div class="bar" style="height:${Math.max(2, Math.round(v / max * 78))}%"></div>
      </div>`).join("")}</div>
    <div class="vlabels">${labels.map((l) => `<span>${esc(l)}</span>`).join("")}</div>`;
}
function renderInsights() {
  const box = $("viewInsights");
  if (!cases.length) {
    box.innerHTML = `<div class="empty"><div class="empty-ic">📊</div><h3>No data yet</h3><p class="muted">Add a few cases and your charts will appear here.</p></div>`;
    return;
  }
  const total = cases.length;
  const disposed = cases.filter((c) => !isPending(c)).length;
  const pend = total - disposed;
  const rate = Math.round(disposed / total * 100);
  const feeTotal = cases.reduce((a, c) => a + (Number(c.totalFee) || 0), 0);
  const feeGot = cases.reduce((a, c) => a + Math.min(Number(c.feeReceived) || 0, Number(c.totalFee) || 0), 0);
  const feeBal = feeTotal - feeGot;
  const feePct = feeTotal ? Math.round(feeGot / feeTotal * 100) : 0;

  // by case type: top 5 + Other
  const types = tally(cases, (c) => c.caseType);
  const colors = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];
  const items = types.slice(0, 5).map(([label, n], i) => ({ label, n, color: colors[i] }));
  const rest = types.slice(5).reduce((a, [, n]) => a + n, 0);
  if (rest) items.push({ label: "Other", n: rest, color: "var(--sx)" });

  // registered per month (last 6)
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => new Date(now.getFullYear(), now.getMonth() - 5 + i, 1));
  const perMonth = months.map((m) => cases.filter((c) => {
    const t = new Date(c.createdAt?.toMillis?.() ?? Date.now());
    return t.getFullYear() === m.getFullYear() && t.getMonth() === m.getMonth();
  }).length);

  // workload: next 4 weeks
  const today = todayISO();
  const weeks = [0, 1, 2, 3].map((k) => {
    const from = addDaysISO(today, k * 7), to = addDaysISO(today, k * 7 + 6);
    return cases.filter((c) => isPending(c) && c.nextHearing >= from && c.nextHearing <= to).length;
  });
  const weekLabels = [0, 1, 2, 3].map((k) => k === 0 ? "This week" : `+${k} wk`);

  const courts = tally(cases, (c) => c.courtName).slice(0, 5);
  const cmax = courts[0] ? courts[0][1] : 1;

  box.innerHTML = `
    <div class="ins-kpis">
      <div class="kpi"><div class="k">Disposal rate</div><div class="v">${rate}%</div><div class="sub">${disposed} disposed · ${pend} pending</div><div class="meter"><div style="width:${rate}%"></div></div></div>
      <div class="kpi"><div class="k">Total fee agreed</div><div class="v">${money(feeTotal)}</div><div class="sub">across ${cases.filter((c) => Number(c.totalFee) > 0).length} cases</div></div>
      <div class="kpi"><div class="k">Fee received</div><div class="v">${money(feeGot)}</div><div class="sub">${feePct}% collected</div><div class="meter"><div style="width:${feePct}%"></div></div></div>
      <div class="kpi"><div class="k">Fee balance</div><div class="v" style="color:${feeBal ? "var(--warn)" : "var(--ok)"}">${money(feeBal)}</div><div class="sub">${feeBal ? "still to collect" : "all clear"}</div></div>
    </div>
    <div class="ins-grid">
      <div class="chart-card"><h3>Cases by type</h3><div class="cap">Share of all your cases</div>
        <div class="donut-row">${donutSvg(items, total)}
          <div class="legend">${items.map((it) => `<div><i style="background:${it.color}"></i><span>${esc(it.label)}</span><b>${it.n}</b><span class="p">${Math.round(it.n / total * 100)}%</span></div>`).join("")}</div>
        </div></div>
      <div class="chart-card"><h3>Upcoming workload</h3><div class="cap">Pending hearings in the next 4 weeks</div>${vbars(weeks, weekLabels)}</div>
      <div class="chart-card"><h3>Cases registered</h3><div class="cap">Last 6 months</div>${vbars(perMonth, months.map((m) => m.toLocaleDateString("en-IN", { month: "short" })))}</div>
      <div class="chart-card"><h3>Busiest courts</h3><div class="cap">Cases per court (top 5)</div>
        <div class="hbars">${courts.map(([name, n]) => `<div class="hbar"><div class="row1"><span title="${esc(name)}">${esc(name)}</span><b>${n}</b></div><div class="track"><div class="fill" style="width:${Math.round(n / cmax * 100)}%"></div></div></div>`).join("")}</div></div>
    </div>`;
}

/* ---------- export to Excel (CSV) ---------- */
function csvCell(v) {
  let t = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;                  // stop spreadsheet formula injection
  return `"${t.replace(/"/g, '""')}"`;
}
$("exportBtn").onclick = () => {
  if (!cases.length) { toast("No cases to export yet."); return; }
  const head = ["Case No.", "Client", "Client mobile", "Appellant", "Respondent", "Case type", "Section", "Court", "Division",
    "District", "Tehsil", "Village", "Khasra", "Status", "Next hearing", "Disposal date", "Total fee", "Fee received", "Fee balance", "Notes"];
  const rows = [...cases].sort((a, b) => String(a.caseNumber).localeCompare(String(b.caseNumber))).map((c) => [
    c.caseNumber, c.clientName, c.clientPhone, c.appellant, c.respondent, c.caseType, c.section, c.courtName, c.division,
    c.district, c.tehsil, c.village, c.khasra, c.status || "Pending", fmtDate(c.nextHearing === "" ? "" : c.nextHearing).replace("—", ""),
    fmtDate(c.disposalDate).replace("—", ""), c.totalFee || 0, c.feeReceived || 0, feeBalance(c), c.notes]);
  const csv = "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), `Case-Diary_${todayISO()}.csv`);
  toast(`✔ Exported ${cases.length} cases (opens in Excel)`);
};

/* ---------- dark mode ---------- */
let theme = "light";
try { theme = localStorage.getItem("lcd-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); } catch (_) {}
function applyTheme(t) {
  theme = t;
  document.documentElement.setAttribute("data-theme", t);
  $("themeBtn").textContent = t === "dark" ? "☀️" : "🌙";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#0b1b30" : "#0f2742");
}
applyTheme(theme);
$("themeBtn").onclick = () => {
  applyTheme(theme === "dark" ? "light" : "dark");
  try { localStorage.setItem("lcd-theme", theme); } catch (_) {}
  refreshViews();
};

/* =====================================================================
   misc
   ===================================================================== */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("caseModal").classList.contains("hidden")) closeCaseModal();
  if (!$("reportModal").classList.contains("hidden")) closeReport();
  if (!$("dateModal").classList.contains("hidden")) closeDateModal();
  if (!$("previewModal").classList.contains("hidden")) $("closePreview").click();
});

// Installable app (PWA / APK wrapper)
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
