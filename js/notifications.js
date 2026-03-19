/**
 * notifications.js — Bildirim Sistemi
 * ─────────────────────────────────────────────
 * - Navbar'a zil ikonu + okunmamış rozeti enjekte eder
 * - Kullanıcı bildirimlerini Firestore'dan yükler
 * - Bildirimleri okundu olarak işaretler
 * - Admin tarafından çağrılacak writeNotification() fonksiyonunu dışa aktarır
 */

import { db } from "./firebase-config.js";
import {
  collection, query, where, orderBy, limit,
  getDocs, updateDoc, addDoc, doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let _userId      = null;
let _unreadCount = 0;

// ══════════════════════════════════════════════
// BAŞLAT — Auth çözümlendikten sonra çağrılır
// ══════════════════════════════════════════════
export async function initNotifications(userId) {
  _userId = userId;
  injectBellButton();
  await refreshUnreadCount();
}

// ══════════════════════════════════════════════
// BİLDİRİM YAZ — Admin tarafından çağrılır
// ══════════════════════════════════════════════
export async function writeNotification(userId, type, title, message) {
  if (!userId) return;
  try {
    await addDoc(collection(db, "notifications"), {
      userId, type, title, message,
      read: false,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.warn("Bildirim yazılamadı:", err.message);
  }
}

// ══════════════════════════════════════════════
// ZİL BUTONU ENJEKSİYONU
// ══════════════════════════════════════════════
function injectBellButton() {
  const actions = document.querySelector(".navbar-actions");
  if (!actions || actions.querySelector("#notifBtn")) return;

  const wrapper = document.createElement("div");
  wrapper.className = "notif-bell-wrapper";
  wrapper.style.cssText = "position:relative;flex-shrink:0;";
  wrapper.innerHTML = `
    <button id="notifBtn" aria-label="Bildirimler" title="Bildirimler"
      style="width:36px;height:36px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.15);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1rem;cursor:pointer;position:relative;transition:background .15s;">
      🔔
      <span id="notifBadge" style="display:none;position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;background:#ef4444;color:#fff;border-radius:9999px;font-size:10px;font-weight:700;align-items:center;justify-content:center;padding:0 4px;border:2px solid #0a1628;">0</span>
    </button>
  `;

  // Tema toggle'dan önce ekle
  const themeToggle = actions.querySelector(".theme-toggle");
  if (themeToggle) {
    actions.insertBefore(wrapper, themeToggle);
  } else {
    actions.prepend(wrapper);
  }

  wrapper.querySelector("#notifBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleNotifPanel();
  });

  // Panel dışına tıklayınca kapat
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("notifPanel");
    if (panel && !panel.contains(e.target) && e.target.id !== "notifBtn") {
      panel.remove();
    }
  });
}

// ══════════════════════════════════════════════
// OKUNMAMIŞ SAYISI GÜNCELLE
// ══════════════════════════════════════════════
async function refreshUnreadCount() {
  if (!_userId) return;
  try {
    const q = query(
      collection(db, "notifications"),
      where("userId", "==", _userId),
      where("read", "==", false)
    );
    const snap = await getDocs(q);
    _unreadCount = snap.docs.length;
    updateBadge();
  } catch { /* sessizce geç */ }
}

function updateBadge() {
  const badge = document.getElementById("notifBadge");
  if (!badge) return;
  badge.textContent = _unreadCount > 9 ? "9+" : String(_unreadCount);
  badge.style.display = _unreadCount === 0 ? "none" : "flex";
}

// ══════════════════════════════════════════════
// BİLDİRİM PANELİ
// ══════════════════════════════════════════════
async function toggleNotifPanel() {
  const existing = document.getElementById("notifPanel");
  if (existing) { existing.remove(); return; }

  const btn = document.getElementById("notifBtn");
  if (!btn) return;

  const panel = document.createElement("div");
  panel.id        = "notifPanel";
  panel.className = "notif-panel";
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border-color,#e2e8f0);background:var(--bg-surface-2,#f8fafc);flex-shrink:0;">
      <span style="font-weight:600;font-size:0.875rem;color:var(--text-primary,#0a1628);">Bildirimler</span>
      <button id="markAllReadBtn" style="font-size:11px;padding:3px 10px;background:none;border:1px solid var(--border-color,#e2e8f0);border-radius:6px;cursor:pointer;color:var(--text-muted,#64748b);">
        Tümünü Oku
      </button>
    </div>
    <div id="notifList" style="overflow-y:auto;flex:1;">
      <div style="text-align:center;padding:1.5rem;">
        <div style="width:28px;height:28px;border:3px solid #e2e8f0;border-top-color:#2e6cd1;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // Pozisyonla — CSS'e bağımlı olmayan satır içi z-index
  const rect = btn.getBoundingClientRect();
  Object.assign(panel.style, {
    position:   "fixed",
    top:        (rect.bottom + 8) + "px",
    right:      (window.innerWidth - rect.right) + "px",
    zIndex:     "9999",
    background: "var(--bg-surface, #fff)",
    border:     "1px solid var(--border-color, #e2e8f0)",
    boxShadow:  "0 8px 40px rgba(10,22,40,0.18)",
    borderRadius: "12px",
    width:      "340px",
    maxHeight:  "480px",
    display:    "flex",
    flexDirection: "column",
    overflow:   "hidden",
  });

  document.getElementById("markAllReadBtn").addEventListener("click", markAllRead);
  await loadNotifications();
}

