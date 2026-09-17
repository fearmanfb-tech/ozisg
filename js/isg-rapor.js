/**
 * isg-rapor.js — Günlük İSG Saha Raporu
 * Tabs: Rapor Formu | Mail Önizleme | Arşiv
 * v2: localStorage cache (ozisg_rapor_cache, 24h TTL) + skeleton loader
 */

import { requireToolAccess, db, showToast } from "./app.js";
import { app } from "./firebase-config.js";
import {
  collection, query, where, orderBy,
  getDocs, addDoc, updateDoc, deleteDoc,
  doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// GÖREV 3: cPanel upload_image.php KALDIRILDI — Firebase Storage standardı
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
const _rpStorage = getStorage(app);
const _rpAuth    = getAuth(app);

// ─── Cache sabitleri ───
const CACHE_KEY = "ozisg_rapor_cache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 saat

// ─── Skeleton CSS (IIFE — Tailwind gerektirmez) ───
(function () {
  const s = document.createElement('style');
  s.textContent = `
    @keyframes _rp_pulse { 0%,100%{opacity:1} 50%{opacity:.45} }
    .sk-row  { animation:_rp_pulse 1.4s ease-in-out infinite; }
    .sk-cell { display:inline-block; background:var(--border-color,#e2e8f0); border-radius:4px; height:14px; }
  `;
  document.head.appendChild(s);
})();

const COL = "tool_isg_reports";
const SETTINGS_COL = "tool_isg_rapor_settings";

let currentUser = null;
let currentTab  = "form";
let editingId   = null;
let allReports  = [];

// ─── Ayarlar (kurumsal bilgi + mail dağıtım listesi) ───
const DEFAULT_FOOTER_TEXT = "Bu rapor ozisg.com İSG Rapor Aracı ile oluşturulmuştur.";
let settings = { companyName: "", logoUrl: "", mailRecipients: [], signature: "", footerText: "" };

// ─── In-memory state ───
const state = {
  tarih:          "",
  hazirlayan:     "",
  kazalar:        [],
  ramakKala:      [],
  maddiHasar:     [],
  uygunsuzluklar: [],
  faaliyetler:    [],
  denetimler:     [],
  sahaCalismalar: [],
  isIzinleri:     [],
  ekNotlar:       ""
};

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
(async () => {
  currentUser = await requireToolAccess("tool_isg_reports", {
    loadingEl:  "page-loading",
    authGateEl: "auth-gate",
    mainEl:     "main-content"
  });
  if (!currentUser) return;

  setupListeners();
  resetForm();
  showSkeletonArchive();
  await loadSettings();
  await loadReports();
})();

function setupListeners() {
  document.getElementById("saveReportBtn")?.addEventListener("click", saveReport);
  document.getElementById("newReportBtn")?.addEventListener("click", () => { resetForm(); switchTab("form"); });
  document.getElementById("copyMailBtn")?.addEventListener("click", copyMail);
  document.getElementById("sendMailBtn")?.addEventListener("click", sendReportMail);
  document.getElementById("saveSettingsBtn")?.addEventListener("click", saveSettings);
  document.getElementById("archSearch")?.addEventListener("input", renderArchive);

  // Genel bilgi değişince preview güncelle
  document.getElementById("input-date")?.addEventListener("change",   syncGeneralInfo);
  document.getElementById("input-preparer")?.addEventListener("input", syncGeneralInfo);
  document.getElementById("input-ekNotlar")?.addEventListener("input", syncGeneralInfo);
}

function syncGeneralInfo() {
  state.tarih      = document.getElementById("input-date")?.value     || "";
  state.hazirlayan = document.getElementById("input-preparer")?.value || "";
  state.ekNotlar   = document.getElementById("input-ekNotlar")?.value || "";
}

// ═══════════════════════════════════════════════
// SEKME
// ═══════════════════════════════════════════════
window.switchTab = function(tab) {
  currentTab = tab;
  document.querySelectorAll(".work-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".work-tab-content").forEach(c =>
    (c.style.display = c.id === `tab-${tab}` ? "block" : "none"));
  if (tab === "preview")  renderPreview();
  if (tab === "archive")  renderArchive();
  if (tab === "settings") fillSettingsForm();
};

// ═══════════════════════════════════════════════
// AYARLAR (kurumsal bilgi + mail dağıtım listesi)
// ═══════════════════════════════════════════════
async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, SETTINGS_COL, currentUser.uid));
    if (snap.exists()) {
      const d = snap.data();
      settings = {
        companyName:    d.companyName    || "",
        logoUrl:        d.logoUrl        || "",
        mailRecipients: Array.isArray(d.mailRecipients) ? d.mailRecipients : [],
        signature:      d.signature      || "",
        footerText:     d.footerText     || "",
      };
    }
  } catch (err) {
    console.warn("Ayarlar yüklenemedi:", err);
  }
}

function fillSettingsForm() {
  const cn = document.getElementById("set-companyName");
  const lu = document.getElementById("set-logoUrl");
  const mr = document.getElementById("set-mailRecipients");
  const sg = document.getElementById("set-signature");
  const ft = document.getElementById("set-footerText");
  if (cn) cn.value = settings.companyName;
  if (lu) lu.value = settings.logoUrl;
  if (mr) mr.value = settings.mailRecipients.join("\n");
  if (sg) sg.value = settings.signature;
  if (ft) ft.value = settings.footerText || DEFAULT_FOOTER_TEXT;
}

function parseRecipients(raw) {
  return raw.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
}

window.saveSettings = async function() {
  const cn = document.getElementById("set-companyName")?.value.trim() || "";
  const lu = document.getElementById("set-logoUrl")?.value.trim() || "";
  const mr = parseRecipients(document.getElementById("set-mailRecipients")?.value || "");
  const sg = document.getElementById("set-signature")?.value.trim() || "";
  const ft = document.getElementById("set-footerText")?.value.trim() || DEFAULT_FOOTER_TEXT;

  const invalid = mr.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (invalid.length) {
    showToast(`Geçersiz e-posta adresi: ${invalid.join(", ")}`, "error");
    return;
  }

  const btn = document.getElementById("saveSettingsBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Kaydediliyor…"; }
  try {
    settings = { companyName: cn, logoUrl: lu, mailRecipients: mr, signature: sg, footerText: ft };
    await setDoc(doc(db, SETTINGS_COL, currentUser.uid), {
      ...settings,
      updatedAt: serverTimestamp()
    }, { merge: true });
    showToast("Ayarlar kaydedildi ✅", "success");
  } catch (err) {
    showToast("Ayarlar kaydedilemedi: " + err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "💾 Ayarları Kaydet"; }
  }
};

