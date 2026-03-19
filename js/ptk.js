/**
 * ptk.js — Periyodik Teknik Kontrol
 * Mevcut PTK.txt mantığı + portal entegrasyonu + erişim kontrolü
 */

import { auth, db, showToast, requireToolAccess } from "./app.js";
import {
  collection, query, where, orderBy, limit,
  getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let currentUser = null;
let currentLocation = "Esenyurt LM Depo";
let auditList = [];
let bulkData  = [];
let cloudReports = [];

// ─── Temel ekipman veritabanı (PTK.txt'den alındı) ───
const BASE_ITEMS = [
  { cat:"Basınçlı Kaplar", name:"Hava Tankı / Kompresör",      period:12 },
  { cat:"Basınçlı Kaplar", name:"Hidrofor / Genleşme Tankı",   period:12 },
  { cat:"Basınçlı Kaplar", name:"Kalorifer Kazanı",            period:12 },
  { cat:"Basınçlı Kaplar", name:"Boyler",                      period:12 },
  { cat:"Yangın Tesisatı", name:"Yangın Pompası",              period:12 },
  { cat:"Yangın Tesisatı", name:"Yangın Dolapları ve Sprink",  period:12 },
  { cat:"Yangın Tesisatı", name:"Yangın Tüpleri",              period:12 },
  { cat:"Yangın Tesisatı", name:"Gazlı Söndürme (FM200)",      period:12 },
  { cat:"Yangın Tesisatı", name:"Yangın Algılama Sistemi",     period:12 },
  { cat:"Elektrik",        name:"Elektrik Tesisatı",           period:12 },
  { cat:"Elektrik",        name:"Topraklama Ölçümü",           period:12 },
  { cat:"Elektrik",        name:"Paratoner",                   period:12 },
  { cat:"İş Hijyeni",      name:"Aydınlatma Ölçümü",          period:12 },
  { cat:"İş Hijyeni",      name:"Gürültü Ölçümü",             period:12 },
  { cat:"İş Hijyeni",      name:"Termal Konfor",              period:12 },
  { cat:"İş Hijyeni",      name:"Toz Ölçümü",                 period:12 },
  { cat:"İş Hijyeni",      name:"VOC (Kimyasal) Ölçümü",      period:12 },
  { cat:"Havalandırma",    name:"Havalandırma Tesisatı",       period:12 },
  { cat:"Havalandırma",    name:"Klima Santrali",              period:12 },
];

const WAREHOUSE_EXTRAS = {
  "Esenyurt LM Depo": [
    { cat:"Kaldırma", name:"Forklift", period:3 },
    { cat:"Kaldırma", name:"Reach Truck", period:3 },
    { cat:"Kaldırma", name:"Akülü Transpalet", period:3 },
    { cat:"Kaldırma", name:"Manlift", period:3 },
    { cat:"Otomasyon", name:"ASRS ve Miniload Crane", period:12 },
    { cat:"Otomasyon", name:"Sorter Sistemleri", period:12 },
    { cat:"Otomasyon", name:"Robot (Ürün Kabul)", period:12 },
    { cat:"Otomasyon", name:"Paletizer", period:12 },
    { cat:"Otomasyon", name:"Konveyör Hatları", period:12 },
    { cat:"Kapı", name:"Giyotin Kapı", period:12 },
    { cat:"Kapı", name:"Seksiyonel Kapı", period:12 },
    { cat:"Kapı", name:"Yükleme Rampası", period:12 },
    { cat:"Diğer", name:"Temizlik Makineleri", period:12 },
    { cat:"Diğer", name:"Streç Makinesi", period:12 },
  ],
  "Poyraz Depo": [
    { cat:"Kaldırma", name:"Forklift", period:3 },
    { cat:"Kaldırma", name:"Reach Truck", period:3 },
    { cat:"Kaldırma", name:"Transpalet", period:3 },
    { cat:"Kapı", name:"Sarmal/Seksiyonel Kapı", period:12 },
    { cat:"Kapı", name:"Yükleme Rampası", period:12 },
    { cat:"Kapı", name:"Yanaşma Körüğü", period:12 },
    { cat:"Sistemler", name:"Konveyörler", period:12 },
    { cat:"El Aletleri", name:"Hilti / Matkap", period:12 },
  ],
  "Yalova Depo": [
    { cat:"Kaldırma", name:"Forklift", period:3 },
    { cat:"Kaldırma", name:"Caraskal (0.3 Ton)", period:3 },
    { cat:"Tekstil", name:"Ütü Kazanı", period:12 },
    { cat:"Tekstil", name:"Dikiş Makinesi", period:12 },
    { cat:"Tekstil", name:"Shrink Makinesi", period:12 },
    { cat:"Atölye", name:"Parke Kesim Makinesi", period:12 },
    { cat:"Atölye", name:"Şeritli Matkap", period:12 },
    { cat:"Kapı", name:"Otomatik Kepenk", period:12 },
  ],
  "Aksaray Depo": [
    { cat:"Kaldırma", name:"Forklift", period:3 },
    { cat:"Kaldırma", name:"Transpalet", period:3 },
    { cat:"Tekstil", name:"Ütü Kazanı", period:12 },
    { cat:"Sistemler", name:"Konveyörler", period:12 },
    { cat:"Sistemler", name:"Sorter", period:12 },
    { cat:"Kapı", name:"Sarmal Kapı", period:12 },
    { cat:"Kapı", name:"Rampa", period:12 },
  ],
  "Titiz Depo": [
    { cat:"Kaldırma", name:"Forklift", period:3 },
    { cat:"Kaldırma", name:"Reach Truck", period:3 },
    { cat:"Kaldırma", name:"Akülü Transpalet", period:3 },
    { cat:"Depolama", name:"Raf Sistemleri", period:12 },
  ],
  "Silivri Depo": [
    { cat:"Kaldırma", name:"Forklift", period:3 },
    { cat:"Kaldırma", name:"Transpalet", period:3 },
    { cat:"Kapı", name:"Rampa", period:12 },
    { cat:"Kapı", name:"Seksiyonel Kapı", period:12 },
  ],
  "Eroğlu Depo": [
    { cat:"Kaldırma", name:"Forklift", period:3 },
    { cat:"Depolama", name:"Raf Sistemleri", period:12 },
    { cat:"Kapı", name:"Rampa", period:12 },
  ],
  "Yılmaz Depo": [
    { cat:"Kaldırma", name:"Forklift", period:3 },
    { cat:"Kaldırma", name:"Caraskal", period:3 },
    { cat:"Tekstil", name:"Ütü", period:12 },
    { cat:"Atölye", name:"Şerit Testere", period:12 },
    { cat:"Atölye", name:"Hilti", period:12 },
  ],
};

function getMasterData(location) {
  const extras = WAREHOUSE_EXTRAS[location] || [];
  const custom = JSON.parse(localStorage.getItem("ptk_custom_" + location) || "[]");
  return [...BASE_ITEMS, ...extras, ...custom];
}

// ─── Başlatma ───
(async () => {
  currentUser = await requireToolAccess("tool_ptk");
  if (!currentUser) return;

  document.getElementById("reportDate").value = new Date().toISOString().split("T")[0];
  document.getElementById("bulkDate").value   = new Date().toISOString().split("T")[0];

  currentLocation = document.getElementById("locationSelect").value;
  document.getElementById("locationSelect").addEventListener("change", e => {
    currentLocation = e.target.value;
    auditList = [];
    renderAuditList();
    renderReference();
    if (document.getElementById("panel-planning").classList.contains("active")) renderPlanning();
    if (document.getElementById("panel-history").classList.contains("active")) renderHistory();
  });

  setupSearch();
  renderAuditList();
  renderMailPreview();
  renderReference();
  await loadCloudReports();
})();

async function loadCloudReports() {
  try {
    const q = query(
      collection(db, "tool_ptk_reports"),
      where("userId", "==", currentUser.uid),
      orderBy("date", "desc"),
      limit(200)
    );
    const snap = await getDocs(q);
    cloudReports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn("PTK raporları yüklenemedi:", err.message);
  }
}

// ─── Arama ───
function setupSearch() {
  const input    = document.getElementById("equipSearch");
  const dropdown = document.getElementById("searchDropdown");

  input.addEventListener("input", () => {
    const term = input.value.toLowerCase().trim();
    if (!term) { dropdown.style.display = "none"; return; }
    const master = getMasterData(currentLocation);
    const results = master.filter(i => i.name.toLowerCase().includes(term)).slice(0, 10);
    if (!results.length) { dropdown.style.display = "none"; return; }
    dropdown.style.display = "block";
    dropdown.innerHTML = results.map(i => `
      <div style="padding:10px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border-subtle);"
           onmouseover="this.style.background='var(--bg-surface-2)'"
           onmouseout="this.style.background=''"
           onclick="addEquipToAudit('${i.name.replace(/'/g,"\\'")}','${i.cat}',${i.period})">
        <span style="font-weight:var(--font-semibold);">${i.name}</span>
        <span style="font-size:var(--text-xs);color:var(--text-muted);">${i.cat} · ${i.period} Ay</span>
      </div>`).join("");
  });

  document.addEventListener("click", e => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) dropdown.style.display = "none";
  });
}

