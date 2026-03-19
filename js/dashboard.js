/**
 * dashboard.js — Araç Paneli (Auth korumalı)
 */

import { auth, db, showToast, formatRelativeDate, checkToolAccess, getSiteConfig } from "./app.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDoc, doc as fsDoc,
  collection, query, where, orderBy, limit,
  getDocs, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── Kullanıcı rol/durum kontrolü ───
async function getUserInfo(uid) {
  try {
    const snap = await getDoc(fsDoc(db, "users", uid));
    if (!snap.exists()) return { role: "user", status: "active" };
    return snap.data();
  } catch { return { role: "user", status: "active" }; }
}

function isAdminRole(role) {
  return role === "admin" || role === "superadmin";
}

// ─── Araç kartlarına erişim kilidi/kilit açma ───
const TOOL_PERMISSION_MAP = {
  "tool-isg":    "tool_isg_reports",
  "tool-permit": "tool_work_permits",
  "tool-budget": "tool_budget",
  "tool-ptk":    "tool_ptk",
  "tool-levha":  "tool_levha",
  "tool-kroki":  "tool_kroki",
  "tool-kkd":    "tool_kkd",
};

async function applyToolAccessControl(uid, adminFlag) {
  if (adminFlag) return; // Admin her şeye erişebilir

  for (const [cardId, toolId] of Object.entries(TOOL_PERMISSION_MAP)) {
    const card = document.getElementById(cardId);
    if (!card) continue;
    const { allowed } = await checkToolAccess(uid, toolId);
    if (!allowed) {
      card.style.opacity = "0.45";
      card.style.pointerEvents = "none";
      card.style.filter = "grayscale(0.6)";
      card.style.cursor = "not-allowed";
      card.title = "Bu araca erişim izniniz bulunmamaktadır.";
      // Kilit simgesi ekle
      const metaEl = card.querySelector(".tool-meta");
      if (metaEl) {
        metaEl.innerHTML = `<span class="badge badge-danger">🔒 Erişim Yok</span>`;
      }
    }
  }
}

// ─── UI Elementleri ───
const dashboardLoading   = document.getElementById("dashboard-loading");
const dashboardContent   = document.getElementById("dashboard-content");
const authGate           = document.getElementById("auth-gate");
const dashboardUserName  = document.getElementById("dashboardUserName");
const totalRecordsEl     = document.getElementById("totalRecords");
const recentActivityList = document.getElementById("recent-activity-list");

// ─── Araç koleksiyonları ───
const TOOL_COLLECTIONS = [
  { id: "tool_isg_reports",   label: "İSG Raporu",     icon: "🛡️" },
  { id: "tool_work_permits",  label: "İş İzni",        icon: "📋" },
  { id: "tool_budget",        label: "Bütçe Kaydı",    icon: "💰" },
  { id: "tool_ptk_reports",   label: "PTK Raporu",     icon: "📊" },
  { id: "tool_levha_designs", label: "Levha Tasarımı", icon: "🪧" },
  { id: "tool_kroki_maps",    label: "Kroki",          icon: "🗺️" },
  { id: "tool_floor_plans",   label: "Kat Planı",      icon: "🏗️" },
];

onAuthStateChanged(auth, async (user) => {
  if (dashboardLoading) dashboardLoading.style.display = "none";

  if (!user) {
    if (authGate) authGate.style.display = "block";
    return;
  }

  if (dashboardContent) dashboardContent.style.display = "block";

  const displayName = user.displayName || user.email?.split("@")[0] || "Kullanıcı";
  if (dashboardUserName) dashboardUserName.textContent = displayName.split(" ")[0];

  const userInfo = await getUserInfo(user.uid);
  const role     = userInfo.role   || "user";
  const status   = userInfo.status || "active";
  const isAdm    = isAdminRole(role);

  // Onay bekleyen / erişim süresi uyarısı
  if (status === "pending") {
    showPendingBanner();
  } else if (userInfo.accessExpiry) {
    const expDate = userInfo.accessExpiry.toDate
      ? userInfo.accessExpiry.toDate()
      : new Date(userInfo.accessExpiry);
    const daysLeft = Math.ceil((expDate - new Date()) / 86400000);
    if (daysLeft < 0) {
      showExpiryBanner("❌ Hesap erişim süreniz dolmuştur. Yöneticinizle iletişime geçin.", "var(--accent-danger)");
    } else if (daysLeft <= 14) {
      showExpiryBanner(`⚠️ Hesap erişiminiz ${daysLeft} gün içinde sona eriyor (${expDate.toLocaleDateString("tr-TR")}).`, "var(--accent-warning)");
    }
  }

  // Blog editörü kartı — editör/admin/superadmin görür
  if (role === "editor" || isAdm) {
    const blogCard = document.getElementById("tool-blog-editor");
    if (blogCard) blogCard.style.display = "flex";
  }

  // Araç kartlarına erişim kontrolü uygula
  await applyToolAccessControl(user.uid, isAdm);

  // Site config'den araç kartı özelleştirmelerini uygula
  applyToolConfig();

  // Kayıt sayıları + son aktivite (paralel)
  await Promise.all([
    loadRecordCounts(user.uid),
    loadRecentActivity(user.uid)
  ]);
});

