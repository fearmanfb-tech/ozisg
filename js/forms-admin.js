/**
 * forms-admin.js — Form Builder + Gelen Kutusu (Inbox)
 * Admin paneli → Formlar sekmesi
 * Firestore:
 *   forms/{formId}           — form tanımları
 *   form_submissions/{id}    — gelen mesajlar
 */

import { db, showToast } from "./app.js";
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp, query, orderBy, where, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Sabitler ───────────────────────────────────
const FIELD_TYPES = [
  { value: "text",     label: "📝 Kısa Metin" },
  { value: "email",    label: "📧 E-posta" },
  { value: "textarea", label: "📄 Uzun Metin" },
  { value: "tel",      label: "📞 Telefon" },
  { value: "select",   label: "📋 Seçim Listesi" },
  { value: "number",   label: "🔢 Sayı" },
];

// ── Durum ──────────────────────────────────────
let allForms       = [];
let allSubmissions = [];
let editingFormId  = null;
let activeFormView = "list"; // "list" | "builder" | "inbox"
let inboxFormId    = null;

// ── Yardımcı ──────────────────────────────────
function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("tr-TR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
}

// ══════════════════════════════════════════════
// VERİ YÜKLEME
// ══════════════════════════════════════════════
async function loadForms() {
  try {
    const snap = await getDocs(query(collection(db, "forms"), orderBy("createdAt", "desc")));
    allForms = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    const snap = await getDocs(collection(db, "forms"));
    allForms = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
}

async function loadSubmissions(formId = null) {
  try {
    const q = formId
      ? query(collection(db, "form_submissions"), where("formId","==",formId), orderBy("createdAt","desc"))
      : query(collection(db, "form_submissions"), orderBy("createdAt","desc"));
    const snap = await getDocs(q);
    allSubmissions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    const snap = await getDocs(collection(db, "form_submissions"));
    allSubmissions = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(s => !formId || s.formId === formId)
      .sort((a,b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  }
}

// ══════════════════════════════════════════════
// ANA PANEL
// ══════════════════════════════════════════════
function renderForms() {
  const panel = document.getElementById("forms-panel");
  if (!panel) return;

  if (activeFormView === "builder") { renderFormBuilder(); return; }
  if (activeFormView === "inbox")   { renderInbox();       return; }

  const unread = allSubmissions.filter(s => !s.read).length;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-3);margin-bottom:var(--space-6);">
      <div>
        <h3 style="font-weight:var(--font-bold);font-size:var(--text-lg);">📬 Form Yönetimi</h3>
        <p style="font-size:var(--text-sm);color:var(--text-muted);margin-top:2px;">Sitede kullanılacak iletişim formlarını oluşturun ve gelen mesajları görüntüleyin.</p>
      </div>
      <div style="display:flex;gap:var(--space-2);">
        <button class="btn btn-ghost btn-sm" onclick="showAllInbox()" style="position:relative;">
          📥 Gelen Kutusu
          ${unread > 0 ? `<span style="position:absolute;top:-4px;right:-4px;background:var(--accent-danger);color:#fff;border-radius:99px;font-size:10px;padding:1px 5px;font-weight:700;">${unread}</span>` : ""}
        </button>
        <button class="btn btn-primary btn-sm" onclick="newForm()">➕ Yeni Form</button>
      </div>
    </div>

    ${allForms.length === 0
      ? `<div class="empty-state"><div>📋</div><p>Henüz form oluşturulmamış.</p></div>`
      : `<div style="display:flex;flex-direction:column;gap:var(--space-3);">
          ${allForms.map(f => {
            const subCount = allSubmissions.filter(s => s.formId === f.id).length;
            const unreadCount = allSubmissions.filter(s => s.formId === f.id && !s.read).length;
            return `
              <div class="card" style="padding:var(--space-4);display:flex;align-items:center;gap:var(--space-4);flex-wrap:wrap;">
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:var(--font-semibold);">${esc(f.name)}</div>
                  <div style="font-size:var(--text-xs);color:var(--text-muted);margin-top:2px;">
                    /${esc(f.slug)} · ${(f.fields||[]).length} alan
                    · ${subCount} mesaj${unreadCount > 0 ? ` <strong style="color:var(--accent-danger);">(${unreadCount} okunmamış)</strong>` : ""}
                  </div>
                </div>
                <div style="display:flex;gap:var(--space-2);flex-shrink:0;">
                  <button class="btn btn-ghost btn-sm" onclick="viewInbox('${f.id}')">
                    📥 Gelen${unreadCount > 0 ? ` <span style="background:var(--accent-danger);color:#fff;border-radius:99px;padding:0 5px;font-size:10px;">${unreadCount}</span>` : ""}
                  </button>
                  <button class="btn btn-ghost btn-sm" onclick="copyEmbedCode('${f.id}','${esc(f.name)}')">📋 Kod</button>
                  <button class="btn btn-ghost btn-sm" onclick="editForm('${f.id}')">✏️</button>
                  <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);" onclick="deleteForm('${f.id}','${esc(f.name)}')">🗑️</button>
                </div>
              </div>`;
          }).join("")}
        </div>`
    }`;
}

// ══════════════════════════════════════════════
// FORM BUILDER
// ══════════════════════════════════════════════
let builderFields = [];

function renderFormBuilder() {
  const panel = document.getElementById("forms-panel");
  if (!panel) return;
  const form = editingFormId ? allForms.find(f => f.id === editingFormId) : null;
  if (!builderFields.length) builderFields = form?.fields ? [...form.fields] : [];

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-5);">
      <button class="btn btn-ghost btn-sm" onclick="backToFormList()">← Geri</button>
      <h3 style="font-weight:var(--font-bold);">${form ? "Formu Düzenle" : "Yeni Form Oluştur"}</h3>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-5);">

      <!-- Sol: Form Bilgileri -->
      <div>
        <div class="card" style="padding:var(--space-5);margin-bottom:var(--space-4);">
          <h4 style="font-weight:var(--font-semibold);margin-bottom:var(--space-4);">Form Bilgileri</h4>
          <div class="form-group">
            <label class="form-label">Form Adı <span style="color:var(--accent-danger);">*</span></label>
            <input type="text" id="fb-name" class="form-control"
              value="${esc(form?.name||"")}" placeholder="İletişim Formu"
              oninput="const s=document.getElementById('fb-slug');if(s&&!s.dataset.manual)s.value=slugifyFormName(this.value);" />
          </div>
          <div class="form-group">
            <label class="form-label">Slug <span style="font-size:var(--text-xs);color:var(--text-muted);">(URL'de kullanılır)</span></label>
            <input type="text" id="fb-slug" class="form-control" style="font-family:monospace;"
              value="${esc(form?.slug||"")}" placeholder="iletisim"
              oninput="this.dataset.manual='1';" />
          </div>
          <div class="form-group">
            <label class="form-label">Bildirim E-postası <span style="font-size:var(--text-xs);color:var(--text-muted);">(yeni mesajda bildir)</span></label>
            <input type="email" id="fb-email" class="form-control"
              value="${esc(form?.emailNotify||"")}" placeholder="admin@ozisg.com" />
          </div>
          <div class="form-group">
            <label class="form-label">Başarı Mesajı</label>
            <input type="text" id="fb-success" class="form-control"
              value="${esc(form?.successMessage||"")}" placeholder="Mesajınız alındı, teşekkürler!" />
          </div>
        </div>
      </div>

      <!-- Sağ: Alanlar -->
      <div>
        <div class="card" style="padding:var(--space-5);">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-4);">
            <h4 style="font-weight:var(--font-semibold);">Form Alanları</h4>
            <button class="btn btn-ghost btn-sm" onclick="addBuilderField()">➕ Alan Ekle</button>
          </div>
          <div id="builder-fields" style="display:flex;flex-direction:column;gap:var(--space-3);">
            ${builderFields.map((f,i) => renderBuilderField(f,i)).join("")}
          </div>
          ${builderFields.length === 0 ? `<p style="color:var(--text-muted);font-size:var(--text-sm);text-align:center;padding:var(--space-4);">Henüz alan eklenmedi.</p>` : ""}
        </div>
      </div>

    </div>

    <div style="display:flex;gap:var(--space-3);margin-top:var(--space-5);">
      <button class="btn btn-ghost" onclick="backToFormList()">İptal</button>
      <button class="btn btn-primary" style="flex:1;" onclick="saveForm()">💾 Formu Kaydet</button>
    </div>`;
}

function renderBuilderField(field, idx) {
  return `
    <div style="border:1px solid var(--border-color);border-radius:var(--border-radius);padding:var(--space-3);background:var(--bg-surface-2);" data-field-idx="${idx}">
      <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;">
        <select class="form-control bf-type" style="width:160px;font-size:var(--text-xs);"
          onchange="updateBuilderField(${idx},'type',this.value);rerenderFields();">
          ${FIELD_TYPES.map(t => `<option value="${t.value}" ${field.type===t.value?"selected":""}>${t.label}</option>`).join("")}
        </select>
        <input type="text" class="form-control bf-label" style="flex:1;font-size:var(--text-xs);"
          value="${esc(field.label||"")}" placeholder="Alan Adı"
          oninput="updateBuilderField(${idx},'label',this.value);" />
        <label style="display:flex;align-items:center;gap:4px;font-size:var(--text-xs);cursor:pointer;white-space:nowrap;">
          <input type="checkbox" class="bf-required" ${field.required?"checked":""}
            style="accent-color:var(--accent-primary);"
            onchange="updateBuilderField(${idx},'required',this.checked);" />
          Zorunlu
        </label>
        <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);padding:2px 6px;"
          onclick="removeBuilderField(${idx})">🗑️</button>
      </div>
      ${field.type === "select" ? `
        <div style="margin-top:var(--space-2);">
          <input type="text" class="form-control bf-options" style="font-size:var(--text-xs);"
            value="${esc((field.options||[]).join(", "))}"
            placeholder="Seçenekler: A, B, C (virgülle ayır)"
            oninput="updateBuilderField(${idx},'options',this.value.split(',').map(s=>s.trim()).filter(Boolean));" />
        </div>` : ""}
      ${field.label ? `
        <div style="margin-top:var(--space-2);font-size:10px;color:var(--text-muted);">
          Önizleme: <code>id="${esc(field.label.toLowerCase().replace(/\s+/g,"_"))}"</code>
        </div>` : ""}
    </div>`;
}

window.addBuilderField = function() {
  builderFields.push({ type: "text", label: "", required: false, placeholder: "" });
  rerenderFields();
};

window.removeBuilderField = function(idx) {
  builderFields.splice(idx, 1);
  rerenderFields();
};

window.updateBuilderField = function(idx, key, val) {
  if (builderFields[idx]) builderFields[idx][key] = val;
};

window.rerenderFields = function() {
  const container = document.getElementById("builder-fields");
  if (!container) return;
  container.innerHTML = builderFields.map((f,i) => renderBuilderField(f,i)).join("");
  if (!builderFields.length) {
    container.innerHTML = `<p style="color:var(--text-muted);font-size:var(--text-sm);text-align:center;padding:var(--space-4);">Henüz alan eklenmedi.</p>`;
  }
};

window.slugifyFormName = function(text) {
  return text.toLowerCase()
    .replace(/ğ/g,"g").replace(/ü/g,"u").replace(/ş/g,"s")
    .replace(/ı/g,"i").replace(/ö/g,"o").replace(/ç/g,"c")
    .replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
};

window.saveForm = async function() {
  const name    = document.getElementById("fb-name")?.value.trim();
  const slug    = document.getElementById("fb-slug")?.value.trim() || window.slugifyFormName(name||"form");
  const email   = document.getElementById("fb-email")?.value.trim() || null;
  const success = document.getElementById("fb-success")?.value.trim() || "Mesajınız alındı, teşekkürler!";

  if (!name) { showToast("Form adı zorunlu.", "warning"); return; }

  const fields = builderFields.filter(f => f.label).map((f, i) => ({
    id:          f.label.toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,""),
    label:       f.label,
    type:        f.type || "text",
    required:    f.required || false,
    placeholder: f.placeholder || "",
    options:     f.options || [],
    order:       i,
  }));

  try {
    if (editingFormId) {
      await updateDoc(doc(db, "forms", editingFormId), {
        name, slug, fields, emailNotify: email, successMessage: success,
        updatedAt: serverTimestamp()
      });
      showToast("Form güncellendi.", "success");
    } else {
      await addDoc(collection(db, "forms"), {
        name, slug, fields, emailNotify: email, successMessage: success,
        active: true, createdAt: serverTimestamp()
      });
      showToast("Form oluşturuldu.", "success");
    }
    backToFormList();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.deleteForm = async function(formId, name) {
  if (!confirm(`"${name}" formunu silmek istiyor musunuz?\nGelen mesajlar da silinecek.`)) return;
  try {
    await deleteDoc(doc(db, "forms", formId));
    // Bağlı submissions'ları sil
    const subSnap = await getDocs(query(collection(db,"form_submissions"), where("formId","==",formId)));
    for (const d of subSnap.docs) await deleteDoc(d.ref);
    showToast("Form silindi.", "info");
    await loadForms();
    await loadSubmissions();
    renderForms();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.newForm = function() {
  editingFormId  = null;
  builderFields  = [];
  activeFormView = "builder";
  renderFormBuilder();
};

window.editForm = function(formId) {
  editingFormId  = formId;
  const form     = allForms.find(f => f.id === formId);
  builderFields  = form?.fields ? [...form.fields] : [];
  activeFormView = "builder";
  renderFormBuilder();
};

window.backToFormList = async function() {
  editingFormId  = null;
  builderFields  = [];
  activeFormView = "list";
  await loadForms();
  await loadSubmissions();
  renderForms();
};

// ══════════════════════════════════════════════
// EMBED KOD
// ══════════════════════════════════════════════
window.copyEmbedCode = function(formId, formName) {
  const code = `<!-- ${formName} Formu -->\n<div data-form="${formId}"></div>\n<script type="module" src="js/form-embed.js"><\/script>`;
  navigator.clipboard.writeText(code).then(
    () => showToast("Embed kodu kopyalandı.", "success"),
    () => showToast("Kopyalanamadı, manuel kopyalayın.", "warning")
  );
};

// ══════════════════════════════════════════════
// GELEN KUTUSU (INBOX)
// ══════════════════════════════════════════════
window.viewInbox = async function(formId) {
  inboxFormId    = formId;
  activeFormView = "inbox";
  await loadSubmissions(formId);
  renderInbox();
};

window.showAllInbox = async function() {
  inboxFormId    = null;
  activeFormView = "inbox";
  await loadSubmissions();
  renderInbox();
};

function renderInbox() {
  const panel = document.getElementById("forms-panel");
  if (!panel) return;

  const form = inboxFormId ? allForms.find(f => f.id === inboxFormId) : null;
  const unreadCount = allSubmissions.filter(s => !s.read).length;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-5);flex-wrap:wrap;">
      <button class="btn btn-ghost btn-sm" onclick="backToFormList()">← Formlar</button>
      <h3 style="font-weight:var(--font-bold);">
        📥 ${form ? esc(form.name) + " — Gelen Kutusu" : "Tüm Mesajlar"}
        ${unreadCount > 0 ? `<span style="background:var(--accent-danger);color:#fff;border-radius:99px;padding:1px 8px;font-size:var(--text-xs);margin-left:6px;">${unreadCount} okunmamış</span>` : ""}
      </h3>
      ${unreadCount > 0 ? `<button class="btn btn-ghost btn-sm" style="margin-left:auto;" onclick="markAllRead()">✅ Tümünü Okundu İşaretle</button>` : ""}
    </div>

    ${allSubmissions.length === 0
      ? `<div class="empty-state"><div>📭</div><p>Henüz mesaj yok.</p></div>`
      : `<div style="display:flex;flex-direction:column;gap:var(--space-3);">
          ${allSubmissions.map(s => renderSubmissionCard(s)).join("")}
        </div>`
    }`;
}

function renderSubmissionCard(s) {
  const formName = allForms.find(f => f.id === s.formId)?.name || s.formId;
  const dataHtml = Object.entries(s.data || {}).map(([k, v]) =>
    `<div style="display:flex;gap:var(--space-2);font-size:var(--text-sm);">
       <span style="color:var(--text-muted);min-width:100px;">${esc(k)}:</span>
       <span>${esc(String(v||""))}</span>
     </div>`
  ).join("");

  return `
    <div class="card" style="padding:var(--space-4);border-left:3px solid ${s.read ? "var(--border-color)" : "var(--accent-primary)"};">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-2);margin-bottom:var(--space-3);">
        <div style="display:flex;align-items:center;gap:var(--space-2);">
          ${!s.read ? `<span style="width:8px;height:8px;border-radius:50%;background:var(--accent-primary);display:inline-block;"></span>` : ""}
          <span style="font-size:var(--text-xs);color:var(--text-muted);">${esc(formName)} · ${fmtDate(s.createdAt)}</span>
          ${s.starred ? `<span style="color:#f59e0b;">⭐</span>` : ""}
        </div>
        <div style="display:flex;gap:4px;">
          ${!s.read ? `<button class="btn btn-ghost btn-sm" style="font-size:10px;" onclick="markRead('${s.id}')">✓ Okundu</button>` : ""}
          <button class="btn btn-ghost btn-sm" style="font-size:10px;" onclick="toggleStar('${s.id}',${!s.starred})">${s.starred ? "★ Kaldır" : "☆ Yıldız"}</button>
          <button class="btn btn-ghost btn-sm" style="font-size:10px;color:var(--accent-danger);" onclick="deleteSubmission('${s.id}')">🗑️</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:var(--space-2);">
        ${dataHtml}
      </div>
    </div>`;
}

window.markRead = async function(subId) {
  try {
    await updateDoc(doc(db, "form_submissions", subId), { read: true });
    const s = allSubmissions.find(s => s.id === subId);
    if (s) s.read = true;
    renderInbox();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.markAllRead = async function() {
  try {
    const unread = allSubmissions.filter(s => !s.read);
    await Promise.all(unread.map(s => updateDoc(doc(db,"form_submissions",s.id), { read:true })));
    allSubmissions.forEach(s => { s.read = true; });
    showToast("Tümü okundu işaretlendi.", "success");
    renderInbox();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.toggleStar = async function(subId, starred) {
  try {
    await updateDoc(doc(db, "form_submissions", subId), { starred });
    const s = allSubmissions.find(s => s.id === subId);
    if (s) s.starred = starred;
    renderInbox();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.deleteSubmission = async function(subId) {
  if (!confirm("Bu mesajı silmek istiyor musunuz?")) return;
  try {
    await deleteDoc(doc(db, "form_submissions", subId));
    allSubmissions = allSubmissions.filter(s => s.id !== subId);
    renderInbox();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

// ══════════════════════════════════════════════
// SEKMEYİ AKTİF YAPMA (switchTab hook)
// ══════════════════════════════════════════════
const _origSwitchTabForms = window.switchTab;
window.switchTab = function(tab) {
  if (typeof _origSwitchTabForms === "function") _origSwitchTabForms(tab);
  if (tab === "forms") {
    activeFormView = "list";
    Promise.all([loadForms(), loadSubmissions()]).then(() => renderForms());
  }
};

// ══════════════════════════════════════════════
// FORM SUBMIT FONKSİYONU (ön yüz için export)
// ══════════════════════════════════════════════
export async function submitForm(formId, data) {
  try {
    await addDoc(collection(db, "form_submissions"), {
      formId,
      data,
      read:      false,
      starred:   false,
      createdAt: serverTimestamp(),
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
window.submitFormData = submitForm;
