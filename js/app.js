import { auth, db, storage } from "./firebase-config.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updateProfile, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc, query, where,
  onSnapshot, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  ref, uploadBytesResumable, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MAX_FILE = 10 * 1024 * 1024; // 10 MB

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 3200);
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
function fmtLongDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
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

/* ---------------- state ---------------- */
let currentUser = null;
let advocate = { name: "", enrolment: "" };
let cases = [];
let unsubscribeCases = null;
let editing = null;          // case being edited (object) or null for new
let keptDocs = [];           // documents already attached to the case being edited
let signupMode = false;

/* ---------------- auth UI ---------------- */
function setAuthMode(signup) {
  signupMode = signup;
  $("tabLogin").classList.toggle("active", !signup);
  $("tabSignup").classList.toggle("active", signup);
  $("signupOnly").classList.toggle("hidden", !signup);
  $("authSubmit").textContent = signup ? "Create account" : "Login";
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
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
      await setDoc(doc(db, "advocates", cred.user.uid), {
        name, email, enrolment: $("authEnrol").value.trim(), createdAt: serverTimestamp()
      });
      advocate = { name, enrolment: $("authEnrol").value.trim() };
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (err) {
    $("authError").textContent = authMessage(err);
  } finally {
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

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (unsubscribeCases) { unsubscribeCases(); unsubscribeCases = null; }
  if (!user) {
    cases = [];
    $("appScreen").classList.add("hidden");
    $("authScreen").classList.remove("hidden");
    return;
  }
  $("authScreen").classList.add("hidden");
  $("appScreen").classList.remove("hidden");

  try {
    const snap = await getDoc(doc(db, "advocates", user.uid));
    if (snap.exists()) advocate = { name: snap.data().name || "", enrolment: snap.data().enrolment || "" };
  } catch (_) { /* profile is optional */ }
  if (!advocate.name) advocate.name = user.displayName || user.email;
  $("advName").textContent = advocate.name;

  const q = query(collection(db, "cases"), where("advocateId", "==", user.uid));
  unsubscribeCases = onSnapshot(q, (snap) => {
    cases = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // newest first
    cases.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    render();
  }, (err) => {
    console.error(err);
    toast("Could not load cases: " + err.message);
  });
});

/* ---------------- list rendering ---------------- */
function render() {
  const term = $("searchInput").value.trim().toLowerCase();
  const status = $("statusFilter").value;
  const today = todayISO();
  const weekEnd = addDaysISO(today, 7);

  $("statTotal").textContent = cases.length;
  $("statPending").textContent = cases.filter((c) => c.status !== "Disposed").length;
  $("statDisposed").textContent = cases.filter((c) => c.status === "Disposed").length;
  $("statWeek").textContent = cases.filter((c) => c.status !== "Disposed" && c.nextHearing >= today && c.nextHearing <= weekEnd).length;

  const filtered = cases.filter((c) => {
    if (status !== "all" && (c.status || "Pending") !== status) return false;
    if (!term) return true;
    const hay = [c.caseNumber, c.appellant, c.respondent, c.clientName, c.section, c.caseType, c.courtName,
      c.division, c.district, c.tehsil, c.village, c.khasra, c.notes].join(" ").toLowerCase();
    return hay.includes(term);
  });

  $("emptyMsg").classList.toggle("hidden", filtered.length > 0);
  $("caseList").innerHTML = filtered.map((c) => {
    const disposed = c.status === "Disposed";
    const isToday = !disposed && c.nextHearing === today;
    const docs = (c.documents || []).map((d) =>
      `<a class="doc-chip" href="${esc(d.url)}" target="_blank" rel="noopener">📎 ${esc(d.name)}</a>`).join("");
    return `
    <article class="case-card ${disposed ? "disposed" : ""} ${isToday ? "today" : ""}">
      <div class="case-head">
        <span class="case-no">${esc(c.caseNumber)}</span>
        <span>
          ${disposed
            ? `<span class="badge ok">Disposed ${esc(fmtDate(c.disposalDate))}</span>`
            : `<span class="badge ${isToday ? "warn" : ""}">${c.nextHearing ? (isToday ? "Hearing TODAY" : "Next: " + esc(fmtDate(c.nextHearing))) : "No hearing date"}</span>`}
        </span>
      </div>
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
      <div class="case-actions">
        <button class="btn sm" data-edit="${esc(c.id)}" type="button">✏️ Edit</button>
        <button class="btn sm danger" data-del="${esc(c.id)}" type="button">🗑 Delete</button>
        ${docs}
      </div>
    </article>`;
  }).join("");
}

$("searchInput").addEventListener("input", render);
$("statusFilter").addEventListener("change", render);

$("caseList").addEventListener("click", (e) => {
  const edit = e.target.closest("[data-edit]");
  const del = e.target.closest("[data-del]");
  if (edit) openCaseModal(cases.find((c) => c.id === edit.dataset.edit));
  if (del) deleteCase(cases.find((c) => c.id === del.dataset.del));
});