async function loadNotifications() {
  const list = document.getElementById("notifList");
  if (!list || !_userId) return;

  try {
    const q = query(
      collection(db, "notifications"),
      where("userId", "==", _userId),
      orderBy("createdAt", "desc"),
      limit(25)
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      list.innerHTML = `<div style="text-align:center;padding:2.5rem 1rem;color:var(--text-muted,#64748b);font-size:0.875rem;">🔔 Henüz bildirim yok.</div>`;
      return;
    }

    list.innerHTML = snap.docs.map(d => {
      const n       = d.data();
      const dateStr = n.createdAt?.toDate
        ? n.createdAt.toDate().toLocaleDateString("tr-TR", { day:"2-digit", month:"short", year:"numeric" })
        : "";
      const unreadBg = n.read ? "" : "background:rgba(46,108,209,0.06);";
      return `
        <div data-id="${d.id}" data-read="${n.read}"
          style="display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border-subtle,#f1f5f9);cursor:pointer;${unreadBg}transition:background .15s;">
          <div style="font-size:1.2rem;flex-shrink:0;margin-top:2px;">${notifIcon(n.type)}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.875rem;font-weight:600;color:var(--text-primary,#0a1628);margin-bottom:3px;">${esc(n.title)}</div>
            <div style="font-size:0.75rem;color:var(--text-muted,#64748b);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(n.message)}</div>
            <div style="font-size:10px;color:var(--text-light,#94a3b8);margin-top:4px;">${dateStr}</div>
          </div>
          ${!n.read ? '<div style="width:8px;height:8px;background:#2e6cd1;border-radius:50%;flex-shrink:0;margin-top:6px;"></div>' : ""}
        </div>
      `;
    }).join("");

    // Tüm itemlara tıklama — okunmamışsa okundu yap
    list.querySelectorAll("[data-id]").forEach(item => {
      item.addEventListener("click", () => {
        if (item.dataset.read === "false") markRead(item.dataset.id, item);
      });
    });
  } catch (err) {
    list.innerHTML = `<div style="text-align:center;padding:2rem;color:#ef4444;font-size:0.875rem;">Bildirimler yüklenemedi.</div>`;
  }
}

async function markRead(notifId, element) {
  try {
    await updateDoc(doc(db, "notifications", notifId), { read: true });
    element.dataset.read = "true";
    element.style.background = "";
    // Mavi noktayı kaldır
    const dot = element.querySelector("[style*='border-radius:50%']");
    dot?.remove();
    _unreadCount = Math.max(0, _unreadCount - 1);
    updateBadge();
  } catch { /* sessizce geç */ }
}

async function markAllRead() {
  if (!_userId) return;
  try {
    const q = query(
      collection(db, "notifications"),
      where("userId", "==", _userId),
      where("read", "==", false)
    );
    const snap = await getDocs(q);
    await Promise.all(snap.docs.map(d =>
      updateDoc(doc(db, "notifications", d.id), { read: true })
    ));
    _unreadCount = 0;
    updateBadge();
    document.querySelectorAll("#notifList [data-id]").forEach(el => {
      el.dataset.read = "true";
      el.style.background = "";
    });
  } catch { /* sessizce geç */ }
}

// ══════════════════════════════════════════════
// YARDIMCILAR
// ══════════════════════════════════════════════
function notifIcon(type) {
  const map = {
    account_approved:   "✅",
    account_rejected:   "❌",
    post_approved:      "📢",
    post_rejected:      "🚫",
    permission_granted: "🔑",
    permission_revoked: "🔒",
    info:               "ℹ️",
  };
  return map[type] || "🔔";
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// window üzerinden de erişilebilir
window.writeNotification = writeNotification;