function showPendingBanner() {
  showExpiryBanner("⏳ Hesabınız admin onayı beklemektedir. Onaylandıktan sonra araçlara erişebilirsiniz.", "var(--accent-warning)");
}

function showExpiryBanner(message, bgColor) {
  const container = document.getElementById("dashboard-content");
  if (!container) return;
  const banner = document.createElement("div");
  banner.style.cssText = `background:${bgColor};color:#fff;padding:var(--space-3) var(--space-6);text-align:center;font-size:var(--text-sm);font-weight:var(--font-semibold);`;
  banner.innerHTML = message;
  container.insertAdjacentElement("afterbegin", banner);
}

// ─── Site Config: Araç Kartı Özelleştirme ───
async function applyToolConfig() {
  try {
    const cfg = await getSiteConfig();
    if (!cfg.tools?.length) return;
    const grid = document.querySelector(".tools-grid");
    if (!grid) return;

    cfg.tools.forEach(toolCfg => {
      const card = document.getElementById(toolCfg.id);
      if (!card) return;

      // Görünürlük
      if (toolCfg.visible === false) {
        card.style.display = "none";
        return;
      }

      // İkon güncelle
      if (toolCfg.icon) {
        const iconEl = card.querySelector(".tool-icon");
        if (iconEl) iconEl.textContent = toolCfg.icon;
      }

      // İsim güncelle
      if (toolCfg.label) {
        const nameEl = card.querySelector(".tool-name");
        if (nameEl) nameEl.textContent = toolCfg.label;
      }

      // Sıralama (CSS order)
      if (toolCfg.order !== undefined) {
        card.style.order = toolCfg.order;
      }
    });

    // Grid'in order çalışması için flex olması gerekiyor
    grid.style.display = "grid"; // zaten grid, order CSS grid'de de çalışır
  } catch {}
}

// ─── Kayıt Sayılarını Çek ───
async function loadRecordCounts(userId) {
  let total = 0;

  const countPromises = TOOL_COLLECTIONS.map(async ({ id }) => {
    try {
      const q = query(
        collection(db, id),
        where("userId", "==", userId)
      );
      const snapshot = await getCountFromServer(q);
      const count = snapshot.data().count;
      total += count;

      const countEls = document.querySelectorAll(`.tool-record-count[data-collection="${id}"]`);
      countEls.forEach(el => { el.textContent = `${count} kayıt`; });

      return count;
    } catch (err) {
      console.warn(`${id} sayısı alınamadı:`, err.message);
      return 0;
    }
  });

  await Promise.all(countPromises);
  if (totalRecordsEl) totalRecordsEl.textContent = total;
}

// ─── Son Aktivite ───
async function loadRecentActivity(userId) {
  if (!recentActivityList) return;

  const allDocs = [];

  const fetchPromises = TOOL_COLLECTIONS.map(async ({ id, label, icon }) => {
    try {
      const q = query(
        collection(db, id),
        where("userId", "==", userId),
        orderBy("createdAt", "desc"),
        limit(3)
      );
      const snap = await getDocs(q);
      snap.docs.forEach(d => {
        allDocs.push({ id: d.id, collection: id, label, icon, data: d.data() });
      });
    } catch (err) {
      console.warn(`${id} aktivite alınamadı:`, err.message);
    }
  });

  await Promise.all(fetchPromises);

  // Tarihe göre sırala (en yeni önce)
  allDocs.sort((a, b) => {
    const ta = a.data.createdAt?.seconds || 0;
    const tb = b.data.createdAt?.seconds || 0;
    return tb - ta;
  });

  const recent = allDocs.slice(0, 10);

  if (recent.length === 0) {
    recentActivityList.innerHTML = `
      <div style="text-align:center; padding: var(--space-8); color:var(--text-muted);">
        <div style="font-size:2.5rem; margin-bottom:var(--space-4);">📂</div>
        <p>Henüz hiç kayıt oluşturmadınız.</p>
        <p style="font-size:var(--text-sm);">Yukarıdaki araçlardan birini kullanarak başlayın.</p>
      </div>`;
    return;
  }

  recentActivityList.innerHTML = recent.map(item => `
    <div style="display:flex; align-items:center; gap:var(--space-4); padding:var(--space-3) 0; border-bottom:1px solid var(--border-subtle);">
      <div style="width:40px; height:40px; background:var(--bg-surface-3); border-radius:var(--border-radius); display:flex; align-items:center; justify-content:center; font-size:1.2rem; flex-shrink:0;">
        ${item.icon}
      </div>
      <div style="flex:1; min-width:0;">
        <div style="font-weight:var(--font-semibold); font-size:var(--text-sm); color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${item.data.title || item.data.description || item.data.date || "Kayıt"}
        </div>
        <div style="font-size:var(--text-xs); color:var(--text-muted);">
          ${item.label}
        </div>
      </div>
      <div style="font-size:var(--text-xs); color:var(--text-muted); flex-shrink:0;">
        ${formatRelativeDate(item.data.createdAt)}
      </div>
    </div>
  `).join("");
}