window.addEquipToAudit = function(name, cat, period) {
  auditList.unshift({ id: Date.now() + Math.random(), name, cat, period, status:"pass", note:"", assetId:"", isCritical:false });
  document.getElementById("equipSearch").value = "";
  document.getElementById("searchDropdown").style.display = "none";
  renderAuditList();
  renderMailPreview();
};

function renderAuditList() {
  const container = document.getElementById("audit-list");
  if (!auditList.length) {
    container.innerHTML = `<div style="text-align:center;padding:3rem;color:var(--text-muted);border:2px dashed var(--border-color);border-radius:var(--border-radius-md);">
      <div style="font-size:2.5rem;margin-bottom:1rem;">🔍</div>
      <p>Yukarıdan ekipman arayıp ekleyin.</p>
    </div>`;
    return;
  }
  container.innerHTML = auditList.map(item => `
    <div class="audit-item ${item.status === 'fail' ? (item.isCritical ? 'critical' : 'fail') : ''}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:0.75rem;">
        <div style="flex:1;">
          <div style="font-weight:var(--font-bold);font-size:var(--text-base);">${item.name}</div>
          <input type="text" value="${item.assetId}" placeholder="Sicil / Plaka No"
            style="margin-top:4px;font-size:var(--text-xs);border:none;border-bottom:1px dashed var(--border-color);background:transparent;color:var(--text-secondary);width:160px;outline:none;padding:2px 0;"
            oninput="updateAuditField(${item.id},'assetId',this.value)" />
        </div>
        <div class="status-toggle">
          <button class="status-btn pass ${item.status==='pass'?'active':''}" onclick="updateAuditField(${item.id},'status','pass')">✅ Uygun</button>
          <button class="status-btn fail ${item.status==='fail'?'active':''}" onclick="updateAuditField(${item.id},'status','fail')">❌ Uygunsuz</button>
        </div>
      </div>
      ${item.status === 'fail' ? `
        <div style="background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:0.75rem;margin-bottom:0.5rem;">
          <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">
            <textarea rows="3" class="form-control" placeholder="Uygunsuzluk detayını buraya yazın…"
              oninput="updateAuditField(${item.id},'note',this.value)"
              style="flex:1;font-size:var(--text-xs);">${item.note}</textarea>
            <button class="btn btn-ghost btn-sm" title="AI Öneri Al" onclick="getAISuggestion(${item.id})"
              style="flex-shrink:0;border:1px solid var(--accent-info);color:var(--accent-info);">✨</button>
          </div>
          <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-size:var(--text-xs);font-weight:var(--font-semibold);color:#7c3aed;">
            <input type="checkbox" ${item.isCritical?'checked':''} onchange="updateAuditField(${item.id},'isCritical',this.checked)"
              style="width:16px;height:16px;accent-color:#7c3aed;" />
            KRİTİK RİSK — Kullanım Dışı Bırak
          </label>
        </div>` : ""}
      <button onclick="removeFromAudit(${item.id})"
        style="width:100%;font-size:var(--text-xs);color:var(--text-muted);background:none;border:none;border-top:1px dashed var(--border-subtle);padding-top:0.5rem;margin-top:0.25rem;cursor:pointer;">
        🗑️ Listeden Çıkar
      </button>
    </div>`).join("");
}

