/**
 * is-izni.js — Teknik İş Takip & İSG Sistemi
 * 3 sekme: Günlük Giriş | Haftalık Durum | Geçmiş & Arşiv
 */

import { requireToolAccess, db, showToast } from "./app.js";
import {
  collection, query, where,
  getDocs, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const COLLECTION = "tool_work_permits";

const IZIN_TURLERI = {
  izin_yok:    "✅ İzin Gerekmiyor",
  yuksekte:    "🏗️ Yüksekte Çalışma",
  sicak:       "🔥 Sıcak İşlem",
  kapali_alan: "🚪 Kapalı Alan",
  elektrik:    "⚡ Elektrik İzolasyonu",
  kazi:        "⛏️ Kazı Çalışması",
};

let currentUser = null;
let allEntries  = [];
let editingId   = null;
let currentTab  = "daily";

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
(async () => {
  currentUser = await requireToolAccess("tool_work_permits", {
    loadingEl:  "page-loading",
    authGateEl: "auth-gate",
    mainEl:     "main-content"
  });
  if (!currentUser) return;

  setupEventListeners();
  initDefaultDates();
  await loadData();
})();

function initDefaultDates() {
  const today = todayStr();
  document.getElementById("dailyDate").value = today;

  // Arşiv: ayın başı → bugün
  const firstOfMonth = today.slice(0, 7) + "-01";
  document.getElementById("archStart").value = firstOfMonth;
  document.getElementById("archEnd").value   = today;
}

// ═══════════════════════════════════════════════
// VERİ YÜKLEME
// ═══════════════════════════════════════════════
async function loadData() {
  try {
    const q = query(
      collection(db, COLLECTION),
      where("userId", "==", currentUser.uid)
    );
    const snap = await getDocs(q);

    allEntries = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const td = (b.tarih || "").localeCompare(a.tarih || "");
        if (td !== 0) return td;
        return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
      });

    buildSuggestions();
    updateStats();
  } catch (err) {
    showToast("Veriler yüklenemedi: " + err.message, "error");
  } finally {
    renderCurrentTab();
  }
}

// ═══════════════════════════════════════════════
// İSTATİSTİKLER
// ═══════════════════════════════════════════════
function updateStats() {
  const weekAgoStr = (() => {
    const d = new Date(); d.setDate(d.getDate() - 6);
    return d.toISOString().split("T")[0];
  })();

  document.getElementById("statTotal").textContent     = allEntries.length;
  document.getElementById("statInProgress").textContent = allEntries.filter(e => e.durum === "Devam Ediyor").length;
  document.getElementById("statCompleted").textContent  = allEntries.filter(e => e.durum === "Tamamlandı").length;
  document.getElementById("statThisWeek").textContent   = allEntries.filter(e => (e.tarih || "") >= weekAgoStr).length;
}

// ═══════════════════════════════════════════════
// SEKME YÖNETİMİ
// ═══════════════════════════════════════════════
window.switchTab = function (tab) {
  currentTab = tab;
  document.querySelectorAll(".work-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".work-tab-content").forEach(c =>
    (c.style.display = c.id === `tab-${tab}` ? "block" : "none"));
  // Filtre şeridini güncelle
  ["daily","weekly","archive"].forEach(t => {
    const el = document.getElementById(`filters-${t}`);
    if (el) el.style.display = t === tab ? "flex" : "none";
  });
  renderCurrentTab();
};

function renderCurrentTab() {
  if      (currentTab === "daily")   renderDailyTab();
  else if (currentTab === "weekly")  renderWeeklyTab();
  else                               renderArchiveTab();
}

// ═══════════════════════════════════════════════
// GÜNLÜK SEKMESİ
// ═══════════════════════════════════════════════
function renderDailyTab() {
  const dateFilter = document.getElementById("dailyDate").value || todayStr();
  const searchVal  = document.getElementById("dailySearch").value.toLowerCase().trim();

  const filtered = allEntries.filter(e => {
    const matchDate   = e.tarih === dateFilter;
    const matchSearch = !searchVal ||
      e.firma?.toLowerCase().includes(searchVal) ||
      e.proje?.toLowerCase().includes(searchVal) ||
      e.detay?.toLowerCase().includes(searchVal) ||
      e.sorumlu?.toLowerCase().includes(searchVal);
    return matchDate && matchSearch;
  });

  const container = document.getElementById("daily-list");
  if (!filtered.length) {
    container.innerHTML = emptyState(
      "📋",
      dateFilter === todayStr() ? "Bugün henüz kayıt girilmedi." : "Bu tarihe ait kayıt bulunamadı.",
      `<button class="btn btn-primary" style="margin-top:var(--space-4);" onclick="openNewModal()">➕ Yeni Kayıt Ekle</button>`
    );
    return;
  }
  container.innerHTML = buildEntriesTable(filtered, true);
}

