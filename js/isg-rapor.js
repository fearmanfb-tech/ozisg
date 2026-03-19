/**
 * isg-rapor.js — Günlük İSG Saha Raporu
 * Tabs: Rapor Formu | Mail Önizleme | Arşiv
 */

import { requireToolAccess, db, showToast } from "./app.js";
import {
  collection, query, where, orderBy,
  getDocs, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const COL = "tool_isg_reports";

let currentUser = null;
let currentTab  = "form";
let editingId   = null;
let allReports  = [];

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
  await loadReports();
})();

function setupListeners() {
  document.getElementById("saveReportBtn")?.addEventListener("click", saveReport);
  document.getElementById("newReportBtn")?.addEventListener("click", () => { resetForm(); switchTab("form"); });
  document.getElementById("copyMailBtn")?.addEventListener("click", copyMail);
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
  if (tab === "preview") renderPreview();
  if (tab === "archive") renderArchive();
};

// ═══════════════════════════════════════════════
// DİNAMİK LİSTE YÖNETİMİ
// ═══════════════════════════════════════════════
const DEFAULTS = {
  kazalar:        { details: "", lostDays: 0, image: null },
  ramakKala:      { details: "", image: null },
  maddiHasar:     { details: "", image: null },
  uygunsuzluklar: { details: "", image: null },
  faaliyetler:    { type: "Toplantı", customType: "", details: "" },
  denetimler:     { block: "", details: "" },
  sahaCalismalar: { details: "" },
  isIzinleri:     { type: "Sıcak İş", company: "", area: "", work: "", companion: "", responsible: "", image: null }
};

// ─── Görsel sıkıştırma (Canvas API) ───
async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const MAX = 800;
        let { width: w, height: h } = img;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else       { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

window.uploadImage = function(listName, id) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const compressed = await compressImage(file);
      const item = state[listName].find(i => i.id === id);
      if (item) { item.image = compressed; renderList(listName); }
    } catch { showToast("Görsel yüklenemedi.", "error"); }
  };
  input.click();
};

window.removeImage = function(listName, id) {
  const item = state[listName].find(i => i.id === id);
  if (item) { item.image = null; renderList(listName); }
};

window.addItem = function(listName) {
  const item = { id: Date.now(), ...DEFAULTS[listName] };
  state[listName].push(item);
  renderList(listName);
};

window.removeItem = function(listName, id) {
  state[listName] = state[listName].filter(i => i.id !== id);
  renderList(listName);
};