/* ---------------- case modal ---------------- */
const form = $("caseForm");
const FIELDS = ["clientName", "appellant", "respondent", "caseType", "section", "courtName", "division",
  "district", "tehsil", "village", "khasra", "nextHearing", "status", "disposalDate", "notes"];

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
      <a href="${esc(d.url)}" target="_blank" rel="noopener">📎 ${esc(d.name)}</a>
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
$("closeCaseModal").onclick = closeCaseModal;
$("cancelCase").onclick = closeCaseModal;

/* ---- unique case number: per-advocate, per-year counter inside a transaction ---- */
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

function uploadFile(uid, caseId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const safe = file.name.replace(/[^\w.\-() ]+/g, "_");
    const path = `users/${uid}/cases/${caseId}/${Date.now()}_${safe}`;
    const task = uploadBytesResumable(ref(storage, path), file);
    task.on("state_changed",
      (s) => onProgress(s.bytesTransferred / s.totalBytes),
      reject,
      async () => resolve({ name: file.name, path, size: file.size, url: await getDownloadURL(task.snapshot.ref) })
    );
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("caseError").textContent = "";
  const files = [...$("fileInput").files];
  const tooBig = files.find((f) => f.size > MAX_FILE);
  if (tooBig) { $("caseError").textContent = `"${tooBig.name}" is larger than 10 MB.`; return; }

  const data = {};
  FIELDS.forEach((f) => { data[f] = (form[f].value || "").trim(); });
  if (data.status !== "Disposed") data.disposalDate = "";
  if (data.status === "Disposed" && !data.disposalDate) {
    $("caseError").textContent = "Please enter the disposal date."; return;
  }

  $("saveCase").disabled = true;
  $("saveCase").textContent = "Saving…";
  try {
    const uid = currentUser.uid;
    let caseId, removedDocs = [], savedNumber = "";

    if (editing) {
      caseId = editing.id;
      removedDocs = (editing.documents || []).filter((d) => !keptDocs.some((k) => k.path === d.path));
      await updateDoc(doc(db, "cases", caseId), { ...data, documents: keptDocs, updatedAt: serverTimestamp() });
    } else {
      const created = await createCaseWithNumber(uid, { ...data, documents: [] });
      caseId = created.id;
      savedNumber = created.caseNumber;
    }

    // upload new documents, then attach them to the case
    if (files.length) {
      $("uploadProgress").classList.remove("hidden");
      const uploaded = [];
      for (let i = 0; i < files.length; i++) {
        const item = await uploadFile(uid, caseId, files[i], (p) => {
          $("uploadBar").style.width = `${((i + p) / files.length) * 100}%`;
        });
        uploaded.push(item);
      }
      await updateDoc(doc(db, "cases", caseId), { documents: [...keptDocs, ...uploaded], updatedAt: serverTimestamp() });
    }

    // delete removed files from storage (best effort)
    await Promise.all(removedDocs.map((d) => deleteObject(ref(storage, d.path)).catch(() => {})));

    const wasEdit = !!editing;
    const shownNo = wasEdit ? editing.caseNumber : savedNumber;
    closeCaseModal();
    showSuccess(wasEdit ? "Case updated successfully" : "Case saved successfully", shownNo);
  } catch (err) {
    console.error(err);
    $("caseError").textContent = "Save failed: " + (err.message || err);
  } finally {
    $("saveCase").disabled = false;
    $("saveCase").textContent = "Save case";
  }
});

function showSuccess(title, caseNumber) {
  $("successTitle").textContent = title;
  $("successCaseNo").textContent = caseNumber || "";
  $("successModal").classList.remove("hidden");
}
$("successOk").onclick = () => $("successModal").classList.add("hidden");
$("successAdd").onclick = () => { $("successModal").classList.add("hidden"); openCaseModal(null); };

async function deleteCase(c) {
  if (!c) return;
  if (!confirm(`Delete case ${c.caseNumber} (${c.appellant} vs ${c.respondent})?\nIts uploaded documents will also be deleted. This cannot be undone.`)) return;
  try {
    await Promise.all((c.documents || []).map((d) => deleteObject(ref(storage, d.path)).catch(() => {})));
    await deleteDoc(doc(db, "cases", c.id));
    toast("Case deleted.");
  } catch (err) {
    toast("Delete failed: " + err.message);
  }
}

/* ---------------- PDF: upcoming hearings by date ---------------- */
$("reportBtn").onclick = () => {
  $("repFrom").value = todayISO();
  $("repTo").value = addDaysISO(todayISO(), 30);
  $("reportError").textContent = "";
  $("reportModal").classList.remove("hidden");
};
const closeReport = () => $("reportModal").classList.add("hidden");
$("closeReportModal").onclick = closeReport;
$("cancelReport").onclick = closeReport;