// ═══════════════════════════════════════════════
// HAFTALIK SEKME
// ═══════════════════════════════════════════════
function renderWeeklyTab() {
  const weekAgoStr   = (() => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().split("T")[0]; })();
  const statusFilter = document.getElementById("weeklyFilterStatus").value;
  const searchVal    = document.getElementById("weeklySearch").value.toLowerCase().trim();

  const filtered = allEntries.filter(e => {
    const inRange     = (e.tarih || "") >= weekAgoStr && (e.tarih || "") <= todayStr();
    const matchStatus = statusFilter === "all" || e.durum === statusFilter;
    const matchSearch = !searchVal ||
      e.firma?.toLowerCase().includes(searchVal) ||
      e.proje?.toLowerCase().includes(searchVal) ||
      e.depo?.toLowerCase().includes(searchVal);
    return inRange && matchStatus && matchSearch;
  });

  const container = document.getElementById("weekly-list");
  if (!filtered.length) {
    container.innerHTML = emptyState("📊", "Son 7 günde kayıt bulunamadı.");
    return;
  }
  container.innerHTML = buildWeeklyTable(filtered);
}

// ═══════════════════════════════════════════════
// ARŞİV SEKMESİ
// ═══════════════════════════════════════════════
function renderArchiveTab() {
  const startDate = document.getElementById("archStart").value;
  const endDate   = document.getElementById("archEnd").value;
  const searchVal = document.getElementById("archSearch").value.toLowerCase().trim();

  const filtered = allEntries.filter(e => {
    const matchStart  = !startDate || (e.tarih || "") >= startDate;
    const matchEnd    = !endDate   || (e.tarih || "") <= endDate;
    const matchSearch = !searchVal ||
      e.firma?.toLowerCase().includes(searchVal) ||
      e.proje?.toLowerCase().includes(searchVal) ||
      e.detay?.toLowerCase().includes(searchVal) ||
      e.sorumlu?.toLowerCase().includes(searchVal) ||
      e.depo?.toLowerCase().includes(searchVal);
    return matchStart && matchEnd && matchSearch;
  });

  const container = document.getElementById("archive-list");
  if (!filtered.length) {
    container.innerHTML = emptyState("🗂️", "Seçilen aralıkta kayıt bulunamadı.");
    return;
  }
  container.innerHTML = buildEntriesTable(filtered, false);
}

