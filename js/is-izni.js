/**
 * is-izni.js — Teknik İş Takip & İSG Sistemi
 * 3 sekme: Günlük Giriş | Haftalık Durum | Geçmiş & Arşiv
 *
 * Optimizasyonlar:
 * - localStorage cache (ozisg_isizni_cache, 24 saat TTL)
 * - Skeleton loader (ilk yükleme & yenileme sırasında)
 * - Tüm write işlemleri cache'i anında günceller
 * - Firestore yetki kurallarına uygun hata yönetimi eklendi.
 */

import { requireToolAccess, db, showToast } from "./app.js";
import {
  collection, query, where,
  getDocs, addDoc, updateDoc, deleteDoc,
  doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── Skeleton CSS enjeksiyonu (harici bağımlılık yok) ───
(function () {
  const s = document.createElement("style");
  s.textContent = `
    @keyframes _sk_pulse { 0%,100%{opacity:1} 50%{opacity:.45} }
    .sk-row {
      display:flex; gap:12px; align-items:center;
      background:var(--bg-surface); border:1px solid var(--border-subtle);
      border-radius:var(--border-radius); padding:12px; margin-bottom:8px;
      animation:_sk_pulse 1.4s ease-in-out infinite;
    }
    .sk-box  { background:var(--border-color); border-radius:6px; flex-shrink:0; }
    .sk-line { background:var(--border-color); border-radius:3px; }
    .sk-pill { background:var(--border-color); border-radius:99px; flex-shrink:0; }
  `;
  document.head.appendChild(s);
})();

// ─── Sabitler ───
const COLLECTION  = "tool_work_permits";
const SETTINGS_COLLECTION = "tool_work_permits_settings";
const CACHE_KEY   = "ozisg_isizni_cache";
const CACHE_TTL   = 24 * 60 * 60 * 1000; // 24 saat

const IZIN_TURLERI = {
  izin_yok:    "✅ İzin Gerekmiyor",
  yuksekte:    "🏗️ Yüksekte Çalışma",
  sicak:       "🔥 Sıcak İşlem",
  kapali_alan: "🚪 Kapalı Alan",
  elektrik:    "⚡ Elektrik İzolasyonu",
  kazi:        "⛏️ Kazı Çalışması",
};

// PTW: izin türüne özel tehlike kontrol listesi. Dünyadaki Permit-to-Work
// sistemlerinde standart olan hazard-checklist yaklaşımı — "izin_yok" hariç
// her tür için, çalışmaya başlamadan önce doğrulanması gereken maddeler.
const CHECKLISTS = {
  izin_yok: [],
  yuksekte: [
    "Düşmeyi önleyici ekipman (tam vücut kemer) kontrol edildi",
    "İskele/platform güvenlik etiketi kontrol edildi",
    "Hava durumu (rüzgar/yağış) çalışmaya uygun",
    "Çalışma alanı altı bariyerle kapatıldı",
  ],
  sicak: [
    "Yangın söndürücü çalışma alanında hazır",
    "Yanıcı madde/gaz ölçümü yapıldı",
    "Gözcü (yangın gözcüsü) görevlendirildi",
    "Çevredeki yanıcı malzemeler kaldırıldı/korundu",
  ],
  kapali_alan: [
    "Ortam gazı ölçümü yapıldı (O2/LEL/H2S/CO)",
    "Havalandırma sağlandı",
    "Dışarıda gözcü görevlendirildi",
    "Acil kurtarma planı ve ekipmanı hazır",
  ],
  elektrik: [
    "Enerji kesildi ve etiketlendi (LOTO uygulandı)",
    "Voltaj testi yapıldı (gerilim yok doğrulandı)",
    "Yalıtımlı ekipman/eldiven kullanılıyor",
    "Topraklama kontrol edildi",
  ],
  kazi: [
    "Yer altı tesisatı (elektrik/su/doğalgaz) tespit edildi",
    "Şev/iksa güvenliği sağlandı",
    "1.2m üzeri kazılarda ortam gazı ölçüldü",
    "Kazı çevresi bariyerle işaretlendi",
  ],
};

// PTW durum yaşam döngüsü: Taslak -> Aktif -> (Askıya Alındı) -> Kapatıldı
// (veya İptal Edildi). Eski kayıtlar "Devam Ediyor"/"Tamamlandı" string'lerini
// taşıyor — bunlar ASLA veritabanında değiştirilmez (geriye dönük uyumluluk),
// sadece istatistik/filtreleme için normalize edilir.
function normalizeStatus(durum) {
  if (durum === "Devam Ediyor") return "Aktif";
  if (durum === "Tamamlandı")   return "Kapatıldı";
  return durum || "Taslak";
}

function statusColor(durum) {
  const n = normalizeStatus(durum);
  if (n === "Aktif")          return "var(--accent-success)";
  if (n === "Askıya Alındı")  return "var(--accent-warning)";
  if (n === "Kapatıldı")      return "var(--text-muted)";
  if (n === "İptal Edildi")   return "var(--accent-danger)";
  return "var(--accent-warning)"; // Taslak
}

function generatePermitNo() {
  const d = new Date();
  const ymd = d.toISOString().slice(0,10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `IP-${ymd}-${rand}`;
}

// PTW audit log: dünyadaki Permit-to-Work sistemlerinde standart olan
// "kim, ne zaman, ne değiştirdi" izini — Firestore doküman alanı olarak
// tutulur (ayrı koleksiyona gerek yok, hacim küçük). Son 30 kayıtla
// sınırlanır (sınırsız büyümeyi önlemek için, aşırı mühendislik değil).
function buildHistoryEntries(existing, newData, extended) {
  const actor = currentUser?.email || currentUser?.uid || "bilinmeyen";
  const now = new Date().toISOString();
  const entries = [];
  const push = (action) => entries.push({ ts: now, actor, action });

  if (!existing) {
    push("İzin oluşturuldu");
    return entries;
  }
  const oldStatus = normalizeStatus(existing.durum);
  const newStatus = normalizeStatus(newData.durum);
  if (oldStatus !== newStatus) {
    push(`Durum değişti: ${existing.durum || "—"} → ${newData.durum}`);
  }
  if (extended) {
    push(`Geçerlilik süresi güncellendi (${existing.gecerlilikBitis || "—"} → ${newData.gecerlilikBitis || "—"}), onaylar sıfırlandı`);
  }
  if (!existing.izniVerenOnay && newData.izniVerenOnay) push(`İzni Veren onayladı: ${newData.izniVerenAd || "—"}`);
  if (!existing.izinAlanOnay && newData.izinAlanOnay)   push(`İzni Alan onayladı: ${newData.izniAlanAd || "—"}`);
  if (newData.kapanis_notu && newData.kapanis_notu !== existing.kapanis_notu) {
    push(`Durum notu eklendi: ${newData.kapanis_notu}`);
  }
  if (!entries.length) push("Kayıt güncellendi");
  return entries;
}

function appendHistory(existing, newEntries) {
  const prior = Array.isArray(existing?.history) ? existing.history : [];
  return [...prior, ...newEntries].slice(-30);
}

let currentUser = null;
let allEntries  = [];
let editingId   = null;
let currentTab  = "daily";

// ─── Ayarlar (kurumsal bilgi + mail dağıtım listesi) ───
let settings = { companyName: "", logoUrl: "", mailRecipients: [], signature: "" };

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
  showSkeletonLoader();      // veriler gelmeden önce iskelet göster
  await loadSettings();
  await loadData();
})();