window.updateAuditField = function(id, field, value) {
  const item = auditList.find(i => i.id === id);
  if (item) { item[field] = value; renderAuditList(); renderMailPreview(); }
};
window.removeFromAudit = function(id) {
  auditList = auditList.filter(i => i.id !== id);
  renderAuditList(); renderMailPreview();
};

// ─── Mail Önizleme ───
function renderMailPreview() {
  const preview   = document.getElementById("mail-preview");
  const location  = currentLocation;
  const date      = document.getElementById("reportDate").value;
  const title     = document.getElementById("reportTitle")?.value || "Periyodik Kontrol";

  const summary = {};
  auditList.forEach(item => {
    const key = item.assetId ? `${item.name}-${item.assetId}` : item.name;
    if (!summary[key]) summary[key] = { name:item.name, assetId:item.assetId, pass:0, fail:0, notes:[] };
    if (item.status === "pass") summary[key].pass++;
    else { summary[key].fail++; if (item.note) summary[key].notes.push(item.note); }
  });

  const rows = Object.values(summary);
  if (!rows.length) {
    preview.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:3rem;">Denetim listesi boş.</div>`;
    return;
  }

  preview.innerHTML = `
    <div style="border-bottom:3px solid #f97316;padding-bottom:16px;margin-bottom:20px;">
      <h2 style="color:#1e3a8a;font-size:18px;font-weight:bold;margin:0;">${title}</h2>
      <p style="margin:4px 0 0;color:#64748b;font-size:12px;">${location} • ${date ? new Date(date).toLocaleDateString("tr-TR") : ""}</p>
    </div>
    <p style="margin-bottom:16px;">Sayın İlgili,<br/><br/><strong>${location}</strong> lokasyonunda gerçekleştirilen periyodik teknik kontroller tamamlanmıştır.</p>
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead><tr style="background:#f1f5f9;">
        <th style="border:1px solid #e2e8f0;padding:8px;text-align:left;">Ekipman</th>
        <th style="border:1px solid #e2e8f0;padding:8px;text-align:center;">Durum</th>
        <th style="border:1px solid #e2e8f0;padding:8px;text-align:left;">Tespit</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td style="border:1px solid #e2e8f0;padding:8px;font-weight:bold;">${r.name}${r.assetId ? `<br/><span style="font-size:10px;color:#64748b;">${r.assetId}</span>` : ""}</td>
            <td style="border:1px solid #e2e8f0;padding:8px;text-align:center;">${r.fail > 0 ? '<span style="color:#dc2626;font-weight:bold;">UYGUNSUZ</span>' : '<span style="color:#16a34a;font-weight:bold;">UYGUN</span>'}</td>
            <td style="border:1px solid #e2e8f0;padding:8px;color:#475569;">${r.notes.length ? r.notes.map(n=>`• ${n}`).join("<br/>") : '<span style="color:#cbd5e1;font-style:italic;">Sorun yok.</span>'}</td>
          </tr>`).join("")}
      </tbody>
    </table>
    <p style="font-size:10px;color:#94a3b8;margin-top:24px;text-align:center;border-top:1px solid #e2e8f0;padding-top:12px;">İş Sağlığı ve Güvenliği Birimi</p>`;
}

window.copyMailPreview = function() {
  const el = document.getElementById("mail-preview");
  const range = document.createRange();
  range.selectNode(el);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  document.execCommand("copy");
  window.getSelection().removeAllRanges();
  showToast("Mail önizleme kopyalandı! 📋", "success");
};

// ─── AI Öneri (Gemini) ───
const GEMINI_KEY = ""; // Varsa kendi API anahtarınızı buraya yazın

window.getAISuggestion = async function(id) {
  const item = auditList.find(i => i.id === id);
  if (!item?.note) { showToast("Önce uygunsuzluğu yazın.", "warning"); return; }
  if (!GEMINI_KEY) { showToast("AI önerisi için Gemini API anahtarı gereklidir.", "warning"); return; }

  showToast("AI öneri hazırlanıyor…", "info", 2000);
  try {
    const prompt = `Sen A Sınıfı İSG Uzmanısın. Ekipman: "${item.name}". Sorun: "${item.note}". Kısa teknik öneri ve yasal risk yaz. Türkçe.`;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }] })
    });
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      item.note += `\n\n🤖 AI Önerisi:\n${text}`;
      renderAuditList(); renderMailPreview();
      showToast("AI önerisi eklendi! ✨", "success");
    }
  } catch (e) { showToast("AI hatası: " + e.message, "error"); }
};

window.generateAISummary = async function() {
  const fails = auditList.filter(i => i.status === "fail").map(i => `- ${i.name}: ${i.note || "not yok"}`).join("\n");
  if (!fails) { showToast("Özet için en az bir uygunsuzluk gerekli.", "warning"); return; }
  if (!GEMINI_KEY) { showToast("AI önerisi için Gemini API anahtarı gereklidir.", "warning"); return; }
  showToast("Yönetici özeti hazırlanıyor…", "info", 2000);
  try {
    const prompt = `Aşağıdaki İSG bulgularına dayanarak Üst Yönetim için profesyonel Türkçe yönetici özeti yaz:\n${fails}`;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }] })
    });
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      const prev = document.getElementById("mail-preview");
      prev.insertAdjacentHTML("afterbegin", `
        <div style="background:#eff6ff;border-left:4px solid #3b82f6;padding:12px;margin-bottom:16px;color:#1e40af;font-size:12px;font-style:italic;white-space:pre-line;">
          <strong style="display:block;font-style:normal;margin-bottom:4px;">📝 YÖNETİCİ ÖZETİ:</strong>${text}
        </div>`);
      showToast("Yönetici özeti eklendi! ✨", "success");
    }
  } catch(e) { showToast("AI hatası: " + e.message, "error"); }
};

// ─── Kaydet ───
window.saveReport = async function(customList = null) {
  const list = customList || auditList;
  if (!list.length) { showToast("Liste boş.", "warning"); return; }
  const btn = document.getElementById("saveReportBtn");
  btn.textContent = "Kaydediliyor…"; btn.disabled = true;
  try {
    const data = {
      userId:   currentUser.uid,
      date:     document.getElementById("reportDate").value,
      location: currentLocation,
      title:    document.getElementById("reportTitle")?.value || "Periyodik Kontrol",
      items:    list,
      createdAt: serverTimestamp()
    };

    // Aynı tarih+lokasyon varsa güncelle
    const existing = cloudReports.find(r => r.date === data.date && r.location === data.location);
    if (existing) {
      await updateDoc(doc(db, "tool_ptk_reports", existing.id), { ...data, updatedAt: serverTimestamp() });
      showToast("Rapor güncellendi! ✅", "success");
    } else {
      await addDoc(collection(db, "tool_ptk_reports"), data);
      showToast("Rapor kaydedildi! ✅", "success");
    }
    await loadCloudReports();
  } catch (err) {
    showToast("Kayıt hatası: " + err.message, "error");
  } finally {
    btn.textContent = "💾 Kaydet & Raporla"; btn.disabled = false;
  }
};

// ─── CSV Şablon ───
window.downloadTemplate = function() {
  const master = getMasterData(currentLocation);
  let csv = "Kategori;Ekipman;Sicil No;Periyot (Ay);Depo;Durum (UYGUN/UYGUNSUZ);Açıklama\n";
  master.forEach(i => { csv += `${i.cat};${i.name};;${i.period};${currentLocation};UYGUN;\n`; });
  const blob = new Blob(["\uFEFF" + csv], { type:"text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `SABLON_${currentLocation}.csv`;
  a.click();
};

window.handleCSVUpload = function(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const rows = ev.target.result.split(/\r\n|\n/).slice(1);
    bulkData = [];
    rows.forEach((row, idx) => {
      if (!row.trim()) return;
      const cols = row.split(";");
      if (cols.length >= 2) {
        bulkData.push({
          _id: idx,
          cat: cols[0]?.trim() || "Genel",
          name: cols[1]?.trim() || "Bilinmeyen",
          assetId: cols[2]?.trim() || "",
          period: parseInt(cols[3]) || 12,
          status: cols[5]?.trim().toUpperCase() === "UYGUNSUZ" ? "fail" : "pass",
          note: cols[6]?.trim() || "",
          selected: true
        });
      }
    });
    if (bulkData.length) {
      showToast(`${bulkData.length} ekipman yüklendi!`, "success");
      renderBulkTable();
    }
  };
  reader.readAsText(file, "UTF-8");
  e.target.value = "";
};

function renderBulkTable() {
  const container = document.getElementById("bulk-table");
  const footer    = document.getElementById("bulk-footer");
  if (!bulkData.length) { container.innerHTML = ""; footer.style.display = "none"; return; }
  footer.style.display = "block";
  container.innerHTML = `
    <table class="admin-table" style="font-size:var(--text-xs);">
      <thead><tr>
        <th>✓</th><th>Kategori</th><th>Ekipman</th><th>Sicil No</th><th>Durum</th><th>Not</th>
      </tr></thead>
      <tbody>
        ${bulkData.map(i => `
          <tr>
            <td><input type="checkbox" ${i.selected?"checked":""} onchange="toggleBulkRow(${i._id},this.checked)" /></td>
            <td style="color:var(--text-muted);">${i.cat}</td>
            <td style="font-weight:var(--font-semibold);">${i.name}</td>
            <td><input type="text" value="${i.assetId}" class="form-control" style="width:100px;padding:4px 8px;font-size:var(--text-xs);" oninput="updateBulkRow(${i._id},'assetId',this.value)" /></td>
            <td>
              <select class="form-control" style="width:120px;padding:4px 8px;font-size:var(--text-xs);" onchange="updateBulkRow(${i._id},'status',this.value)">
                <option value="pass" ${i.status==="pass"?"selected":""}>✅ Uygun</option>
                <option value="fail" ${i.status==="fail"?"selected":""}>❌ Uygunsuz</option>
              </select>
            </td>
            <td><input type="text" value="${i.note}" class="form-control" style="width:180px;padding:4px 8px;font-size:var(--text-xs);" oninput="updateBulkRow(${i._id},'note',this.value)" /></td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

window.toggleBulkRow   = (id, v) => { const r = bulkData.find(i=>i._id===id); if(r) r.selected=v; };
window.updateBulkRow   = (id, f, v) => { const r = bulkData.find(i=>i._id===id); if(r) r[f]=v; };
window.selectAllBulk   = () => { bulkData.forEach(i=>i.selected=true); renderBulkTable(); };
window.setAllPassBulk  = () => { bulkData.forEach(i=>i.status="pass"); renderBulkTable(); };
window.saveBulk = async function() {
  const selected = bulkData.filter(i => i.selected);
  if (!selected.length) { showToast("En az bir ekipman seçin.", "warning"); return; }
  const formatted = selected.map(i => ({
    id: Date.now() + i._id + Math.random(),
    name: i.name, cat: i.cat, period: i.period,
    assetId: i.assetId, status: i.status, note: i.note, isCritical: false
  }));
  await saveReport(formatted);
};

// ─── Planlama ───
function renderPlanning() {
  const table = document.getElementById("planning-table");
  const master = getMasterData(currentLocation);
  const reports = cloudReports.filter(r => r.location === currentLocation);

  const rows = master.map(item => {
    const matching = reports.filter(r => r.items?.some(i => i.name === item.name));
    matching.sort((a,b) => new Date(b.date) - new Date(a.date));
    const last = matching[0];
    let lastDate = null, nextDate = new Date(), status = "overdue";

    if (last) {
      lastDate = new Date(last.date);
      nextDate = new Date(last.date);
      nextDate.setMonth(nextDate.getMonth() + item.period);
      const diffDays = Math.ceil((nextDate - new Date()) / 86400000);
      status = diffDays < 0 ? "overdue" : diffDays < 30 ? "warning" : "ok";
    }
    return { ...item, lastDate, nextDate, status };
  });

  const statusCfg = {
    overdue: { label:"GECİKMİŞ",   badge:"badge-danger"  },
    warning: { label:"YAKLAŞIYOR", badge:"badge-warning" },
    ok:      { label:"GÜNCEL",     badge:"badge-success" },
  };

  table.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>Kategori</th><th>Ekipman</th><th>Periyot</th><th>Son Kontrol</th><th>Sonraki Kontrol</th><th>Durum</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr class="planning-row ${r.status}">
            <td style="color:var(--text-muted);">${r.cat}</td>
            <td style="font-weight:var(--font-semibold);">${r.name}</td>
            <td>${r.period} Ay</td>
            <td>${r.lastDate ? r.lastDate.toLocaleDateString("tr-TR") : '<span style="color:var(--text-muted);">YOK</span>'}</td>
            <td style="font-weight:var(--font-semibold);">${r.nextDate.toLocaleDateString("tr-TR")}</td>
            <td><span class="badge ${statusCfg[r.status].badge}">${statusCfg[r.status].label}</span></td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

window.downloadPlanCSV = function() {
  const master = getMasterData(currentLocation);
  const reports = cloudReports.filter(r => r.location === currentLocation);
  let csv = "Kategori;Ekipman;Periyot (Ay);Son Kontrol;Sonraki Kontrol;Durum\n";
  master.forEach(item => {
    const matching = reports.filter(r => r.items?.some(i => i.name === item.name));
    matching.sort((a,b) => new Date(b.date) - new Date(a.date));
    const last = matching[0];
    let lastStr = "YOK", nextDate = new Date(), status = "GECİKMİŞ";
    if (last) {
      lastStr = new Date(last.date).toLocaleDateString("tr-TR");
      nextDate = new Date(last.date);
      nextDate.setMonth(nextDate.getMonth() + item.period);
      const diff = Math.ceil((nextDate - new Date()) / 86400000);
      status = diff < 0 ? "GECİKMİŞ" : diff < 30 ? "YAKLAŞIYOR" : "GÜNCEL";
    }
    csv += `${item.cat};${item.name};${item.period};${lastStr};${nextDate.toLocaleDateString("tr-TR")};${status}\n`;
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"}));
  a.download = `PLANLAMA_${currentLocation}.csv`;
  a.click();
};

// ─── Ekipman Kütüphanesi ───
function renderReference() {
  const master = getMasterData(currentLocation);
  const grouped = {};
  master.forEach(i => { if (!grouped[i.cat]) grouped[i.cat] = []; grouped[i.cat].push(i); });

  document.getElementById("reference-grid").innerHTML = Object.entries(grouped).map(([cat, items]) => `
    <div class="card">
      <div class="card-body">
        <h3 style="font-size:var(--text-sm);font-weight:var(--font-bold);color:var(--accent-primary);margin-bottom:var(--space-3);border-bottom:1px solid var(--border-subtle);padding-bottom:var(--space-2);">📁 ${cat}</h3>
        <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:var(--space-2);">
          ${items.map(i => `
            <li style="display:flex;justify-content:space-between;align-items:center;font-size:var(--text-sm);">
              <span>${i.name}</span>
              <span class="badge badge-primary" style="font-size:10px;">${i.period} Ay</span>
            </li>`).join("")}
        </ul>
      </div>
    </div>`).join("");
}

window.openAddEquipModal = () => { document.getElementById("addEquipModal").style.display = "flex"; };
window.addCustomEquip = function() {
  const name   = document.getElementById("newEquipName").value.trim();
  const cat    = document.getElementById("newEquipCat").value;
  const period = parseInt(document.getElementById("newEquipPeriod").value) || 12;
  if (!name) { showToast("Ekipman adı zorunludur.", "warning"); return; }
  const key = "ptk_custom_" + currentLocation;
  const custom = JSON.parse(localStorage.getItem(key) || "[]");
  custom.push({ cat, name, period, location: currentLocation });
  localStorage.setItem(key, JSON.stringify(custom));
  document.getElementById("addEquipModal").style.display = "none";
  document.getElementById("newEquipName").value = "";
  renderReference();
  showToast(`"${name}" eklendi! ✅`, "success");
};

// ─── Arşiv ───
function renderHistory() {
  const reports = cloudReports.filter(r => r.location === currentLocation);
  const container = document.getElementById("history-list");
  if (!reports.length) {
    container.innerHTML = `<div style="text-align:center;padding:3rem;color:var(--text-muted);">Bu lokasyon için kayıt bulunamadı.</div>`;
    return;
  }
  container.innerHTML = reports.map(r => `
    <div class="card" style="margin-bottom:var(--space-3);">
      <div class="card-body" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-4);">
        <div>
          <div style="font-weight:var(--font-bold);">${new Date(r.date).toLocaleDateString("tr-TR")} — ${r.title || "PTK Raporu"}</div>
          <div style="font-size:var(--text-xs);color:var(--text-muted);">${r.items?.length || 0} kalem · ${r.location}</div>
        </div>
        <div style="display:flex;gap:var(--space-2);">
          <button class="btn btn-ghost btn-sm" onclick="deleteReport('${r.id}')">🗑️ Sil</button>
        </div>
      </div>
    </div>`).join("");
}

window.deleteReport = async function(id) {
  if (!confirm("Bu raporu silmek istediğinize emin misiniz?")) return;
  try {
    await deleteDoc(doc(db, "tool_ptk_reports", id));
    cloudReports = cloudReports.filter(r => r.id !== id);
    renderHistory();
    showToast("Rapor silindi.", "success");
  } catch(e) { showToast("Silinemedi: " + e.message, "error"); }
};

window.downloadMasterCSV = function() {
  const reports = cloudReports.filter(r => r.location === currentLocation);
  if (!reports.length) { showToast("Bu lokasyon için kayıt yok.", "warning"); return; }
  let csv = "Tarih;Lokasyon;Başlık;Ekipman;Sicil No;Durum;Not\n";
  reports.forEach(r => {
    r.items?.forEach(i => {
      csv += `${r.date};${r.location};${r.title||""};${i.name};${i.assetId||""};${i.status==="pass"?"UYGUN":"UYGUNSUZ"};"${(i.note||"").replace(/\n/g," ")}"\n`;
    });
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"}));
  a.download = `MASTER_RAPOR_${currentLocation}.csv`;
  a.click();
};

// ─── Tab Yönetimi ───
window.switchPTKTab = function(tab) {
  document.querySelectorAll(".ptk-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".ptk-panel").forEach(p => { p.classList.remove("active"); p.style.display="none"; });
  event.currentTarget.classList.add("active");
  const panel = document.getElementById("panel-" + tab);
  if (panel) { panel.classList.add("active"); panel.style.display="block"; }
  if (tab === "planning") renderPlanning();
  if (tab === "history")  renderHistory();
};