// ═══════════════════════════════════════════════
// TABLO OLUŞTURUCULAR
// ═══════════════════════════════════════════════
function buildEntriesTable(entries, showActions) {
  const actionHeader = showActions ? `<th class="wt">İşlem</th>` : "";
  const rows = entries.map(e => buildEntryRow(e, showActions)).join("");
  return `
    <div style="overflow-x:auto;">
      <table class="entry-table">
        <thead>
          <tr>
            <th class="wt">Görsel</th>
            <th class="wt">Tarih / Birim</th>
            <th class="wt">Firma & Sorumlu</th>
            <th class="wt">Lokasyon</th>
            <th class="wt">Proje & Detay</th>
            <th class="wt">İş İzni</th>
            <th class="wt">Durum</th>
            ${actionHeader}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function buildEntryRow(e, showActions) {
  const izinLabel  = IZIN_TURLERI[e.izinTuru] || e.izinTuru || "—";
  const durumColor = e.durum === "Tamamlandı" ? "var(--accent-success)" : "var(--accent-warning)";
  const lokasyon   = [e.blok, e.kat, e.alan].filter(Boolean).join(" / ") || "—";
  const imgCell    = e.gorselUrl
    ? `<a href="${e.gorselUrl}" target="_blank" rel="noopener">
         <img src="${e.gorselUrl}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;" />
       </a>`
    : `<span style="color:var(--text-muted);font-size:1.4rem;">📷</span>`;

  const actionCell = showActions ? `
    <td class="wd">
      <div style="display:flex;gap:var(--space-1);">
        <button class="btn btn-ghost btn-sm" onclick="duplicateEntry('${e.id}')" title="Bugüne Kopyala">📋</button>
        <button class="btn btn-ghost btn-sm" onclick="openEditModal('${e.id}')" title="Düzenle">✏️</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);" onclick="deleteEntry('${e.id}')" title="Sil">🗑️</button>
      </div>
    </td>` : "";

  return `
    <tr>
      <td class="wd">${imgCell}</td>
      <td class="wd" style="white-space:nowrap;">
        <div style="font-weight:var(--font-semibold);">${formatTrDate(e.tarih)}</div>
        <div style="font-size:var(--text-xs);color:var(--text-muted);">${e.birimTuru || ""}</div>
      </td>
      <td class="wd">
        <div style="font-weight:var(--font-semibold);">${e.firma || "—"}</div>
        <div style="font-size:var(--text-xs);color:var(--text-muted);">${e.sorumlu || ""}</div>
      </td>
      <td class="wd">
        <div>${lokasyon}</div>
        ${e.depo ? `<div style="font-size:var(--text-xs);color:var(--text-muted);">Depo: ${e.depo}</div>` : ""}
      </td>
      <td class="wd" style="max-width:220px;">
        <div style="font-weight:var(--font-semibold);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.proje || "—"}</div>
        <div style="font-size:var(--text-xs);color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.detay || ""}</div>
      </td>
      <td class="wd">
        <span style="font-size:var(--text-xs);background:var(--bg-surface-3);padding:2px 8px;border-radius:99px;white-space:nowrap;">${izinLabel}</span>
      </td>
      <td class="wd">
        <span style="font-weight:var(--font-semibold);color:${durumColor};white-space:nowrap;">${e.durum || "—"}</span>
        ${e.kapanis_notu ? `<div style="font-size:var(--text-xs);color:var(--text-muted);">${e.kapanis_notu}</div>` : ""}
      </td>
      ${actionCell}
    </tr>`;
}

function buildWeeklyTable(entries) {
  const rows = entries.map(e => `
    <tr>
      <td class="wd">
        ${e.gorselUrl
          ? `<a href="${e.gorselUrl}" target="_blank" rel="noopener"><img src="${e.gorselUrl}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;" /></a>`
          : `<span style="color:var(--text-muted);font-size:1.4rem;">📷</span>`}
      </td>
      <td class="wd" style="white-space:nowrap;font-weight:var(--font-semibold);">${formatTrDate(e.tarih)}</td>
      <td class="wd">
        <div style="font-weight:var(--font-semibold);">${e.firma || "—"}</div>
        <div style="font-size:var(--text-xs);color:var(--text-muted);">${[e.blok, e.kat, e.alan, e.depo].filter(Boolean).join(" / ") || "—"}</div>
      </td>
      <td class="wd" style="max-width:200px;">
        <div style="font-weight:var(--font-semibold);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.proje || "—"}</div>
        <div style="font-size:var(--text-xs);">${IZIN_TURLERI[e.izinTuru] || ""}</div>
      </td>
      <td class="wd">
        <select id="wstatus_${e.id}" class="form-control form-control-sm" style="min-width:155px;">
          <option value="Devam Ediyor" ${e.durum === "Devam Ediyor" ? "selected" : ""}>⏳ Devam Ediyor</option>
          <option value="Tamamlandı"  ${e.durum === "Tamamlandı"  ? "selected" : ""}>✅ Tamamlandı</option>
        </select>
      </td>
      <td class="wd">
        <input type="text" id="wnote_${e.id}" class="form-control form-control-sm"
          value="${e.kapanis_notu || ""}" placeholder="Kapanış notu…" style="min-width:160px;" />
      </td>
      <td class="wd">
        <button class="btn btn-primary btn-sm" onclick="saveWeeklyStatus('${e.id}')">💾</button>
      </td>
    </tr>`).join("");

  return `
    <div style="overflow-x:auto;">
      <table class="entry-table">
        <thead>
          <tr>
            <th class="wt">Görsel</th>
            <th class="wt">Tarih</th>
            <th class="wt">Firma & Lokasyon</th>
            <th class="wt">Proje & İzin</th>
            <th class="wt">Durum</th>
            <th class="wt">Kapanış Notu</th>
            <th class="wt">Kaydet</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ═══════════════════════════════════════════════