// ═══════════════════════════════════════════════
// AYARLAR (kurumsal bilgi + mail dağıtım listesi)
// ═══════════════════════════════════════════════
async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, SETTINGS_COLLECTION, currentUser.uid));
    if (snap.exists()) {
      const d = snap.data();
      settings = {
        companyName:    d.companyName    || "",
        logoUrl:        d.logoUrl        || "",
        mailRecipients: Array.isArray(d.mailRecipients) ? d.mailRecipients : [],
        signature:      d.signature      || "",
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
  if (cn) cn.value = settings.companyName;
  if (lu) lu.value = settings.logoUrl;
  if (mr) mr.value = settings.mailRecipients.join("\n");
  if (sg) sg.value = settings.signature;
}

function parseRecipients(raw) {
  return raw.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
}

window.saveSettings = async function() {
  const cn = document.getElementById("set-companyName")?.value.trim() || "";
  const lu = document.getElementById("set-logoUrl")?.value.trim() || "";
  const mr = parseRecipients(document.getElementById("set-mailRecipients")?.value || "");
  const sg = document.getElementById("set-signature")?.value.trim() || "";

  const invalid = mr.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (invalid.length) {
    showToast(`Geçersiz e-posta adresi: ${invalid.join(", ")}`, "error");
    return;
  }

  const btn = document.getElementById("saveSettingsBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Kaydediliyor…"; }
  try {
    settings = { companyName: cn, logoUrl: lu, mailRecipients: mr, signature: sg };
    await setDoc(doc(db, SETTINGS_COLLECTION, currentUser.uid), {
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

function initDefaultDates() {
  const today = todayStr();
  document.getElementById("dailyDate").value = today;
  const firstOfMonth = today.slice(0, 7) + "-01";
  document.getElementById("archStart").value = firstOfMonth;
  document.getElementById("archEnd").value   = today;
}

// ═══════════════════════════════════════════════
// SKELETON LOADER
// ═══════════════════════════════════════════════
function showSkeletonLoader() {
  const row = () => `
    <div class="sk-row">
      <div class="sk-box"  style="width:44px;height:44px;"></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
        <div class="sk-line" style="height:13px;width:30%;"></div>
        <div class="sk-line" style="height:11px;width:58%;opacity:.6;"></div>
      </div>
      <div class="sk-line" style="height:11px;width:22%;"></div>
      <div class="sk-pill" style="width:80px;height:24px;"></div>
    </div>`;
  const html = Array.from({ length: 6 }, row).join("");
  const el = document.getElementById(`${currentTab}-list`);
  if (el) el.innerHTML = html;
}

// ═══════════════════════════════════════════════
// VERİ YÜKLEME — localStorage cache ile
// ═══════════════════════════════════════════════
async function loadData(forceRefresh = false) {
  // 1. Cache kontrolü
  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const { ts, uid, data } = JSON.parse(raw);
        if (uid === currentUser.uid && Date.now() - ts < CACHE_TTL) {
          allEntries = data;
          buildSuggestions();
          updateStats();
          renderCurrentTab();
          return; // Firestore'a istek atma
        }
      }
    } catch (e) { /* bozuk cache — yok say */ }
  }

  // 2. Firestore'dan çek
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

    // 3. Cache'e kaydet
    persistCache();
    buildSuggestions();
    updateStats();
  } catch (err) {
    showToast("Veriler yüklenemedi: " + err.message, "error");
  } finally {
    renderCurrentTab();
  }
}

// ─── Cache'i güncel allEntries ile yenile ───
function persistCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      ts:   Date.now(),
      uid:  currentUser.uid,
      data: allEntries,
    }));
  } catch (e) { /* localStorage dolu olabilir */ }
}