// ═══════════════════════════════════════════════
// DİNAMİK LİSTE YÖNETİMİ
// ═══════════════════════════════════════════════
const DEFAULTS = {
  kazalar:        { details: "", lostDays: 0, image: null },
  ramakKala:      { details: "", image: null },
  maddiHasar:     { details: "", image: null },
  uygunsuzluklar: { details: "", images: [] },
  faaliyetler:    { type: "Toplantı", customType: "", details: "" },
  denetimler:     { block: "", details: "" },
  sahaCalismalar: { details: "" },
  isIzinleri:     { type: "Sıcak İş", company: "", area: "", work: "", companion: "", responsible: "", image: null }
};

window.addItem = function(listName) {
  // Derin kopyalama ile referans sorununu çözüyoruz
  const template = JSON.parse(JSON.stringify(DEFAULTS[listName]));
  // Çakışmayı önlemek için benzersiz ID atıyoruz
  const item = { id: crypto.randomUUID(), ...template };
  
  state[listName].push(item);
  renderList(listName);
};

window.removeItem = function(listName, id) {
  state[listName] = state[listName].filter(i => i.id !== id);
  renderList(listName);
};

window.updateField = function(listName, id, field, value) {
  const item = state[listName].find(i => i.id === id);
  if (item) item[field] = value;
};

// ─── Görsel sıkıştırma (Canvas API) — Blob döner ───
// GÖREV 3: Eski compressImage base64 üretiyordu (cPanel upload için).
// Artık Firebase Storage uploadBytes kullanıyoruz → blob daha verimli.
async function compressImageToBlob(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const MAX = 600;
        let { width: w, height: h } = img;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else       { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('Blob oluşmadı')), "image/jpeg", 0.5);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

window.uploadImage = function(listName, id) {
  const item = state[listName].find(i => i.id === id);
  if (!item) return;
  if (listName === "uygunsuzluklar" && item.images.length >= 3) {
    showToast("En fazla 3 görsel ekleyebilirsiniz.", "warning"); return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;

    // Yükleniyor göstergesi — Tırnak eksiği düzeltildi
    const triggerBtn = document.querySelector(
      `[onclick*="uploadImage('${listName}','${id}')"]`
    );
    const rowDiv = triggerBtn ? triggerBtn.closest('.list-item') : null;
    if (rowDiv) {
      rowDiv.style.opacity = '0.5';
      rowDiv.style.pointerEvents = 'none';
    }

    if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = "⏳ Yükleniyor..."; }
    try {
      const blob = await compressImageToBlob(file);
      const uid = _rpAuth.currentUser?.uid;
      if (!uid) throw new Error('Oturum bulunamadı');
      const safeName = `${listName}_${id}_${Date.now()}.jpg`;
      const path = `tool_isg_reports/${uid}/${safeName}`;
      const ref  = storageRef(_rpStorage, path);
      const snap = await uploadBytes(ref, blob, { contentType: 'image/jpeg' });
      const url  = await getDownloadURL(snap.ref);

      if (listName === "uygunsuzluklar") {
        item.images.push(url);
      } else {
        item.image = url;
      }
      renderList(listName);
    } catch (err) {
      showToast("Görsel yüklenemedi: " + err.message, "error");
      if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = "📷 Görsel Ekle"; }
    }
  };
  input.click();
};

window.removeImage = async function(listName, id, imgIndex) {
  const item = state[listName].find(i => i.id === id);
  if (!item) return;

  let urlToDelete = null;

  // Silinecek görselin URL'sini kenara alalım
  if (listName === "uygunsuzluklar") {
    urlToDelete = item.images[imgIndex];
    item.images.splice(imgIndex, 1);
  } else {
    urlToDelete = item.image;
    item.image = null;
  }
  
  // Önce ekrandan hemen kaldır (Kullanıcı beklemesin, UX bozulmasın)
  renderList(listName);

  // Arka planda Firebase Storage'dan dosyayı fiziksel olarak sil
  if (urlToDelete && urlToDelete.includes("firebasestorage")) {
    try {
      const fileRef = storageRef(_rpStorage, urlToDelete);
      await deleteObject(fileRef);
    } catch (err) {
      console.warn("Storage silme hatası (Önemli değil, dosya zaten silinmiş olabilir):", err);
    }
  }
};

function renderList(listName) {
  const container = document.getElementById(`list-${listName}`);
  if (!container) return;
  const items = state[listName];

  if (!items.length) {
    container.innerHTML = `<div class="list-empty">Henüz kayıt eklenmedi.</div>`;
    return;
  }

  container.innerHTML = items.map((item, idx) => renderItem(listName, item, idx)).join("");
}

function imgRow(listName, item) {
  if (item.image) {
    return `<div class="li-img-row">
      <img src="${item.image}" class="li-img-thumb" alt="görsel" />
      <button class="li-img-remove" onclick="removeImage('${listName}','${item.id}')" title="Görseli kaldır">✕ Görseli kaldır</button>
    </div>`;
  }
  return `<div class="li-img-row">
    <button class="li-img-btn" onclick="uploadImage('${listName}','${item.id}')">📷 Görsel Ekle</button>
  </div>`;
}

function imgRowUyg(item) {
  const thumbs = item.images.map((src, idx) => `
    <div style="position:relative;display:inline-block;margin-right:6px;">
      <img src="${src}" style="width:56px;height:56px;object-fit:cover;border-radius:4px;border:1px solid #e5e7eb;" />
      <button type="button" onclick="removeImage('uygunsuzluklar','${item.id}',${idx})"
        style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:#ef4444;color:#fff;border:none;cursor:pointer;font-size:10px;display:flex;align-items:center;justify-content:center;">✕</button>
    </div>`).join("");
  const addBtn = item.images.length < 3
    ? `<button class="li-img-btn" type="button" onclick="uploadImage('uygunsuzluklar','${item.id}')">📷 Görsel Ekle</button>`
    : "";
  return `<div class="li-img-row" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;">${thumbs}${addBtn}</div>`;
}