// HAFTALIK DURUM GÜNCELLEME
// ═══════════════════════════════════════════════
window.saveWeeklyStatus = async function (id) {
  const durum        = document.getElementById(`wstatus_${id}`)?.value || "Devam Ediyor";
  const kapanis_notu = document.getElementById(`wnote_${id}`)?.value?.trim() || "";
  try {
    await updateDoc(doc(db, COLLECTION, id), { durum, kapanis_notu, updatedAt: serverTimestamp() });
    const idx = allEntries.findIndex(e => e.id === id);
    if (idx !== -1) { allEntries[idx].durum = durum; allEntries[idx].kapanis_notu = kapanis_notu; }
    updateStats();
    showToast("Durum güncellendi ✅", "success");
  } catch (err) {
    showToast("Hata: " + err.message, "error");
  }
};

// ═══════════════════════════════════════════════
// MODAL: YENİ KAYIT
// ═══════════════════════════════════════════════
window.openNewModal = function () {
  editingId = null;
  fillModal(null);
  document.getElementById("entryModalTitle").textContent = "Yeni Kayıt";
  document.getElementById("deleteEntryBtn").classList.add("hidden");
  document.getElementById("entryModal").style.display = "flex";
};

// ═══════════════════════════════════════════════
// MODAL: DÜZENLE
// ═══════════════════════════════════════════════
window.openEditModal = function (id) {
  const e = allEntries.find(e => e.id === id);
  if (!e) return;
  editingId = id;
  fillModal(e);
  document.getElementById("entryModalTitle").textContent = "Kaydı Düzenle";
  document.getElementById("deleteEntryBtn").classList.remove("hidden");
  document.getElementById("entryModal").style.display = "flex";
};

function fillModal(e) {
  document.getElementById("entryId").value     = e?.id || "";
  document.getElementById("eTarih").value      = e?.tarih     || todayStr();
  document.getElementById("eBirimTuru").value  = e?.birimTuru || "Taşeron";
  document.getElementById("eFirma").value      = e?.firma     || "";
  document.getElementById("eSorumlu").value    = e?.sorumlu   || "";
  document.getElementById("eBlok").value       = e?.blok      || "";
  document.getElementById("eKat").value        = e?.kat       || "";
  document.getElementById("eAlan").value       = e?.alan      || "";
  document.getElementById("eDepo").value       = e?.depo      || "";
  document.getElementById("eProje").value      = e?.proje     || "";
  document.getElementById("eIzinTuru").value   = e?.izinTuru  || "izin_yok";
  document.getElementById("eDetay").value      = e?.detay     || "";
  document.getElementById("eDurum").value      = e?.durum     || "Devam Ediyor";
  document.getElementById("eKapanis").value    = e?.kapanis_notu || "";
  document.getElementById("eGorsel").value     = "";
  const prev = document.getElementById("gorselPreview");
  if (e?.gorselUrl) { prev.src = e.gorselUrl; prev.style.display = "block"; }
  else              { prev.style.display = "none"; }
  document.getElementById("entryFormError").classList.add("hidden");
}

window.closeEntryModal = function () {
  document.getElementById("entryModal").style.display = "none";
  editingId = null;
};