// ═══════════════════════════════════════════════
// İSTATİSTİKLER
// ═══════════════════════════════════════════════
function updateStats() {
  const weekAgoStr = (() => {
    const d = new Date(); d.setDate(d.getDate() - 6);
    return d.toISOString().split("T")[0];
  })();

  document.getElementById("statTotal").textContent      = allEntries.length;
  document.getElementById("statInProgress").textContent = allEntries.filter(e => normalizeStatus(e.durum) === "Aktif").length;
  document.getElementById("statCompleted").textContent  = allEntries.filter(e => normalizeStatus(e.durum) === "Kapatıldı").length;
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
  ["daily", "weekly", "archive"].forEach(t => {
    const el = document.getElementById(`filters-${t}`);
    if (el) el.style.display = t === tab ? "flex" : "none";
  });
  if (tab === "settings") { fillSettingsForm(); return; }
  renderCurrentTab();
};

function renderCurrentTab() {
  if      (currentTab === "daily")   renderDailyTab();
  else if (currentTab === "weekly")  renderWeeklyTab();
  else if (currentTab === "archive") renderArchiveTab();
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
  
  // DÜZELTME: Eskiden false olan ikinci parametre true yapıldı.
  // Bu sayede Arşiv sekmesinde de Düzenle, Kopyala ve Sil eylemleri görünür oldu.
  container.innerHTML = buildEntriesTable(filtered, true);
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
  const durumColor = statusColor(e.durum);
  const lokasyon   = [e.blok, e.kat, e.alan].filter(Boolean).join(" / ") || "—";
  const expired    = normalizeStatus(e.durum) === "Aktif" && e.gecerlilikBitis && new Date(e.gecerlilikBitis) < new Date();
  
  // DÜZELTME: Görsel için stil iyileştirmesi yapıldı. Resim yüklenemezse veya yoksa stabil durur.
  const imgCell    = e.gorselUrl
    ? `<a href="${e.gorselUrl}" target="_blank" rel="noopener" style="display:block; width:44px; height:44px;">
         <img src="${e.gorselUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;background:var(--bg-surface-2);" alt="Görsel" onerror="this.outerHTML='<span style=\\'color:var(--text-muted);font-size:1.4rem;\\'>📷</span>'" />
       </a>`
    : `<span style="color:var(--text-muted);font-size:1.4rem;display:flex;align-items:center;justify-content:center;width:44px;height:44px;">📷</span>`;

  const actionCell = showActions ? `
    <td class="wd">
      <div style="display:flex;gap:var(--space-1);">
        <button class="btn btn-ghost btn-sm" onclick="duplicateEntry('${e.id}')" title="Bugüne Kopyala">📋</button>
        <button class="btn btn-ghost btn-sm" onclick="openEditModal('${e.id}')" title="Düzenle (Durum Değiştir)">✏️</button>
        <button class="btn btn-ghost btn-sm" onclick="sendPermitMail('${e.id}')" title="Mail Gönder">📧</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);" onclick="deleteEntry('${e.id}')" title="Sil">🗑️</button>
      </div>
    </td>` : "";

  return `
    <tr>
      <td class="wd">${imgCell}</td>
      <td class="wd" style="white-space:nowrap;">
        <div style="font-weight:var(--font-semibold);">${formatTrDate(e.tarih)}</div>
        <div style="font-size:var(--text-xs);color:var(--text-muted);">${e.birimTuru || ""}</div>
        ${e.permitNo ? `<div style="font-size:var(--text-xs);color:var(--text-muted);">🔖 ${e.permitNo}</div>` : ""}
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
        ${expired ? `<div style="font-size:var(--text-xs);color:var(--accent-danger);margin-top:4px;font-weight:var(--font-semibold);">⚠️ Süresi doldu</div>` : ""}
        ${e.kapanis_notu ? `<div style="font-size:var(--text-xs);color:var(--text-muted);margin-top:4px;">${e.kapanis_notu}</div>` : ""}
      </td>
      ${actionCell}
    </tr>`;
}