function renderItem(listName, item, idx) {
  const rm = `onclick="removeItem('${listName}','${item.id}')"`;

  if (listName === "kazalar") return `
    <div class="list-item">
      <div class="list-item-fields">
        <div class="li-row">
          <input class="li-input" placeholder="Kaza detayı (nerede, nasıl oldu?)"
            value="${esc(item.details)}" oninput="updateField('kazalar','${item.id}','details',this.value)" />
          <input class="li-input w80" type="number" min="0" placeholder="Kayıp gün"
            value="${item.lostDays}" oninput="updateField('kazalar','${item.id}','lostDays',+this.value)" />
        </div>
        ${imgRow("kazalar", item)}
      </div>
      <button class="li-remove" ${rm} title="Sil">✕</button>
    </div>`;

  if (listName === "ramakKala" || listName === "maddiHasar" || listName === "sahaCalismalar") {
    const ph = listName === "ramakKala" ? "Ramak kala detayı…" : listName === "maddiHasar" ? "Maddi hasar detayı…" : "Yapılan saha çalışması…";
    const hasImg = listName !== "sahaCalismalar";
    return `
    <div class="list-item">
      <div class="list-item-fields">
        <input class="li-input" placeholder="${ph}"
          value="${esc(item.details)}" oninput="updateField('${listName}','${item.id}','details',this.value)" />
        ${hasImg ? imgRow(listName, item) : ""}
      </div>
      <button class="li-remove" ${rm} title="Sil">✕</button>
    </div>`;
  }

  if (listName === "uygunsuzluklar") return `
    <div class="list-item">
      <span style="font-size:var(--text-xs);color:var(--text-muted);padding-top:6px;min-width:20px;">${idx+1}.</span>
      <div class="list-item-fields">
        <input class="li-input" placeholder="Uygunsuzluğu açıklayınız…"
          value="${esc(item.details)}" oninput="updateField('uygunsuzluklar','${item.id}','details',this.value)" />
        ${imgRowUyg(item)}
      </div>
      <button class="li-remove" ${rm} title="Sil">✕</button>
    </div>`;

  if (listName === "faaliyetler") return `
    <div class="list-item">
      <div class="list-item-fields">
        <div class="li-row">
          <select class="li-input w140" onchange="updateField('faaliyetler','${item.id}','type',this.value)">
            ${["Toplantı","Gemba Yürüyüşü","Eğitim","Tatbikat","Diğer"].map(t =>
              `<option value="${t}" ${item.type===t?"selected":""}>${t}</option>`).join("")}
          </select>
          <input class="li-input" placeholder="Faaliyet detayı…"
            value="${esc(item.details)}" oninput="updateField('faaliyetler','${item.id}','details',this.value)" />
        </div>
        <div class="li-row" id="ct_${item.id}" style="display:${item.type==='Diğer'?'flex':'none'};">
          <input class="li-input" placeholder="Faaliyet adını yazın…"
            value="${esc(item.customType)}" oninput="updateField('faaliyetler','${item.id}','customType',this.value)" />
        </div>
      </div>
      <button class="li-remove" ${rm} title="Sil">✕</button>
    </div>`;

  if (listName === "denetimler") return `
    <div class="list-item">
      <div class="list-item-fields">
        <div class="li-row">
          <input class="li-input w140" placeholder="Blok/Alan (A Blok…)"
            value="${esc(item.block)}" oninput="updateField('denetimler','${item.id}','block',this.value)" />
          <input class="li-input" placeholder="Yapılan denetim…"
            value="${esc(item.details)}" oninput="updateField('denetimler','${item.id}','details',this.value)" />
        </div>
      </div>
      <button class="li-remove" ${rm} title="Sil">✕</button>
    </div>`;

  if (listName === "isIzinleri") return `
    <div class="list-item">
      <div class="list-item-fields">
        <div class="li-row">
          <select class="li-input w140" onchange="updateField('isIzinleri','${item.id}','type',this.value)">
            ${["Sıcak İş","Yüksekte Çalışma","Kapalı Alan","Kazı İşi","Elektrik Çalışması","Tehlikeli Kapsam Dışı"].map(t =>
              `<option value="${t}" ${item.type===t?"selected":""}>${t}</option>`).join("")}
          </select>
          <input class="li-input" placeholder="Firma adı"
            value="${esc(item.company)}" oninput="updateField('isIzinleri','${item.id}','company',this.value)" />
        </div>
        <div class="li-row">
          <input class="li-input" placeholder="Bölge (B Blok Çatı…)"
            value="${esc(item.area)}" oninput="updateField('isIzinleri','${item.id}','area',this.value)" />
          <input class="li-input" placeholder="Yapılan iş (kaynak, montaj…)"
            value="${esc(item.work)}" oninput="updateField('isIzinleri','${item.id}','work',this.value)" />
        </div>
        <div class="li-row">
          <input class="li-input" placeholder="Refakat eden görevli"
            value="${esc(item.companion)}" oninput="updateField('isIzinleri','${item.id}','companion',this.value)" />
          <input class="li-input" placeholder="Sorumlu kişi"
            value="${esc(item.responsible)}" oninput="updateField('isIzinleri','${item.id}','responsible',this.value)" />
        </div>
        ${imgRow("isIzinleri", item)}
      </div>
      <button class="li-remove" ${rm} title="Sil">✕</button>
    </div>`;

  return "";
}