$("makePdf").onclick = async () => {
  const from = $("repFrom").value, to = $("repTo").value;
  if (!from || !to || from > to) { $("reportError").textContent = "Choose a valid date range."; return; }

  const list = cases
    .filter((c) => c.status !== "Disposed" && c.nextHearing && c.nextHearing >= from && c.nextHearing <= to)
    .sort((a, b) => a.nextHearing.localeCompare(b.nextHearing) || a.caseNumber.localeCompare(b.caseNumber));
  if (!list.length) { $("reportError").textContent = "No pending hearings in this date range."; return; }

  const groups = {};
  list.forEach((c) => (groups[c.nextHearing] ||= []).push(c));

  const html = `
    <div style="font-family:'Segoe UI','Noto Sans','Noto Sans Devanagari',Arial,sans-serif;color:#111;padding:6px 10px;width:100%">
      <div style="text-align:center;border-bottom:2px solid #1e3a5f;padding-bottom:8px;margin-bottom:12px">
        <div style="font-size:20px;font-weight:700;color:#1e3a5f">Upcoming Hearings Report</div>
        <div style="font-size:12px;margin-top:4px">
          Advocate: <b>${esc(advocate.name)}</b>${advocate.enrolment ? ` &nbsp;|&nbsp; Enrolment: ${esc(advocate.enrolment)}` : ""}
        </div>
        <div style="font-size:12px">Period: ${esc(fmtDate(from))} to ${esc(fmtDate(to))} &nbsp;|&nbsp; Total hearings: ${list.length}</div>
      </div>
      ${Object.keys(groups).map((date) => `
        <div style="page-break-inside:avoid;margin-bottom:14px">
          <div style="background:#1e3a5f;color:#fff;padding:5px 10px;font-weight:600;font-size:13px">
            ${esc(fmtLongDate(date))} &nbsp;(${groups[date].length} ${groups[date].length > 1 ? "cases" : "case"})
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead>
              <tr style="background:#e9eef6">
                <th style="border:1px solid #b9c4d6;padding:4px;text-align:left;width:14%">Case No.</th>
                <th style="border:1px solid #b9c4d6;padding:4px;text-align:left;width:28%">Appellant vs Respondent</th>
                <th style="border:1px solid #b9c4d6;padding:4px;text-align:left;width:14%">Type / Section</th>
                <th style="border:1px solid #b9c4d6;padding:4px;text-align:left;width:18%">Court</th>
                <th style="border:1px solid #b9c4d6;padding:4px;text-align:left;width:26%">Village / Khasra / Notes</th>
              </tr>
            </thead>
            <tbody>
              ${groups[date].map((c) => `
                <tr style="page-break-inside:avoid">
                  <td style="border:1px solid #b9c4d6;padding:4px;vertical-align:top"><b>${esc(c.caseNumber)}</b></td>
                  <td style="border:1px solid #b9c4d6;padding:4px;vertical-align:top">${esc(c.appellant)}<br/><i>vs</i><br/>${esc(c.respondent)}${c.clientName ? `<br/><small>Client: ${esc(c.clientName)}</small>` : ""}</td>
                  <td style="border:1px solid #b9c4d6;padding:4px;vertical-align:top">${esc(c.caseType)}<br/>${esc(c.section)}</td>
                  <td style="border:1px solid #b9c4d6;padding:4px;vertical-align:top">${esc(c.courtName)}<br/><small>${esc([c.tehsil, c.district].filter(Boolean).join(", "))}</small></td>
                  <td style="border:1px solid #b9c4d6;padding:4px;vertical-align:top">${esc(c.village || "")}${c.khasra ? `<br/>Khasra: ${esc(c.khasra)}` : ""}${c.notes ? `<br/><small>${esc(c.notes)}</small>` : ""}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>`).join("")}
      <div style="font-size:10px;color:#666;text-align:right;margin-top:10px">Generated on ${esc(fmtDate(todayISO()))} · Lawyer Case Diary</div>
    </div>`;

  // Render the report visibly (on top of everything) so the PDF library can capture it.
  // A hidden / off-screen / negative z-index element produces a blank PDF.
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(255,255,255,.97);z-index:99999;overflow:auto;padding:20px 0;";
  const note = document.createElement("div");
  note.textContent = "Generating PDF… please wait";
  note.style.cssText = "text-align:center;font:600 14px sans-serif;color:#1e3a5f;margin-bottom:10px;";
  const holder = document.createElement("div");
  holder.style.cssText = "width:780px;margin:0 auto;background:#fff;";
  holder.innerHTML = html;
  overlay.appendChild(note);
  overlay.appendChild(holder);
  document.body.appendChild(overlay);
  overlay.scrollTop = 0;
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 300)); // let fonts/layout settle

  $("makePdf").disabled = true;
  $("makePdf").textContent = "Generating…";
  try {
    await window.html2pdf().set({
      margin: [10, 8, 10, 8],
      filename: `Hearings_${from}_to_${to}.pdf`,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff", scrollX: 0, scrollY: 0, windowWidth: 800 },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"] }
    }).from(holder).save();
    closeReport();
    toast("PDF downloaded.");
  } catch (err) {
    console.error(err);
    $("reportError").textContent = "PDF failed: " + (err.message || err);
  } finally {
    overlay.remove();
    $("makePdf").disabled = false;
    $("makePdf").textContent = "Download PDF";
  }
};

// close modals with Escape
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("caseModal").classList.contains("hidden")) closeCaseModal();
  if (!$("reportModal").classList.contains("hidden")) closeReport();
});