function buildWeeklyTable(entries) {
  const rows = entries.map(e => `
    <tr>
      <td class="wd">
        ${e.gorselUrl
          ? `<a href="${e.gorselUrl}" target="_blank" rel="noopener"><img src="${e.gorselUrl}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;background:var(--bg-surface-2);" onerror="this.outerHTML='<span style=\\'color:var(--text-muted);font-size:1.4rem;\\'>📷</span>'"/></a>`
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
          <option value="Taslak"        ${normalizeStatus(e.durum) === "Taslak"       ? "selected" : ""}>📝 Taslak</option>
          <option value="Aktif"         ${normalizeStatus(e.durum) === "Aktif"        ? "selected" : ""}>🟢 Aktif</option>
          <option value="Kapatıldı"     ${normalizeStatus(e.durum) === "Kapatıldı"    ? "selected" : ""}>✅ Kapatıldı</option>
          <option value="İptal Edildi"  ${normalizeStatus(e.durum) === "İptal Edildi" ? "selected" : ""}>🚫 İptal Edildi</option>
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
  const durum        = document.getElementById(`wstatus_${id}`)?.value || "Taslak";
  const kapanis_notu = document.getElementById(`wnote_${id}`)?.value?.trim() || "";
  const entry = allEntries.find(e => e.id === id);

  // PTW disiplini: hızlı haftalık güncelleme de aynı kurala tabidir —
  // aksi halde onay/kapanış zorunluluğu bu ekrandan bypass edilebilirdi.
  if (durum === "Aktif" && !(entry?.izniVerenOnay && entry?.izinAlanOnay)) {
    showToast("İzni Aktif yapmak için hem İzni Veren hem İzni Alan onayı gerekir (Düzenle ekranından onaylayın).", "error");
    return;
  }
  if ((durum === "Kapatıldı" || durum === "Askıya Alındı") && !kapanis_notu) {
    showToast(durum === "Askıya Alındı" ? "Askıya almak için durum notu gereklidir." : "Kapatmak için durum notu gereklidir.", "error");
    return;
  }
  try {
    const historyEntries = buildHistoryEntries(entry, { durum, kapanis_notu, gecerlilikBitis: entry?.gecerlilikBitis }, false);
    const history = appendHistory(entry, historyEntries);
    await updateDoc(doc(db, COLLECTION, id), { durum, kapanis_notu, history, reminderSent: false, updatedAt: serverTimestamp() });
    const idx = allEntries.findIndex(e => e.id === id);
    if (idx !== -1) {
      allEntries[idx].durum        = durum;
      allEntries[idx].kapanis_notu = kapanis_notu;
      allEntries[idx].history      = history;
    }
    persistCache();   // cache'i anında güncelle
    updateStats();
    showToast("Durum güncellendi ✅", "success");
  } catch (err) {
    // DÜZELTME: Yetki kuralları (Firestore Rules) için özel hata yakalama
    let msg = err.message;
    if (msg.includes("permission-denied") || msg.includes("insufficient permissions") || msg.includes("Missing or insufficient")) {
      msg = "Bu işlemi yapmak için yetkiniz bulunmuyor (Saha Şefi veya Admin yetkisi gerekebilir).";
    }
    showToast("Hata: " + msg, "error");
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
  document.getElementById("sendPermitMailBtn").classList.add("hidden");
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
  document.getElementById("sendPermitMailBtn").classList.remove("hidden");
  document.getElementById("entryModal").style.display = "flex";
};

function renderChecklist(izinTuru, savedChecklist) {
  const group = document.getElementById("checklistGroup");
  const container = document.getElementById("checklistContainer");
  const template = CHECKLISTS[izinTuru] || [];

  if (!template.length) {
    group.style.display = "none";
    container.innerHTML = "";
    return;
  }
  group.style.display = "block";

  // Kaydedilmiş bir checklist varsa (düzenleme) ve AYNI izin türüne aitse
  // (metin listesi eşleşiyorsa) işaretli durumları koru; aksi halde şablondan
  // sıfırdan üret (izin türü değiştiyse eski checklist artık geçersizdir).
  const sameTemplate = Array.isArray(savedChecklist) &&
    savedChecklist.length === template.length &&
    savedChecklist.every((item, i) => item.text === template[i]);

  const items = sameTemplate
    ? savedChecklist
    : template.map(text => ({ text, checked: false }));

  container.innerHTML = items.map((item, i) => `
    <label style="display:flex;align-items:flex-start;gap:8px;font-size:var(--text-sm);cursor:pointer;">
      <input type="checkbox" class="ptw-check" data-idx="${i}" ${item.checked ? "checked" : ""} style="width:16px;height:16px;margin-top:2px;flex-shrink:0;" />
      <span>${item.text}</span>
    </label>`).join("");
}

function readChecklistFromForm(izinTuru) {
  const template = CHECKLISTS[izinTuru] || [];
  if (!template.length) return [];
  const checks = document.querySelectorAll("#checklistContainer .ptw-check");
  return template.map((text, i) => ({
    text,
    checked: checks[i] ? checks[i].checked : false
  }));
}

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
  document.getElementById("eDurum").value      = e?.durum ? normalizeStatus(e.durum) : "Taslak";
  document.getElementById("eKapanis").value    = e?.kapanis_notu || "";
  document.getElementById("eGorsel").value     = "";

  // PTW alanları
  document.getElementById("eGecerlilikBaslangic").value = e?.gecerlilikBaslangic || "";
  document.getElementById("eGecerlilikBitis").value     = e?.gecerlilikBitis     || "";
  document.getElementById("eIzniVerenAd").value    = e?.izniVerenAd  || "";
  document.getElementById("eIzniVerenOnay").checked = !!e?.izniVerenOnay;
  document.getElementById("eIzniAlanAd").value     = e?.izniAlanAd   || "";
  document.getElementById("eIzniAlanOnay").checked  = !!e?.izniAlanOnay;
  renderChecklist(e?.izinTuru || "izin_yok", e?.checklist);

  const permitBanner = document.getElementById("permitNoBanner");
  if (e?.permitNo) {
    permitBanner.style.display = "flex";
    document.getElementById("permitNoText").textContent = e.permitNo;
  } else {
    permitBanner.style.display = "none";
  }

  const historyDetails = document.getElementById("historyDetails");
  const historyList    = document.getElementById("historyList");
  const history = Array.isArray(e?.history) ? e.history : [];
  if (history.length) {
    historyDetails.style.display = "block";
    historyList.innerHTML = history.slice().reverse().map(h => `
      <div style="border-bottom:1px solid var(--border-subtle);padding-bottom:4px;">
        <div style="font-weight:var(--font-semibold);">${escHtml(h.action)}</div>
        <div style="color:var(--text-muted);">${h.ts ? new Date(h.ts).toLocaleString("tr-TR") : ""} — ${escHtml(h.actor || "")}</div>
      </div>`).join("");
  } else {
    historyDetails.style.display = "none";
    historyList.innerHTML = "";
  }

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

  // PTW alanları
  const gecerlilikBaslangic = document.getElementById("eGecerlilikBaslangic").value;
  const gecerlilikBitis     = document.getElementById("eGecerlilikBitis").value;
  const izniVerenAd    = document.getElementById("eIzniVerenAd").value.trim();
  const izniVerenOnay  = document.getElementById("eIzniVerenOnay").checked;
  const izniAlanAd     = document.getElementById("eIzniAlanAd").value.trim();
  const izinAlanOnay   = document.getElementById("eIzniAlanOnay").checked;
  const checklist      = readChecklistFromForm(izinTuru);

  if (!tarih || !firma || !proje || !detay) {
    showFormError("Tarih, firma, proje ve detay alanları zorunludur.");
    return;
  }

  const existing = editingId ? allEntries.find(e => e.id === editingId) : null;

  // PTW: geçerlilik bitişini değiştirmek (süre uzatma) dünyadaki
  // Permit-to-Work sistemlerinde yeniden onay gerektirir — mevcut onaylar
  // sessizce miras kalamaz, gönderilen checkbox durumu ne olursa olsun
  // sıfırlanır ve aşağıdaki "Aktif" kuralı kullanıcıyı yeniden onaylamaya
  // zorlar.
  const wasLive = existing && ["Aktif", "Askıya Alındı"].includes(normalizeStatus(existing.durum));
  const extended = !!(existing && wasLive && (existing.gecerlilikBitis || "") !== (gecerlilikBitis || ""));
  const finalIzniVerenOnay = extended ? false : izniVerenOnay;
  const finalIzinAlanOnay  = extended ? false : izinAlanOnay;

  // PTW disiplini: dünyadaki Permit-to-Work sistemlerinde olduğu gibi bir
  // izin, hem izni veren hem izni alan onaylamadan "Aktif" olamaz; durum
  // notu girilmeden "Kapatıldı" veya "Askıya Alındı" olamaz.
  if (durum === "Aktif" && !(finalIzniVerenOnay && finalIzinAlanOnay)) {
    showFormError(extended
      ? "Geçerlilik süresi değiştirildiği için onaylar sıfırlandı — izni Aktif yapmadan önce her iki onay kutusunu yeniden işaretleyin."
      : "İzni Aktif yapmak için hem İzni Veren hem İzni Alan onay kutusu işaretlenmelidir.");
    return;
  }
  if ((durum === "Kapatıldı" || durum === "Askıya Alındı") && !kapanis_notu) {
    showFormError(durum === "Askıya Alındı"
      ? "İzni askıya almak için Durum Notu (askıya alma nedeni) zorunludur."
      : "İzni kapatmak için Durum Notu zorunludur.");
    return;
  }

  const saveBtn = document.getElementById("saveEntryBtn");
  saveBtn.disabled = true; saveBtn.textContent = "⏳ Kaydediliyor…";

  try {
    let gorselUrl = existing?.gorselUrl ?? null;

    if (gorselFile) gorselUrl = await uploadImage(gorselFile);

    const data = {
      userId: currentUser.uid,
      tarih, birimTuru, firma, sorumlu,
      blok, kat, alan, depo,
      proje, izinTuru, detay, durum, kapanis_notu,
      gorselUrl: gorselUrl || null,
      gecerlilikBaslangic: gecerlilikBaslangic || null,
      gecerlilikBitis:     gecerlilikBitis     || null,
      izniVerenAd, izniVerenOnay: finalIzniVerenOnay,
      izniAlanAd, izinAlanOnay: finalIzinAlanOnay,
      checklist,
      // İzin numarası ASLA yeniden üretilmez — ilk oluşturmada atanır ve sabit kalır.
      permitNo: existing?.permitNo || generatePermitNo(),
      // Her kayıt işlemi "taze bir inceleme" sayılır — süre sonu hatırlatma
      // cron'unun (cron_permit_reminders.php) bu izin için tekrar mail
      // gönderebilmesi adına bayrak sıfırlanır (bkz. o dosyadaki mantık).
      reminderSent: false,
      updatedAt: serverTimestamp()
    };
    data.history = appendHistory(existing, buildHistoryEntries(existing, data, extended));

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

    persistCache();   // cache'i anında güncelle
    buildSuggestions();
    updateStats();
    closeEntryModal();
    renderCurrentTab();
  } catch (err) {
    let msg = err.message;
    if (msg.includes("permission-denied") || msg.includes("insufficient permissions") || msg.includes("Missing or insufficient")) {
      msg = "Bu işlemi yapmak veya durumu değiştirmek için yetkiniz bulunmuyor.";
    }
    showFormError("Hata: " + msg);
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
    persistCache();   // cache'i anında güncelle
    updateStats();
    renderCurrentTab();
    showToast("Kayıt silindi.", "success");
    if (editingId === id) closeEntryModal();
  } catch (err) {
    let msg = err.message;
    if (msg.includes("permission-denied") || msg.includes("insufficient permissions") || msg.includes("Missing or insufficient")) {
      msg = "Sadece Adminler kayıt silebilir (Yetki Hatası).";
    }
    showToast("Silinemedi: " + msg, "error");
  }
};

// ═══════════════════════════════════════════════
// BUGÜNE KOPYALA
// ═══════════════════════════════════════════════
window.duplicateEntry = function (id) {
  const e = allEntries.find(e => e.id === id);
  if (!e) return;
  openEditModal(id);
  document.getElementById("eTarih").value   = todayStr();
  document.getElementById("eDurum").value   = "Taslak";
  document.getElementById("eKapanis").value = "";
  // PTW: kopyalanan kayıt YENİ bir izindir — eski onaylar/geçerlilik/izin
  // numarası bu yeni izne miras kalamaz, sıfırdan başlamalıdır.
  document.getElementById("eGecerlilikBaslangic").value = "";
  document.getElementById("eGecerlilikBitis").value     = "";
  document.getElementById("eIzniVerenOnay").checked = false;
  document.getElementById("eIzniAlanOnay").checked  = false;
  document.getElementById("permitNoBanner").style.display = "none";
  document.getElementById("historyDetails").style.display = "none";
  document.getElementById("historyList").innerHTML = "";
  renderChecklist(document.getElementById("eIzinTuru").value, null);
  document.getElementById("entryModalTitle").textContent = "Yeni Kayıt (Kopyalandı)";
  document.getElementById("deleteEntryBtn").classList.add("hidden");
  document.getElementById("sendPermitMailBtn").classList.add("hidden");
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
      } catch (err) {
        // DÜZELTME: Blob (geçici URL) oluşturmak yerine doğrudan hata fırlatıyoruz.
        // Böylece veritabanına bozuk "blob:" linkleri kaydedilmemiş olacak.
        reject(new Error("Görsel sunucuya yüklenemedi. Sunucu bağlantısını veya PHP dosyasını kontrol edin."));
      }
    }, "image/jpeg", 0.75);
  });
}

// ═══════════════════════════════════════════════
// QR KOD (sahada izin doğrulama)
// ═══════════════════════════════════════════════
window.showQrModal = async function () {
  const e = editingId ? allEntries.find(x => x.id === editingId) : null;
  if (!e?.permitNo) { showToast("Önce kaydı kaydedin.", "warning"); return; }

  // Lazy: qrcodejs yalnızca butona basıldığında yüklenir (projede
  // ekipman-qr-basim.html'de kullanılan aynı kütüphane — tutarlılık için).
  if (typeof QRCode === "undefined" && window.loadScript) {
    try {
      await window.loadScript("https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js");
    } catch (err) { console.warn("[is-izni] QRCode kütüphanesi yüklenemedi:", err); }
  }
  if (typeof QRCode === "undefined") {
    showToast("QR kütüphanesi yüklenemedi.", "error");
    return;
  }

  const verifyUrl = `${location.origin}${location.pathname.replace(/is-izni\.html$/, "izin-dogrula.html")}?no=${encodeURIComponent(e.permitNo)}`;
  const holder = document.getElementById("qrHolder");
  holder.innerHTML = "";
  new QRCode(holder, { text: verifyUrl, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });

  const link = document.getElementById("qrLink");
  link.href = verifyUrl;
  link.textContent = verifyUrl;

  document.getElementById("qrModal").style.display = "flex";
};

window.closeQrModal = function () {
  document.getElementById("qrModal").style.display = "none";
};

// ═══════════════════════════════════════════════
// EXCEL EXPORT
// ═══════════════════════════════════════════════
window.exportExcel = async function () {
  if (!allEntries.length) { showToast("Aktarılacak veri yok.", "warning"); return; }
  // Lazy: SheetJS yalnızca Excel butonuna basıldığında yüklenir
  if (typeof XLSX === 'undefined' && window.loadScript) {
    try {
      await window.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    } catch (e) { console.warn('[is-izni] SheetJS lazy load hatası:', e); }
  }
  if (typeof XLSX === 'undefined') {
    showToast('Excel kütüphanesi yüklenemedi.', 'error'); return;
  }

  const rows = allEntries.map(e => {
    const checklist = Array.isArray(e.checklist) ? e.checklist : [];
    const checklistSummary = checklist.length
      ? `${checklist.filter(c => c.checked).length}/${checklist.length} tamamlandı`
      : "—";
    return {
      "İzin No":              e.permitNo    || "",
      "Tarih":                e.tarih       || "",
      "Birim Türü":           e.birimTuru   || "",
      "Firma":                e.firma       || "",
      "Sorumlu":              e.sorumlu     || "",
      "Blok":                 e.blok        || "",
      "Kat":                  e.kat         || "",
      "Alan":                 e.alan        || "",
      "Depo":                 e.depo        || "",
      "Proje":                e.proje       || "",
      "İş İzni":              IZIN_TURLERI[e.izinTuru] || e.izinTuru || "",
      "İş Detayı":            e.detay       || "",
      "Geçerlilik Başlangıç": e.gecerlilikBaslangic ? new Date(e.gecerlilikBaslangic).toLocaleString("tr-TR") : "",
      "Geçerlilik Bitiş":     e.gecerlilikBitis     ? new Date(e.gecerlilikBitis).toLocaleString("tr-TR")     : "",
      "İzni Veren":           e.izniVerenAd || "",
      "İzni Veren Onay":      e.izniVerenOnay ? "Evet" : "Hayır",
      "İzni Alan":            e.izniAlanAd  || "",
      "İzni Alan Onay":       e.izinAlanOnay ? "Evet" : "Hayır",
      "Checklist Durumu":     checklistSummary,
      "Durum":                e.durum       || "",
      "Kapanış Notu":         e.kapanis_notu || "",
      "Görsel URL":           e.gorselUrl   || "",
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    {wch:16},{wch:12},{wch:16},{wch:20},{wch:20},{wch:10},{wch:8},
    {wch:14},{wch:16},{wch:28},{wch:22},{wch:35},{wch:18},{wch:18},
    {wch:18},{wch:14},{wch:18},{wch:14},{wch:18},{wch:14},{wch:25},{wch:30}
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "İş Takip");
  XLSX.writeFile(wb, `Is_Takip_${todayStr()}.xlsx`);
  showToast("Excel dosyası indirildi ✅", "success");
};

// ═══════════════════════════════════════════════
// MAİL GÖNDER (gerçek SMTP — bkz. send_report_mail.php)
// ═══════════════════════════════════════════════
function escHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function buildPermitMailHtml(e) {
  const izinLabel = IZIN_TURLERI[e.izinTuru] || e.izinTuru || "—";
  const checklistHtml = (e.checklist || []).length
    ? `<ul style="margin:0;padding-left:20px;color:#334155;">${e.checklist.map(c =>
        `<li>${c.checked ? "☑" : "☐"} ${escHtml(c.text)}</li>`).join("")}</ul>`
    : `<div style="color:#64748b;font-style:italic;">Bu izin türü için checklist yok.</div>`;
  const brandLogo = settings.logoUrl
    ? `<img src="${escHtml(settings.logoUrl)}" alt="logo" style="height:32px;max-width:160px;object-fit:contain;margin-bottom:8px;display:block;" />`
    : "";
  const brandSubtitle = settings.companyName ? escHtml(settings.companyName) : "İş İzni Takip Sistemi";
  const signatureRow = settings.signature
    ? `<tr><td style="padding:16px 30px;border-top:1px solid #e2e8f0;"><p style="white-space:pre-wrap;color:#64748b;font-size:10px;margin:0;">${escHtml(settings.signature)}</p></td></tr>`
    : "";

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#1e293b;max-width:800px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;width:100%;">
        <tbody>
          <tr>
            <td style="background:#234383;padding:24px 30px;">
              ${brandLogo}
              <div style="font-size:20px;font-weight:bold;color:#fff;">🔖 İŞ İZNİ — ${escHtml(e.permitNo || "")}</div>
              <div style="font-size:13px;color:#cbd5e1;margin-top:6px;">${brandSubtitle}</div>
            </td>
          </tr>
          <tr><td style="height:4px;background:#ea580c;line-height:4px;font-size:4px;">&nbsp;</td></tr>
          <tr>
            <td style="padding:30px;">
              <table width="100%" cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#e2e8f0;margin-bottom:20px;">
                <tbody>
                  <tr style="background:#fff;">
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">Tarih</td>
                    <td style="color:#1e293b;font-weight:bold;">${formatTrDate(e.tarih)}</td>
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">Durum</td>
                    <td style="color:#1e293b;font-weight:bold;">${escHtml(e.durum || "—")}</td>
                  </tr>
                  <tr style="background:#f8fafc;">
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">Firma</td>
                    <td style="color:#1e293b;">${escHtml(e.firma || "—")}</td>
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">Sorumlu</td>
                    <td style="color:#1e293b;">${escHtml(e.sorumlu || "—")}</td>
                  </tr>
                  <tr style="background:#fff;">
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">Lokasyon</td>
                    <td style="color:#1e293b;">${escHtml([e.blok, e.kat, e.alan].filter(Boolean).join(" / ") || "—")}</td>
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">İzin Kapsamı</td>
                    <td style="color:#1e293b;">${escHtml(izinLabel)}</td>
                  </tr>
                  <tr style="background:#f8fafc;">
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">Geçerlilik</td>
                    <td colspan="3" style="color:#1e293b;">${e.gecerlilikBaslangic ? new Date(e.gecerlilikBaslangic).toLocaleString("tr-TR") : "—"} → ${e.gecerlilikBitis ? new Date(e.gecerlilikBitis).toLocaleString("tr-TR") : "—"}</td>
                  </tr>
                  <tr style="background:#fff;">
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">İzni Veren</td>
                    <td style="color:#1e293b;">${escHtml(e.izniVerenAd || "—")} ${e.izniVerenOnay ? "✅" : "⏳"}</td>
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">İzni Alan</td>
                    <td style="color:#1e293b;">${escHtml(e.izniAlanAd || "—")} ${e.izinAlanOnay ? "✅" : "⏳"}</td>
                  </tr>
                </tbody>
              </table>
              <div style="font-weight:bold;color:#fff;background:#234383;padding:10px 14px;border-radius:4px;margin-bottom:12px;">📋 Yapılan İş</div>
              <p style="color:#334155;white-space:pre-wrap;margin:0 0 20px 0;">${escHtml(e.detay || "—")}</p>
              <div style="font-weight:bold;color:#fff;background:#234383;padding:10px 14px;border-radius:4px;margin-bottom:12px;">☑️ Tehlike Kontrol Listesi</div>
              ${checklistHtml}
              ${e.kapanis_notu ? `<div style="margin-top:20px;"><div style="font-weight:bold;color:#fff;background:#234383;padding:10px 14px;border-radius:4px;margin-bottom:12px;">🔒 Kapanış Notu</div><p style="color:#334155;white-space:pre-wrap;margin:0;">${escHtml(e.kapanis_notu)}</p></div>` : ""}
            </td>
          </tr>
          ${signatureRow}
          <tr>
            <td style="background:#234383;padding:16px;text-align:center;font-size:10px;color:#cbd5e1;">
              Bu izin ozisg.com İş İzni Takip Aracı ile oluşturulmuştur.
            </td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

window.sendPermitMail = async function (id) {
  const targetId = id || editingId;
  const e = allEntries.find(x => x.id === targetId);
  if (!e) { showToast("Önce kaydı kaydedin, sonra gönderin.", "warning"); return; }

  if (!settings.mailRecipients.length) {
    showToast("Önce Ayarlar sekmesinden mail dağıtım listesi tanımlayın.", "warning");
    switchTab("settings");
    return;
  }

  const btn = document.getElementById("sendPermitMailBtn");
  const wasBtn = btn && !id; // sadece modal içinden çağrıldıysa buton state'i güncelle
  if (wasBtn) { btn.disabled = true; btn.textContent = "⏳ Gönderiliyor…"; }

  try {
    const res = await fetch("../send_report_mail.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: settings.mailRecipients,
        subject: `İş İzni — ${e.permitNo || ""} — ${e.firma || ""}`,
        htmlBody: buildPermitMailHtml(e)
      })
    });
    const data = await res.json();
    if (data.status === "success") {
      showToast(`Mail gönderildi ✅ (${settings.mailRecipients.length} alıcı)`, "success");
    } else {
      throw new Error(data.message || "Bilinmeyen hata");
    }
  } catch (err) {
    showToast("Mail gönderilemedi: " + err.message, "error");
  } finally {
    if (wasBtn) { btn.disabled = false; btn.textContent = "📧 Gönder"; }
  }
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
  document.getElementById("sendPermitMailBtn")?.addEventListener("click", () => sendPermitMail(null));
  document.getElementById("showQrBtn")?.addEventListener("click", showQrModal);
  document.getElementById("qrModal")?.addEventListener("click", e => {
    if (e.target === document.getElementById("qrModal")) closeQrModal();
  });
  document.getElementById("saveSettingsBtn")?.addEventListener("click", saveSettings);
  document.getElementById("eIzinTuru")?.addEventListener("change", (e) => renderChecklist(e.target.value, null));

  document.getElementById("entryModal")?.addEventListener("click", e => {
    if (e.target === document.getElementById("entryModal")) closeEntryModal();
  });

  document.getElementById("eGorsel")?.addEventListener("change", e => {
    const file = e.target.files?.[0];
    const prev = document.getElementById("gorselPreview");
    if (file) { prev.src = URL.createObjectURL(file); prev.style.display = "block"; }
    else { prev.style.display = "none"; }
  });

  document.getElementById("gotoTodayBtn")?.addEventListener("click", () => {
    document.getElementById("dailyDate").value = todayStr();
    renderDailyTab();
  });

  document.getElementById("dailyDate")?.addEventListener("change",  () => renderDailyTab());
  document.getElementById("dailySearch")?.addEventListener("input", () => renderDailyTab());

  document.getElementById("weeklyFilterStatus")?.addEventListener("change", () => renderWeeklyTab());
  document.getElementById("weeklySearch")?.addEventListener("input", () => renderWeeklyTab());

  document.getElementById("archStart")?.addEventListener("change",  () => renderArchiveTab());
  document.getElementById("archEnd")?.addEventListener("change",    () => renderArchiveTab());
  document.getElementById("archSearch")?.addEventListener("input",  () => renderArchiveTab());
}