// ═══════════════════════════════════════════════
// MAİL ÖNİZLEME
// ═══════════════════════════════════════════════
function renderPreview() {
  const tpl = document.getElementById("email-template");
  if (!tpl) return;
  syncGeneralInfo();

  const s = state;
  const tarihStr = s.tarih ? formatTrDate(s.tarih) : "—";
  const hazirlayan = esc(s.hazirlayan) || "—";

  const hasIncident = s.kazalar.length || s.ramakKala.length || s.maddiHasar.length;
  const hasUyg      = s.uygunsuzluklar.length;

  const incidentBox = hasIncident
    ? `<div style="background:#fef2f2;padding:14px 16px;border-radius:4px;margin-bottom:10px;color:#1e293b;">
        <span style="color:#dc2626;font-weight:bold;">🚨 DİKKAT:</span> Bu rapor döneminde olay/kaza kaydı bulunmaktadır.
       </div>`
    : `<div style="background:#f0fdf4;padding:14px 16px;border-radius:4px;margin-bottom:10px;color:#1e293b;">
        <span style="color:#16a34a;font-weight:bold;">✅ OLAY YOK:</span> Bu rapor döneminde herhangi bir kaza veya ramak kala olayı yaşanmamıştır.
       </div>`;

  const uygBox = hasUyg
    ? `<div style="background:#fffbeb;padding:14px 16px;border-radius:4px;color:#1e293b;">
        <span style="color:#d97706;font-weight:bold;">⚠️ UYGUNSUZLUK:</span> ${s.uygunsuzluklar.length} adet uygunsuzluk tespit edilmiştir.
       </div>`
    : `<div style="background:#eff6ff;padding:14px 16px;border-radius:4px;color:#1e293b;">
        <span style="color:#2563eb;font-weight:bold;">ℹ️ UYGUNSUZLUK YOK:</span> Bu rapor döneminde uygunsuzluk tespit edilmemiştir.
       </div>`;

  const kazalarHtml = s.kazalar.length
    ? `<table width="100%" cellpadding="10" cellspacing="0" border="1"
          style="border-collapse:collapse;border-color:#e2e8f0;border-style:solid;border-width:1px;">
        <thead><tr style="background:#fce7f3;">
          <th align="left"   style="color:#1f2937;padding:10px;width:60%;">Detay</th>
          <th align="center" style="color:#1f2937;padding:10px;width:20%;">Kayıp Gün</th>
          <th align="center" style="color:#1f2937;padding:10px;width:20%;">Görsel</th>
        </tr></thead>
        <tbody>${s.kazalar.map(k => `
          <tr style="background:#fff;">
            <td align="left" style="padding:10px;color:#334155;vertical-align:top;">
              <div>${esc(k.details)||"—"}</div>
              ${k.image ? `<div style="margin-top:8px;"><img src="${k.image}" width="120" height="120" style="max-width:120px;max-height:120px;object-fit:contain;border-radius:4px;border:1px solid #e5e7eb;" /></div>` : ""}
            </td>
            <td align="center" style="padding:10px;color:#334155;vertical-align:top;">${k.lostDays||0}</td>
            <td align="center" style="padding:10px;color:#94a3b8;vertical-align:top;">${k.image ? "Var" : "—"}</td>
          </tr>`).join("")}
        </tbody></table>`
    : `<div style="font-style:italic;color:#64748b;">Kaza kaydı girilmedi.</div>`;

  const ramakHtml = s.ramakKala.length
    ? `<ul style="margin:0;padding-left:20px;color:#334155;">${s.ramakKala.map(r => `
        <li style="margin-bottom:8px;"><div>${esc(r.details)}</div>
        ${r.image ? `<div style="margin-top:6px;"><img src="${r.image}" width="120" height="120" style="max-width:120px;max-height:120px;object-fit:contain;border-radius:4px;border:1px solid #e5e7eb;" /></div>` : ""}</li>`).join("")}
      </ul>`
    : `<div style="font-style:italic;color:#64748b;">—</div>`;

  const maddiHtml = s.maddiHasar.length
    ? `<ul style="margin:0;padding-left:20px;color:#334155;">${s.maddiHasar.map(r => `
        <li style="margin-bottom:8px;"><div>${esc(r.details)}</div>
        ${r.image ? `<div style="margin-top:6px;"><img src="${r.image}" width="120" height="120" style="max-width:120px;max-height:120px;object-fit:contain;border-radius:4px;border:1px solid #e5e7eb;" /></div>` : ""}</li>`).join("")}
      </ul>`
    : `<div style="font-style:italic;color:#64748b;">—</div>`;

  const uygHtml = (() => {
    if (!s.uygunsuzluklar.length) return `<div style="font-style:italic;color:#64748b;">Uygunsuzluk girilmedi.</div>`;
    const uygCell = (u, idx) => {
      const imgs = Array.isArray(u.images) && u.images.length
        ? u.images
        : (u.image ? [u.image] : []);
      const imgBlock = imgs.length
        ? `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;"><tbody><tr>${
            imgs.map(src => `<td style="padding-right:6px;vertical-align:top;"><img src="${src}" width="140" height="140" style="max-width:140px;max-height:140px;object-fit:contain;border-radius:4px;border:1px solid #e5e7eb;" /></td>`).join("")
          }</tr></tbody></table>`
        : "";
      return `<div style="color:#94a3b8;margin-bottom:4px;">${idx + 1}.</div>
        <div style="line-height:1.5;margin-bottom:8px;color:#334155;">${esc(u.details)}</div>
        ${imgBlock}`;
    };
    // 2-column grid: chunk into pairs
    const rows = [];
    for (let i = 0; i < s.uygunsuzluklar.length; i += 2) {
      const left  = s.uygunsuzluklar[i];
      const right = s.uygunsuzluklar[i + 1];
      rows.push(`
        <tr>
          <td class="osg-stack-td" width="50%" valign="top" style="padding:0 10px 16px 0;">${uygCell(left, i)}</td>
          <td class="osg-stack-td" width="50%" valign="top" style="padding:0 0 16px 10px;">${right ? uygCell(right, i + 1) : ""}</td>
        </tr>`);
    }
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tbody>${rows.join("")}</tbody></table>`;
  })();

  const faalHtml = s.faaliyetler.length
    ? s.faaliyetler.map(f => {
        const tip = f.type === "Diğer" ? esc(f.customType) : f.type;
        return `<div style="margin-bottom:4px;color:#334155;"><strong>${tip}:</strong> ${esc(f.details)}</div>`;
      }).join("")
    : `<div style="font-style:italic;color:#64748b;">—</div>`;

  const denHtml = s.denetimler.length
    ? s.denetimler.map(d =>
        `<div style="margin-bottom:4px;color:#334155;"><strong>${esc(d.block)}:</strong> ${esc(d.details)}</div>`
      ).join("")
    : `<div style="font-style:italic;color:#64748b;">—</div>`;

  const sahaHtml = s.sahaCalismalar.length
    ? `<ul style="margin:0;padding-left:20px;color:#334155;">${s.sahaCalismalar.map(sc => `
        <li style="margin-bottom:8px;"><div>${esc(sc.details)}</div></li>`).join("")}
      </ul>`
    : `<div style="font-style:italic;color:#64748b;">—</div>`;

  const izinHtml = s.isIzinleri.length
    ? `<table width="100%" cellpadding="8" cellspacing="0" border="1"
          style="border-collapse:collapse;border-color:#e2e8f0;border-style:solid;border-width:1px;text-align:left;">
        <thead><tr style="background:#e0e7ff;color:#1e293b;">
          ${["İzin Tipi","Firma","Bölge","Yapılan İş","Refakatçi","Sorumlu","Görsel"].map(h =>
            `<th style="padding:8px;">${h}</th>`).join("")}
        </tr></thead>
        <tbody>${s.isIzinleri.map(iz => `
          <tr style="background:#fff;color:#334155;">
            <td style="padding:8px;font-weight:bold;">${esc(iz.type)||"—"}</td>
            <td style="padding:8px;">${esc(iz.company)||"—"}</td>
            <td style="padding:8px;">${esc(iz.area)||"—"}</td>
            <td style="padding:8px;">${esc(iz.work)||"—"}</td>
            <td style="padding:8px;">${esc(iz.companion)||"—"}</td>
            <td style="padding:8px;">${esc(iz.responsible)||"—"}</td>
            <td align="center" style="padding:8px;color:#94a3b8;">${iz.image ? `<img src="${iz.image}" width="100" height="80" style="max-width:100px;max-height:80px;object-fit:contain;border-radius:4px;" />` : "—"}</td>
          </tr>`).join("")}
        </tbody></table>`
    : `<div style="font-style:italic;color:#64748b;">İş izni girilmedi.</div>`;

  const ekNotRow = s.ekNotlar
    ? `<tr><td style="padding:25px 30px;background:#f8fafc;border-top:1px solid #e2e8f0;">
        ${sectionTitle("💡 Ek Notlar")}
        <p style="white-space:pre-wrap;color:#374151;margin:0;">${esc(s.ekNotlar)}</p>
       </td></tr>`
    : "";

  const signatureRow = settings.signature
    ? `<tr><td style="padding:16px 30px;border-top:1px solid #e2e8f0;">
        <p style="white-space:pre-wrap;color:#64748b;font-size:10px;margin:0;">${esc(settings.signature)}</p>
       </td></tr>`
    : "";

  const brandLogo = settings.logoUrl
    ? `<img src="${esc(settings.logoUrl)}" alt="logo" width="160" height="32" style="height:32px;max-width:160px;object-fit:contain;margin-bottom:8px;display:block;" />`
    : "";

  const preheaderParts = [
    `İSG Günlük Saha Raporu — ${tarihStr}`,
    settings.companyName ? esc(settings.companyName) : "",
    hasIncident ? "Olay/kaza kaydı bulunmaktadır." : "Olay/kaza kaydı yok.",
    hasUyg ? `${s.uygunsuzluklar.length} uygunsuzluk tespit edildi.` : "Uygunsuzluk yok."
  ].filter(Boolean);
  const preheaderText = esc(preheaderParts.join(" — "));
  const brandSubtitle = settings.companyName
    ? esc(settings.companyName)
    : "Bulut entegrasyonlu günlük raporlama";

  tpl.innerHTML = `
    <style>
      @media only screen and (max-width:600px) {
        .osg-stack-td { display:block !important; width:100% !important; box-sizing:border-box !important; padding-left:0 !important; padding-right:0 !important; }
        .osg-stack-border { border-left:none !important; border-top:1px solid #e2e8f0; padding-top:12px !important; margin-top:12px; }
      }
    </style>
    <div style="display:none;visibility:hidden;opacity:0;overflow:hidden;height:0;width:0;max-height:0;max-width:0;font-size:1px;line-height:1px;mso-hide:all;">
      ${preheaderText}
    </div>
    <!--[if mso]>
    <table role="presentation" width="800" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td>
    <![endif]-->
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#1e293b;max-width:800px;margin:0 auto;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;width:100%;">
        <tbody>
          <tr>
            <td style="background:#234383;padding:24px 30px;">
              ${brandLogo}
              <div style="font-size:20px;font-weight:bold;color:#fff;">🛡️ İSG GÜNLÜK SAHA RAPORU</div>
              <div style="font-size:13px;color:#cbd5e1;margin-top:6px;">${brandSubtitle}</div>
            </td>
          </tr>
          <tr><td style="height:4px;background:#ea580c;line-height:4px;font-size:4px;">&nbsp;</td></tr>
          <tr>
            <td style="padding:30px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                  style="margin-bottom:25px;border-bottom:1px solid #f1f5f9;padding-bottom:15px;">
                <tbody>
                  <tr>
                    <td width="30%" style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;">Tarih</td>
                    <td width="70%" style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;">Hazırlayan</td>
                  </tr>
                  <tr>
                    <td style="font-size:15px;color:#1e293b;font-weight:bold;padding-top:4px;">${tarihStr}</td>
                    <td style="font-size:15px;color:#1e293b;font-weight:bold;padding-top:4px;">${hazirlayan}</td>
                  </tr>
                </tbody>
              </table>
              <div style="margin-bottom:25px;">${incidentBox}${uygBox}</div>
              <div style="margin-bottom:25px;">
                ${sectionTitle("🚨 1. Kazalar, Ramak Kala ve Maddi Hasarlı Olaylar")}
                <div style="margin-bottom:15px;">
                  <div style="font-weight:bold;color:#1e293b;margin-bottom:8px;">Yaşanan Kazalar:</div>
                  ${kazalarHtml}
                </div>
                <div style="margin-bottom:15px;">
                  <div style="font-weight:bold;color:#1e293b;margin-bottom:4px;">Ramak Kala:</div>
                  ${ramakHtml}
                </div>
                <div>
                  <div style="font-weight:bold;color:#1e293b;margin-bottom:4px;">Maddi Hasarlı:</div>
                  ${maddiHtml}
                </div>
              </div>
              <div style="margin-bottom:25px;">
                ${sectionTitle("🔍 2. Saha Gözlemleri ve Uygunsuzluklar")}
                ${uygHtml}
              </div>
              <div style="margin-bottom:25px;">
                ${sectionTitle("📋 3. İSG Planları, Faaliyetleri ve Denetimler")}
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tbody>
                    <tr>
                      <td class="osg-stack-td osg-stack-border" width="50%" valign="top" style="padding-right:15px;">
                        <div style="font-weight:bold;color:#1e293b;margin-bottom:8px;font-size:13px;">İSG Faaliyetleri:</div>
                        ${faalHtml}
                      </td>
                      <td class="osg-stack-td osg-stack-border" width="50%" valign="top" style="border-left:1px solid #e2e8f0;padding-left:15px;">
                        <div style="font-weight:bold;color:#1e293b;margin-bottom:8px;font-size:13px;">Denetimler:</div>
                        ${denHtml}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style="margin-bottom:25px;">
                ${sectionTitle("🛠️ 4. İSG Kapsamında Yapılan Saha Çalışmaları")}
                ${sahaHtml}
              </div>
              <div>
                ${sectionTitle("🔐 5. Verilen İş İzinleri")}
                ${izinHtml}
              </div>
            </td>
          </tr>
          ${ekNotRow}
          ${signatureRow}
          <tr>
            <td style="background:#234383;padding:16px;text-align:center;font-size:10px;color:#cbd5e1;">
              ${esc(settings.footerText || DEFAULT_FOOTER_TEXT)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <!--[if mso]>
    </td></tr></table>
    <![endif]-->`;
}

function sectionTitle(text) {
  return `<div style="font-weight:bold;color:#fff;background:#234383;padding:10px 14px;border-radius:4px;margin-bottom:15px;">${text}</div>`;
}

// ═══════════════════════════════════════════════
// MAİL KOPYALA
// ═══════════════════════════════════════════════
window.copyMail = async function() {
  const tpl = document.getElementById("email-template");
  if (!tpl) return;

  try {
    const blob = new Blob([tpl.innerHTML], { type: "text/html" });
    await navigator.clipboard.write([new ClipboardItem({ "text/html": blob })]);
    showToast("Mail şablonu kopyalandı! Outlook/Gmail'e yapıştırabilirsiniz. ✅", "success");
  } catch {
    try {
      const range = document.createRange();
      range.selectNode(tpl);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand("copy");
      window.getSelection().removeAllRanges();
      showToast("Mail şablonu kopyalandı! ✅", "success");
    } catch {
      showToast("Kopyalama başarısız. Manuel seçip Ctrl+C yapabilirsiniz.", "warning");
    }
  }

  const btn = document.getElementById("copyMailBtn");
  if (btn) { btn.textContent = "✅ Kopyalandı!"; setTimeout(() => { btn.textContent = "📋 Mail İçin Kopyala"; }, 2000); }
};

// ═══════════════════════════════════════════════
// Gönderilecek mail için tam HTML doküman sarmalayıcı
// (koyu mod meta etiketleri <head> gerektirir — ekran
// önizlemesindeki fragment'ı DEĞİL, sadece gönderim
// anındaki htmlBody'yi sarmalar)
// ═══════════════════════════════════════════════
function wrapEmailDocument(fragmentHtml, titleText) {
  return `<!DOCTYPE html>
<html lang="tr" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(titleText)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
${fragmentHtml}
</body>
</html>`;
}

// ═══════════════════════════════════════════════
// MAİL GÖNDER (gerçek SMTP — bkz. send_report_mail.php)
// ═══════════════════════════════════════════════
window.sendReportMail = async function() {
  const tpl = document.getElementById("email-template");
  const statusEl = document.getElementById("sendMailStatus");
  if (!tpl) return;

  if (!settings.mailRecipients.length) {
    showToast("Önce Ayarlar sekmesinden mail dağıtım listesi tanımlayın.", "warning");
    switchTab("settings");
    return;
  }

  const btn = document.getElementById("sendMailBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Gönderiliyor…"; }
  if (statusEl) statusEl.style.display = "none";

  const tarihStr = state.tarih ? formatTrDate(state.tarih) : "—";
  const subject = `İSG Günlük Saha Raporu — ${tarihStr}${settings.companyName ? " — " + settings.companyName : ""}`;

  try {
    const res = await fetch("../send_report_mail.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: settings.mailRecipients,
        subject,
        htmlBody: wrapEmailDocument(tpl.innerHTML, subject)
      })
    });
    const data = await res.json();
    if (data.status === "success") {
      showToast(`Mail gönderildi ✅ (${settings.mailRecipients.length} alıcı)`, "success");
      if (statusEl) {
        statusEl.style.display = "block";
        statusEl.innerHTML = `<div class="alert alert-success"><span class="alert-icon">✅</span> Mail şu adreslere gönderildi: ${esc(settings.mailRecipients.join(", "))}</div>`;
      }
    } else {
      throw new Error(data.message || "Bilinmeyen hata");
    }
  } catch (err) {
    showToast("Mail gönderilemedi: " + err.message, "error");
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.innerHTML = `<div class="alert alert-danger"><span class="alert-icon">❌</span> Mail gönderilemedi: ${esc(err.message)}</div>`;
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "📧 Mail Gönder"; }
  }
};

// ═══════════════════════════════════════════════
// FİRESTORE CRUD
// ═══════════════════════════════════════════════
window.saveReport = async function() {
  syncGeneralInfo();
  if (!state.tarih || !state.hazirlayan) {
    showToast("Tarih ve Hazırlayan alanları zorunludur.", "error"); return;
  }

  const btn = document.getElementById("saveReportBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Kaydediliyor…"; }

  try {
    const stripItem = ({ id, ...r }) => r;
    const data = {
      userId:         currentUser.uid,
      tarih:          state.tarih,
      hazirlayan:     state.hazirlayan,
      kazalar:        state.kazalar.map(stripItem),
      ramakKala:      state.ramakKala.map(stripItem),
      maddiHasar:     state.maddiHasar.map(stripItem),
      uygunsuzluklar: state.uygunsuzluklar.map(stripItem),
      faaliyetler:    state.faaliyetler.map(({ id, ...r }) => r),
      denetimler:     state.denetimler.map(({ id, ...r }) => r),
      sahaCalismalar: state.sahaCalismalar.map(({ id, ...r }) => r),
      isIzinleri:     state.isIzinleri.map(stripItem),
      ekNotlar:       state.ekNotlar,
      updatedAt:      serverTimestamp()
    };

    if (editingId) {
      await updateDoc(doc(db, COL, editingId), data);
      showToast("Rapor güncellendi ✅", "success");
    } else {
      data.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, COL), data);
      editingId = ref.id;
      showToast("Rapor kaydedildi ✅", "success");
    }
    await loadReports(true); // cache'i atla, taze veri çek
    showEditingBanner();
  } catch (err) {
    showToast("Kayıt hatası: " + err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "💾 Kaydet"; }
  }
};

window.editReport = function(id) {
  const r = allReports.find(r => r.id === id);
  if (!r) return;
  editingId = id;

  Object.assign(state, {
    tarih:          r.tarih          || "",
    hazirlayan:     r.hazirlayan     || "",
    ekNotlar:       r.ekNotlar       || "",
    kazalar:        (r.kazalar        || []).map(x => ({ ...x, id: crypto.randomUUID() })),
    ramakKala:      (r.ramakKala      || []).map(x => ({ ...x, id: crypto.randomUUID() })),
    maddiHasar:     (r.maddiHasar     || []).map(x => ({ ...x, id: crypto.randomUUID() })),
    uygunsuzluklar: (r.uygunsuzluklar || []).map(x => {
      const images = Array.isArray(x.images) ? x.images : (x.image ? [x.image] : []);
      const { image: _img, images: _imgs, ...rest } = x;
      return { ...rest, id: crypto.randomUUID(), images };
    }),
    faaliyetler:    (r.faaliyetler    || []).map(x => ({ ...x, id: crypto.randomUUID() })),
    denetimler:     (r.denetimler     || []).map(x => ({ ...x, id: crypto.randomUUID() })),
    sahaCalismalar: (r.sahaCalismalar || []).map(x => ({ ...x, id: crypto.randomUUID() })),
    isIzinleri:     (r.isIzinleri     || []).map(x => ({ ...x, id: crypto.randomUUID() })),
  });

  const d = document.getElementById("input-date");
  const p = document.getElementById("input-preparer");
  const n = document.getElementById("input-ekNotlar");
  if (d) d.value = state.tarih;
  if (p) p.value = state.hazirlayan;
  if (n) n.value = state.ekNotlar;

  ["kazalar","ramakKala","maddiHasar","uygunsuzluklar","faaliyetler","denetimler","sahaCalismalar","isIzinleri"]
    .forEach(k => renderList(k));

  showEditingBanner();
  switchTab("form");
};

window.deleteReport = async function(id) {
  if (!confirm("Bu raporu kalıcı olarak silmek istediğinize emin misiniz? (İçindeki görseller de kalıcı olarak silinecektir)")) return;
  
  try {
    // 1. Silinecek raporu bul ve içindeki tüm görsel URL'lerini topla
    const r = allReports.find(r => r.id === id);
    const urlsToDelete = [];
    
    if (r) {
      ["kazalar", "ramakKala", "maddiHasar", "isIzinleri"].forEach(list => {
        if (r[list]) {
          r[list].forEach(item => { if (item.image) urlsToDelete.push(item.image); });
        }
      });
      if (r.uygunsuzluklar) {
        r.uygunsuzluklar.forEach(item => { 
          if (item.images && Array.isArray(item.images)) {
            urlsToDelete.push(...item.images); 
          }
        });
      }
    }

    // 2. Raporu Firestore'dan sil ve arayüzü güncelle
    await deleteDoc(doc(db, COL, id));
    if (editingId === id) resetForm();
    await loadReports(true); // cache'i atla, taze veri çek
    showToast("Rapor başarıyla silindi.", "success");

    // 3. Toplanan görselleri arka planda Storage'dan temizle
    urlsToDelete.forEach(async (url) => {
      if (url && url.includes("firebasestorage")) {
        try { 
          const fileRef = storageRef(_rpStorage, url);
          await deleteObject(fileRef); 
        } catch (e) {
          console.warn("Storage toplu silme hatası:", e);
        }
      }
    });

  } catch (err) {
    showToast("Silinemedi: " + err.message, "error");
  }
};

// ─── Cache yardımcıları ───
function persistCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      ts:   Date.now(),
      uid:  currentUser.uid,
      data: allReports
    }));
  } catch (e) { /* localStorage dolu olabilir */ }
}

function invalidateCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
}

// ─── loadReports: önce cache, yoksa Firestore ───
window.loadReports = async function(forceRefresh = false) {
  // Cache kontrolü (zorunlu yenileme talep edilmemişse)
  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const { ts, uid, data } = JSON.parse(raw);
        if (uid === currentUser.uid && Date.now() - ts < CACHE_TTL) {
          allReports = data;
          updateStats();
          if (currentTab === "archive") renderArchive();
          return; // Firestore'a istek atma
        }
      }
    } catch (e) { /* bozuk cache — Firestore'a geç */ }
  }

  // Firestore'dan taze veri çek
  try {
    const q = query(
      collection(db, COL),
      where("userId", "==", currentUser.uid)
    );
    const snap = await getDocs(q);
    allReports = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.tarih || "").localeCompare(a.tarih || ""));
    persistCache(); // taze veriyi cache'e yaz
    updateStats();
    if (currentTab === "archive") renderArchive();
  } catch (err) {
    showToast("Raporlar yüklenemedi: " + err.message, "error");
  }
};

function updateStats() {
  const ayStr = new Date().toISOString().slice(0,7);
  let totalKaza = 0, totalUyg = 0, buAy = 0;
  allReports.forEach(r => {
    totalKaza += (r.kazalar?.length || 0);
    totalUyg  += (r.uygunsuzluklar?.length || 0);
    if ((r.tarih || "").startsWith(ayStr)) buAy++;
  });
  document.getElementById("statTotal").textContent = allReports.length;
  document.getElementById("statKaza").textContent  = totalKaza;
  document.getElementById("statUyg").textContent   = totalUyg;
  document.getElementById("statBuAy").textContent  = buAy;
}

// ═══════════════════════════════════════════════
// ARŞİV
// ═══════════════════════════════════════════════
function renderArchive() {
  const container = document.getElementById("archive-list");
  if (!container) return;
  const search = document.getElementById("archSearch")?.value.toLowerCase() || "";

  const filtered = allReports.filter(r =>
    !search ||
    r.hazirlayan?.toLowerCase().includes(search) ||
    r.tarih?.includes(search)
  );

  if (!filtered.length) {
    container.innerHTML = `<div style="text-align:center;padding:var(--space-12);color:var(--text-muted);">
      <div style="font-size:2.5rem;margin-bottom:var(--space-3);">📂</div>
      <p>${search ? "Aramanızla eşleşen rapor bulunamadı." : "Henüz rapor kaydedilmedi."}</p>
    </div>`;
    return;
  }

  container.innerHTML = filtered.map(r => {
    const date  = formatTrDate(r.tarih);
    const kaza  = r.kazalar?.length || 0;
    const uyg   = r.uygunsuzluklar?.length || 0;
    const izin  = r.isIzinleri?.length || 0;
    const editing = editingId === r.id;
    return `
      <div class="archive-item" style="${editing ? 'border-color:var(--accent-primary);' : ''}">
        <div>
          <div style="font-weight:var(--font-bold);font-size:var(--text-base);">${date}</div>
          <div style="font-size:var(--text-sm);color:var(--text-muted);">${r.hazirlayan || "—"}</div>
          <div style="display:flex;gap:var(--space-3);margin-top:var(--space-2);flex-wrap:wrap;">
            ${kaza  ? `<span class="badge badge-danger">${kaza} Kaza</span>` : ""}
            ${uyg   ? `<span class="badge badge-warning">${uyg} Uygunsuzluk</span>` : ""}
            ${izin  ? `<span class="badge badge-muted">${izin} İzin</span>` : ""}
            ${!kaza && !uyg ? `<span class="badge badge-success">Temiz</span>` : ""}
          </div>
        </div>
        <div style="display:flex;gap:var(--space-2);">
          <button class="btn btn-ghost btn-sm" onclick="editReport('${r.id}')">✏️ Düzenle</button>
          <button class="btn btn-ghost btn-sm" onclick="previewReport('${r.id}')">📧 Mail</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);" onclick="deleteReport('${r.id}')">🗑️</button>
        </div>
      </div>`;
  }).join("");
}

window.previewReport = function(id) {
  const r = allReports.find(r => r.id === id);
  if (!r) return;
  Object.assign(state, {
    tarih: r.tarih || "", hazirlayan: r.hazirlayan || "", ekNotlar: r.ekNotlar || "",
    kazalar: r.kazalar || [], ramakKala: r.ramakKala || [], maddiHasar: r.maddiHasar || [],
    uygunsuzluklar: r.uygunsuzluklar || [], faaliyetler: r.faaliyetler || [],
    denetimler: r.denetimler || [], sahaCalismalar: r.sahaCalismalar || [],
    isIzinleri: r.isIzinleri || [],
  });
  switchTab("preview");
};

// ═══════════════════════════════════════════════
// FORM SIFIRLAMA / BANNER
// ═══════════════════════════════════════════════
function resetForm() {
  editingId = null;
  Object.assign(state, {
    tarih: todayStr(), hazirlayan: "", ekNotlar: "",
    kazalar: [], ramakKala: [], maddiHasar: [],
    uygunsuzluklar: [], faaliyetler: [], denetimler: [],
    sahaCalismalar: [], isIzinleri: []
  });
  const d = document.getElementById("input-date");
  const p = document.getElementById("input-preparer");
  const n = document.getElementById("input-ekNotlar");
  if (d) d.value = state.tarih;
  if (p) p.value = "";
  if (n) n.value = "";
  ["kazalar","ramakKala","maddiHasar","uygunsuzluklar","faaliyetler","denetimler","sahaCalismalar","isIzinleri"]
    .forEach(k => renderList(k));
  const banner = document.getElementById("editingBanner");
  if (banner) banner.style.display = "none";
}

window.cancelEdit = function() { resetForm(); switchTab("form"); };

function showEditingBanner() {
  const banner = document.getElementById("editingBanner");
  const txt    = document.getElementById("editingBannerText");
  if (banner) banner.style.display = "flex";
  if (txt && state.tarih) txt.textContent = `${formatTrDate(state.tarih)} tarihli rapor düzenleniyor.`;
}

// ═══════════════════════════════════════════════
// SKELETON LOADER — arşiv listesi için
// ═══════════════════════════════════════════════
function showSkeletonArchive() {
  const container = document.getElementById("archive-list");
  if (!container) return;
  const row = (w1, w2) => `
    <div class="archive-item sk-row" style="pointer-events:none;">
      <div style="display:flex;flex-direction:column;gap:8px;">
        <span class="sk-cell" style="width:${w1}px;"></span>
        <span class="sk-cell" style="width:${w2}px;"></span>
        <div style="display:flex;gap:8px;margin-top:4px;">
          <span class="sk-cell" style="width:60px;border-radius:99px;"></span>
          <span class="sk-cell" style="width:80px;border-radius:99px;"></span>
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <span class="sk-cell" style="width:70px;height:28px;border-radius:6px;"></span>
        <span class="sk-cell" style="width:55px;height:28px;border-radius:6px;"></span>
        <span class="sk-cell" style="width:32px;height:28px;border-radius:6px;"></span>
      </div>
    </div>`;
  container.innerHTML = row(120, 90) + row(150, 100) + row(110, 80) + row(140, 95);
}

// ═══════════════════════════════════════════════
// YARDIMCILAR
// ═══════════════════════════════════════════════
function todayStr() { return new Date().toISOString().split("T")[0]; }

function formatTrDate(str) {
  if (!str) return "—";
  const [y, m, d] = str.split("-");
  return `${d}/${m}/${y}`;
}

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