// ═══════════════════════════════════════════════
// KAYDET
// ═══════════════════════════════════════════════
window.saveEntry = async function () {
  const tarih        = document.getElementById("eTarih").value;
  const birimTuru    = document.getElementById("eBirimTuru").value;
  const firma        = document.getElementById("eFirma").value.trim();
  const sorumlu      = document.getElementById("eSorumlu").value.trim();
  const blok         = document.getElementById("eBlok").value.trim();
  const kat          = document.getElementById("eKat").value.trim();
  const alan         = document.getElementById("eAlan").value.trim();
  const depo         = document.getElementById("eDepo").value.trim();
  const proje        = document.getElementById("eProje").value.trim();
  const izinTuru     = document.getElementById("eIzinTuru").value;
  const detay        = document.getElementById("eDetay").value.trim();
  const durum        = document.getElementById("eDurum").value;
  const kapanis_notu = document.getElementById("eKapanis").value.trim();
  const gorselFile   = document.getElementById("eGorsel").files?.[0];

  if (!tarih || !firma || !proje || !detay) {
    showFormError("Tarih, firma, proje ve detay alanları zorunludur.");
    return;
  }

  const saveBtn = document.getElementById("saveEntryBtn");
  saveBtn.disabled = true; saveBtn.textContent = "⏳ Kaydediliyor…";

  try {
    let gorselUrl = editingId
      ? (allEntries.find(e => e.id === editingId)?.gorselUrl ?? null)
      : null;

    if (gorselFile) gorselUrl = await uploadImage(gorselFile);

    const data = {
      userId: currentUser.uid,
      tarih, birimTuru, firma, sorumlu,
      blok, kat, alan, depo,
      proje, izinTuru, detay, durum, kapanis_notu,
      gorselUrl: gorselUrl || null,
      updatedAt: serverTimestamp()
    };

    if (editingId) {
      await updateDoc(doc(db, COLLECTION, editingId), data);
      const idx = allEntries.findIndex(e => e.id === editingId);
      if (idx !== -1) allEntries[idx] = { ...allEntries[idx], ...data };
      showToast("Kayıt güncellendi ✅", "success");
    } else {
      data.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, COLLECTION), data);
      allEntries.unshift({ id: ref.id, ...data, createdAt: { seconds: Date.now() / 1000 } });
      showToast("Kayıt eklendi ✅", "success");
    }

    buildSuggestions();
    updateStats();
    closeEntryModal();
    renderCurrentTab();
  } catch (err) {
    showFormError("Kayıt hatası: " + err.message);
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = "💾 Kaydet";
  }
};

function showFormError(msg) {
  document.getElementById("entryFormErrorText").textContent = msg;
  document.getElementById("entryFormError").classList.remove("hidden");
}

// ═══════════════════════════════════════════════
// SİL
// ═══════════════════════════════════════════════
window.deleteEntry = async function (id) {
  if (!confirm("Bu kaydı kalıcı olarak silmek istediğinize emin misiniz?")) return;
  try {
    await deleteDoc(doc(db, COLLECTION, id));
    allEntries = allEntries.filter(e => e.id !== id);
    updateStats();
    renderCurrentTab();
    showToast("Kayıt silindi.", "success");
    if (editingId === id) closeEntryModal();
  } catch (err) {
    showToast("Silinemedi: " + err.message, "error");
  }
};

// ═══════════════════════════════════════════════
// BUGÜNE KOPYALA
// ═══════════════════════════════════════════════
window.duplicateEntry = function (id) {
  const e = allEntries.find(e => e.id === id);
  if (!e) return;
  // Modal'ı düzenleme modunda aç
  openEditModal(id);
  // Ardından yeni kayıt gibi davran
  document.getElementById("eTarih").value   = todayStr();
  document.getElementById("eDurum").value   = "Devam Ediyor";
  document.getElementById("eKapanis").value = "";
  document.getElementById("entryModalTitle").textContent = "Yeni Kayıt (Kopyalandı)";
  document.getElementById("deleteEntryBtn").classList.add("hidden");
  editingId = null;
};

// ═══════════════════════════════════════════════
// RESİM YÜKLEME
// ═══════════════════════════════════════════════
async function uploadImage(file) {
  const MAX = 800;
  const img = await createImageBitmap(file);
  let w = img.width, h = img.height;
  if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);

  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      const fd = new FormData();
      fd.append("file", blob, file.name.replace(/\.[^.]+$/, ".jpg"));
      try {
        const res  = await fetch("../cpanel-scripts/upload.php", { method: "POST", body: fd });
        const json = await res.json();
        if (json.url) resolve(json.url);
        else reject(new Error(json.error || "Yükleme başarısız"));
      } catch {
        // Test/localhost: geçici object URL kullan
        resolve(URL.createObjectURL(blob));
      }
    }, "image/jpeg", 0.75);
  });
}