window.updateField = function(listName, id, field, value) {
  const item = state[listName].find(i => i.id === id);
  if (item) {
    item[field] = value;
    // Faaliyet türü "Diğer" seçilince customType alanını göster
    if (field === "type" && listName === "faaliyetler") {
      const ct = document.getElementById(`ct_${id}`);
      if (ct) ct.style.display = value === "Diğer" ? "flex" : "none";
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
      <button class="li-img-remove" onclick="removeImage('${listName}',${item.id})" title="Görseli kaldır">✕ Görseli kaldır</button>
    </div>`;
  }
  return `<div class="li-img-row">
    <button class="li-img-btn" onclick="uploadImage('${listName}',${item.id})">📷 Görsel Ekle</button>
  </div>`;
}

function renderItem(listName, item, idx) {
  const rm = `onclick="removeItem('${listName}',${item.id})"`;

  if (listName === "kazalar") return `
    <div class="list-item">
      <div class="list-item-fields">
        <div class="li-row">
          <input class="li-input" placeholder="Kaza detayı (nerede, nasıl oldu?)"
            value="${esc(item.details)}" oninput="updateField('kazalar',${item.id},'details',this.value)" />
          <input class="li-input w80" type="number" min="0" placeholder="Kayıp gün"
            value="${item.lostDays}" oninput="updateField('kazalar',${item.id},'lostDays',+this.value)" />
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
          value="${esc(item.details)}" oninput="updateField('${listName}',${item.id},'details',this.value)" />
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
          value="${esc(item.details)}" oninput="updateField('uygunsuzluklar',${item.id},'details',this.value)" />
        ${imgRow("uygunsuzluklar", item)}
      </div>
      <button class="li-remove" ${rm} title="Sil">✕</button>
    </div>`;

  if (listName === "faaliyetler") return `
    <div class="list-item">
      <div class="list-item-fields">
        <div class="li-row">
          <select class="li-input w140" onchange="updateField('faaliyetler',${item.id},'type',this.value)">
            ${["Toplantı","Gemba Yürüyüşü","Eğitim","Tatbikat","Diğer"].map(t =>
              `<option value="${t}" ${item.type===t?"selected":""}>${t}</option>`).join("")}
          </select>
          <input class="li-input" placeholder="Faaliyet detayı…"
            value="${esc(item.details)}" oninput="updateField('faaliyetler',${item.id},'details',this.value)" />
        </div>
        <div class="li-row" id="ct_${item.id}" style="display:${item.type==='Diğer'?'flex':'none'};">
          <input class="li-input" placeholder="Faaliyet adını yazın…"
            value="${esc(item.customType)}" oninput="updateField('faaliyetler',${item.id},'customType',this.value)" />
        </div>
      </div>
      <button class="li-remove" ${rm} title="Sil">✕</button>
    </div>`;

  if (listName === "denetimler") return `
    <div class="list-item">
      <div class="list-item-fields">
        <div class="li-row">
          <input class="li-input w140" placeholder="Blok/Alan (A Blok…)"
            value="${esc(item.block)}" oninput="updateField('denetimler',${item.id},'block',this.value)" />
          <input class="li-input" placeholder="Yapılan denetim…"
            value="${esc(item.details)}" oninput="updateField('denetimler',${item.id},'details',this.value)" />
        </div>
      </div>
      <button class="li-remove" ${rm} title="Sil">✕</button>
    </div>`;

  if (listName === "isIzinleri") return `
    <div class="list-item">
      <div class="list-item-fields">
        <div class="li-row">
          <select class="li-input w140" onchange="updateField('isIzinleri',${item.id},'type',this.value)">
            ${["Sıcak İş","Yüksekte Çalışma","Kapalı Alan","Kazı İşi","Elektrik Çalışması","Tehlikeli Kapsam Dışı"].map(t =>
              `<option value="${t}" ${item.type===t?"selected":""}>${t}</option>`).join("")}
          </select>
          <input class="li-input" placeholder="Firma adı"
            value="${esc(item.company)}" oninput="updateField('isIzinleri',${item.id},'company',this.value)" />
        </div>
        <div class="li-row">
          <input class="li-input" placeholder="Bölge (B Blok Çatı…)"
            value="${esc(item.area)}" oninput="updateField('isIzinleri',${item.id},'area',this.value)" />
          <input class="li-input" placeholder="Yapılan iş (kaynak, montaj…)"
            value="${esc(item.work)}" oninput="updateField('isIzinleri',${item.id},'work',this.value)" />
        </div>
        <div class="li-row">
          <input class="li-input" placeholder="Refakat eden görevli"
            value="${esc(item.companion)}" oninput="updateField('isIzinleri',${item.id},'companion',this.value)" />
          <input class="li-input" placeholder="Sorumlu kişi"
            value="${esc(item.responsible)}" oninput="updateField('isIzinleri',${item.id},'responsible',this.value)" />
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
    ? `<div style="background:#fef2f2;border-left:4px solid #ef4444;padding:12px 16px;margin:16px 0;border-radius:4px;">
        <strong style="color:#dc2626;">🚨 DİKKAT:</strong>
        <span style="color:#7f1d1d;"> Bu rapor döneminde olay/kaza kaydı bulunmaktadır.</span>
       </div>`
    : `<div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:12px 16px;margin:16px 0;border-radius:4px;">
        <strong style="color:#16a34a;">✅ OLAY YOK:</strong>
        <span style="color:#166534;"> Bu rapor döneminde herhangi bir kaza veya ramak kala olayı yaşanmamıştır.</span>
       </div>`;

  const uygBox = hasUyg
    ? `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 16px;margin:16px 0;border-radius:4px;">
        <strong style="color:#d97706;">⚠️ UYGUNSUZLUK:</strong>
        <span style="color:#78350f;"> ${s.uygunsuzluklar.length} adet uygunsuzluk tespit edilmiştir.</span>
       </div>`
    : `<div style="background:#eff6ff;border-left:4px solid #3b82f6;padding:12px 16px;margin:16px 0;border-radius:4px;">
        <strong style="color:#2563eb;">ℹ️ UYGUNSUZLUK YOK:</strong>
        <span style="color:#1e3a8a;"> Bu rapor döneminde uygunsuzluk tespit edilmemiştir.</span>
       </div>`;

  // Kazalar tablosu
  const kazalarHtml = s.kazalar.length
    ? `<table width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin-top:8px;">
        <thead><tr style="background:#fee2e2;">
          <th style="border:1px solid #fca5a5;text-align:left;padding:8px;">Detay</th>
          <th style="border:1px solid #fca5a5;text-align:center;padding:8px;width:100px;">Kayıp Gün</th>
          <th style="border:1px solid #fca5a5;text-align:center;padding:8px;width:110px;">Görsel</th>
        </tr></thead>
        <tbody>${s.kazalar.map(k => `
          <tr><td style="border:1px solid #fecaca;padding:8px;">${esc(k.details)||"—"}</td>
              <td style="border:1px solid #fecaca;padding:8px;text-align:center;">${k.lostDays||0}</td>
              <td style="border:1px solid #fecaca;padding:8px;text-align:center;">${k.image ? `<img src="${k.image}" style="max-width:100px;max-height:80px;border-radius:4px;" />` : "—"}</td></tr>`).join("")}
        </tbody></table>`
    : `<p style="color:#6b7280;font-style:italic;margin:4px 0;">Bugün kaza kaydı girilmedi.</p>`;

  const ramakHtml = s.ramakKala.length
    ? `<ul style="margin:4px 0;padding-left:20px;">${s.ramakKala.map(r => `<li>${esc(r.details)}${r.image ? `<br><img src="${r.image}" style="max-width:120px;max-height:90px;border-radius:4px;margin-top:4px;" />` : ""}</li>`).join("")}</ul>`
    : `<p style="color:#6b7280;font-style:italic;margin:4px 0;">Ramak kala olayı girilmedi.</p>`;

  const maddiHtml = s.maddiHasar.length
    ? `<ul style="margin:4px 0;padding-left:20px;">${s.maddiHasar.map(r => `<li>${esc(r.details)}${r.image ? `<br><img src="${r.image}" style="max-width:120px;max-height:90px;border-radius:4px;margin-top:4px;" />` : ""}</li>`).join("")}</ul>`
    : `<p style="color:#6b7280;font-style:italic;margin:4px 0;">Maddi hasarlı olay girilmedi.</p>`;

  // Uygunsuzluklar
  const uygHtml = s.uygunsuzluklar.length
    ? `<ol style="margin:4px 0;padding-left:20px;">${s.uygunsuzluklar.map(u => `<li>${esc(u.details)}${u.image ? `<br><img src="${u.image}" style="max-width:120px;max-height:90px;border-radius:4px;margin-top:4px;" />` : ""}</li>`).join("")}</ol>`
    : `<p style="color:#6b7280;font-style:italic;margin:4px 0;">Uygunsuzluk girilmedi.</p>`;

  // Faaliyetler
  const faalHtml = s.faaliyetler.length
    ? `<ul style="margin:4px 0;padding-left:20px;">${s.faaliyetler.map(f => {
        const tip = f.type === "Diğer" ? esc(f.customType) : f.type;
        return `<li><strong>${tip}:</strong> ${esc(f.details)}</li>`;
      }).join("")}</ul>`
    : `<p style="color:#6b7280;font-style:italic;margin:4px 0;">Faaliyet girilmedi.</p>`;

  // Denetimler
  const denHtml = s.denetimler.length
    ? `<ul style="margin:4px 0;padding-left:20px;">${s.denetimler.map(d => `<li><strong>${esc(d.block)}:</strong> ${esc(d.details)}</li>`).join("")}</ul>`
    : `<p style="color:#6b7280;font-style:italic;margin:4px 0;">Denetim girilmedi.</p>`;

  // Saha çalışmaları
  const sahaHtml = s.sahaCalismalar.length
    ? `<ul style="margin:4px 0;padding-left:20px;">${s.sahaCalismalar.map(sc => `<li>${esc(sc.details)}</li>`).join("")}</ul>`
    : `<p style="color:#6b7280;font-style:italic;margin:4px 0;">Saha çalışması girilmedi.</p>`;

  // İş izinleri tablosu
  const izinHtml = s.isIzinleri.length
    ? `<table width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin-top:8px;font-size:13px;">
        <thead><tr style="background:#e0e7ff;">
          ${["İzin Tipi","Firma","Bölge","Yapılan İş","Refakatçi","Sorumlu","Görsel"].map(h =>
            `<th style="border:1px solid #c7d2fe;padding:7px;text-align:left;">${h}</th>`).join("")}
        </tr></thead>
        <tbody>${s.isIzinleri.map(iz => `
          <tr>${[iz.type,iz.company,iz.area,iz.work,iz.companion,iz.responsible].map(v =>
            `<td style="border:1px solid #e0e7ff;padding:7px;">${esc(v)||"—"}</td>`).join("")}
            <td style="border:1px solid #e0e7ff;padding:7px;text-align:center;">${iz.image ? `<img src="${iz.image}" style="max-width:100px;max-height:80px;border-radius:4px;" />` : "—"}</td></tr>`
          ).join("")}
        </tbody></table>`
    : `<p style="color:#6b7280;font-style:italic;margin:4px 0;">İş izni girilmedi.</p>`;

  const ekNotHtml = s.ekNotlar
    ? `<div style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
        ${sectionTitle("💡 Ek Notlar")}
        <p style="white-space:pre-wrap;color:#374151;">${esc(s.ekNotlar)}</p>
       </div>`
    : "";

  tpl.innerHTML = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;color:#1e293b;max-width:800px;">
      <!-- Header -->
      <div style="background:#1e3a8a;padding:20px 24px;border-bottom:4px solid #f97316;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:.5px;">🛡️ İSG GÜNLÜK SAHA RAPORU</div>
            <div style="font-size:13px;color:#bfdbfe;margin-top:4px;">Bulut entegrasyonlu günlük raporlama</div>
          </div>
        </div>
      </div>
      <!-- Tarih / Hazırlayan -->
      <div style="background:#f1f5f9;padding:12px 24px;display:flex;gap:32px;flex-wrap:wrap;border-bottom:1px solid #e2e8f0;">
        <div><span style="font-size:12px;color:#64748b;text-transform:uppercase;">Tarih</span><div style="font-weight:700;color:#1e293b;">${tarihStr}</div></div>
        <div><span style="font-size:12px;color:#64748b;text-transform:uppercase;">Hazırlayan</span><div style="font-weight:700;color:#1e293b;">${hazirlayan}</div></div>
      </div>
      <!-- Alert boxes -->
      <div style="padding:0 24px;">${incidentBox}${uygBox}</div>

      <!-- S1: Kazalar -->
      <div style="padding:16px 24px;border-top:1px solid #e2e8f0;">
        ${sectionTitle("🚨 1. Kazalar, Ramak Kala ve Maddi Hasarlı Olaylar")}
        <div style="margin-bottom:12px;"><strong style="color:#374151;">Yaşanan Kazalar:</strong>${kazalarHtml}</div>
        <div style="margin-bottom:12px;"><strong style="color:#374151;">Ramak Kala:</strong>${ramakHtml}</div>
        <div><strong style="color:#374151;">Maddi Hasarlı:</strong>${maddiHtml}</div>
      </div>

      <!-- S2: Uygunsuzluklar -->
      <div style="padding:16px 24px;border-top:1px solid #e2e8f0;background:#fafafa;">
        ${sectionTitle("🔍 2. Saha Gözlemleri ve Uygunsuzluklar")}
        ${uygHtml}
      </div>

      <!-- S3: Faaliyetler & Denetimler -->
      <div style="padding:16px 24px;border-top:1px solid #e2e8f0;">
        ${sectionTitle("📋 3. İSG Planları, Faaliyetleri ve Denetimler")}
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td width="50%" style="padding-right:12px;vertical-align:top;">
              <strong style="color:#374151;">İSG Faaliyetleri:</strong>${faalHtml}
            </td>
            <td width="50%" style="padding-left:12px;vertical-align:top;border-left:1px solid #e2e8f0;">
              <strong style="color:#374151;">Denetimler:</strong>${denHtml}
            </td>
          </tr>
        </table>
      </div>

      <!-- S4: Saha Çalışmaları -->
      <div style="padding:16px 24px;border-top:1px solid #e2e8f0;background:#fafafa;">
        ${sectionTitle("🛠️ 4. İSG Kapsamında Yapılan Saha Çalışmaları")}
        ${sahaHtml}
      </div>

      <!-- S5: İş İzinleri -->
      <div style="padding:16px 24px;border-top:1px solid #e2e8f0;">
        ${sectionTitle("🔐 5. Verilen İş İzinleri")}
        ${izinHtml}
      </div>

      ${ekNotHtml}

      <!-- Footer -->
      <div style="background:#1e3a8a;padding:12px 24px;text-align:center;">
        <span style="color:#bfdbfe;font-size:12px;">Bu rapor ozisg.com İSG Rapor Aracı ile oluşturulmuştur.</span>
      </div>
    </div>`;
}

function sectionTitle(text) {
  return `<div style="font-size:14px;font-weight:700;color:#fff;background:#1e3a8a;padding:8px 12px;border-left:4px solid #f97316;border-radius:4px;margin-bottom:10px;">${text}</div>`;
}

// ═══════════════════════════════════════════════
// MAİL KOPYALA
// ═══════════════════════════════════════════════
window.copyMail = async function() {
  const tpl = document.getElementById("email-template");
  if (!tpl) return;

  try {
    // ClipboardItem ile HTML kopyalama
    const blob = new Blob([tpl.innerHTML], { type: "text/html" });
    await navigator.clipboard.write([new ClipboardItem({ "text/html": blob })]);
    showToast("Mail şablonu kopyalandı! Outlook/Gmail'e yapıştırabilirsiniz. ✅", "success");
  } catch {
    // Fallback: selection + execCommand
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
    // Strip in-memory fields (id, image) — images not persisted to Firestore
    const stripItem = ({ id, image, ...r }) => r;
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
    await loadReports();
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

  // State'i doldur
  Object.assign(state, {
    tarih:          r.tarih          || "",
    hazirlayan:     r.hazirlayan     || "",
    ekNotlar:       r.ekNotlar       || "",
    kazalar:        (r.kazalar        || []).map((x,i) => ({ id: Date.now()+i, ...x })),
    ramakKala:      (r.ramakKala      || []).map((x,i) => ({ id: Date.now()+i+100, ...x })),
    maddiHasar:     (r.maddiHasar     || []).map((x,i) => ({ id: Date.now()+i+200, ...x })),
    uygunsuzluklar: (r.uygunsuzluklar || []).map((x,i) => ({ id: Date.now()+i+300, ...x })),
    faaliyetler:    (r.faaliyetler    || []).map((x,i) => ({ id: Date.now()+i+400, ...x })),
    denetimler:     (r.denetimler     || []).map((x,i) => ({ id: Date.now()+i+500, ...x })),
    sahaCalismalar: (r.sahaCalismalar || []).map((x,i) => ({ id: Date.now()+i+600, ...x })),
    isIzinleri:     (r.isIzinleri     || []).map((x,i) => ({ id: Date.now()+i+700, ...x })),
  });

  // Formu güncelle
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
  if (!confirm("Bu raporu kalıcı olarak silmek istediğinize emin misiniz?")) return;
  try {
    await deleteDoc(doc(db, COL, id));
    if (editingId === id) resetForm();
    await loadReports();
    showToast("Rapor silindi.", "success");
  } catch (err) {
    showToast("Silinemedi: " + err.message, "error");
  }
};

async function loadReports() {
  try {
    const q = query(
      collection(db, COL),
      where("userId", "==", currentUser.uid)
    );
    const snap = await getDocs(q);
    allReports = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.tarih || "").localeCompare(a.tarih || ""));
    updateStats();
    if (currentTab === "archive") renderArchive();
  } catch (err) {
    showToast("Raporlar yüklenemedi: " + err.message, "error");
  }
}

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
  // Geçici olarak state'e yükle, preview'a geç
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