// ═══════════════════════════════════════════════
// EXCEL EXPORT
// ═══════════════════════════════════════════════
window.exportExcel = function () {
  if (!allEntries.length) { showToast("Aktarılacak veri yok.", "warning"); return; }

  const rows = allEntries.map(e => ({
    "Tarih":          e.tarih      || "",
    "Birim Türü":     e.birimTuru  || "",
    "Firma":          e.firma      || "",
    "Sorumlu":        e.sorumlu    || "",
    "Blok":           e.blok       || "",
    "Kat":            e.kat        || "",
    "Alan":           e.alan       || "",
    "Depo":           e.depo       || "",
    "Proje":          e.proje      || "",
    "İş İzni":        IZIN_TURLERI[e.izinTuru] || e.izinTuru || "",
    "İş Detayı":      e.detay      || "",
    "Durum":          e.durum      || "",
    "Kapanış Notu":   e.kapanis_notu || "",
    "Görsel URL":     e.gorselUrl  || "",
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  // Sütun genişlikleri
  ws["!cols"] = [
    {wch:12},{wch:16},{wch:20},{wch:20},{wch:10},{wch:8},
    {wch:14},{wch:16},{wch:28},{wch:22},{wch:35},{wch:14},{wch:25},{wch:30}
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "İş Takip");
  XLSX.writeFile(wb, `Is_Takip_${todayStr()}.xlsx`);
  showToast("Excel dosyası indirildi ✅", "success");
};

// ═══════════════════════════════════════════════
// OTOMATİK TAMAMLAMA
// ═══════════════════════════════════════════════
function buildSuggestions() {
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const fill = (id, values) => {
    const dl = document.getElementById(id);
    if (dl) dl.innerHTML = values.map(v => `<option value="${v}"></option>`).join("");
  };
  fill("firmaSuggestions",   uniq(allEntries.map(e => e.firma)));
  fill("sorumluSuggestions", uniq(allEntries.map(e => e.sorumlu)));
  fill("blokSuggestions",    uniq(allEntries.map(e => e.blok)));
  fill("katSuggestions",     uniq(allEntries.map(e => e.kat)));
  fill("alanSuggestions",    uniq(allEntries.map(e => e.alan)));
  fill("depoSuggestions",    uniq(allEntries.map(e => e.depo)));
  fill("projeSuggestions",   uniq(allEntries.map(e => e.proje)));
}

// ═══════════════════════════════════════════════
// YARDIMCILAR
// ═══════════════════════════════════════════════
function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function formatTrDate(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function emptyState(icon, msg, extra = "") {
  return `
    <div style="text-align:center;padding:var(--space-12);color:var(--text-muted);">
      <div style="font-size:2.5rem;margin-bottom:var(--space-3);">${icon}</div>
      <p>${msg}</p>${extra}
    </div>`;
}

// ═══════════════════════════════════════════════
// EVENT LİSTENERS
// ═══════════════════════════════════════════════
function setupEventListeners() {
  document.getElementById("openNewEntryBtn")?.addEventListener("click", openNewModal);
  document.getElementById("exportExcelBtn")?.addEventListener("click", exportExcel);
  document.getElementById("saveEntryBtn")?.addEventListener("click", saveEntry);
  document.getElementById("deleteEntryBtn")?.addEventListener("click", () => deleteEntry(editingId));

  // Modal overlay tıklama
  document.getElementById("entryModal")?.addEventListener("click", e => {
    if (e.target === document.getElementById("entryModal")) closeEntryModal();
  });

  // Resim önizleme
  document.getElementById("eGorsel")?.addEventListener("change", e => {
    const file = e.target.files?.[0];
    const prev = document.getElementById("gorselPreview");
    if (file) { prev.src = URL.createObjectURL(file); prev.style.display = "block"; }
    else { prev.style.display = "none"; }
  });

  // Bugün butonu
  document.getElementById("gotoTodayBtn")?.addEventListener("click", () => {
    document.getElementById("dailyDate").value = todayStr();
    renderDailyTab();
  });

  // Günlük filtreler
  document.getElementById("dailyDate")?.addEventListener("change",  () => renderDailyTab());
  document.getElementById("dailySearch")?.addEventListener("input", () => renderDailyTab());

  // Haftalık filtreler
  document.getElementById("weeklyFilterStatus")?.addEventListener("change", () => renderWeeklyTab());
  document.getElementById("weeklySearch")?.addEventListener("input", () => renderWeeklyTab());

  // Arşiv filtreler
  document.getElementById("archStart")?.addEventListener("change",  () => renderArchiveTab());
  document.getElementById("archEnd")?.addEventListener("change",    () => renderArchiveTab());
  document.getElementById("archSearch")?.addEventListener("input",  () => renderArchiveTab());
}
