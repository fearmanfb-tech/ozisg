/**
 * app.js — Ana Uygulama Katmanı
 * ─────────────────────────────────────────────
 * Her sayfada yüklenir. Sorumluluklar:
 *   1. Dark Mode: tercih yükleme / kaydetme / toggle
 *   2. Hamburger menü
 *   3. Firebase Auth dinleyicisi → navbar güncelleme
 *   4. Çıkış yapma
 *   5. Toast bildirimleri
 *   6. Global yardımcılar (exportlar)
 */

import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
  GoogleAuthProvider,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { initNotifications } from "./notifications.js";

// ═══════════════════════════════════════════════
// 1. DARK MODE
// ═══════════════════════════════════════════════
const THEME_KEY = "ozisg_theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(saved || preferred);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
}

// Tema başlatma (DOM'dan önce çalışsın diye hem burada hem de inline script önerilir)
initTheme();

// Toggle butonu
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("themeToggle");
  if (btn) btn.addEventListener("click", toggleTheme);
});

// ═══════════════════════════════════════════════
// 2. HAMBURGER MENÜ
// ═══════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  const hamburger = document.getElementById("hamburger");
  const mobileNav = document.getElementById("mobileNav");

  if (hamburger && mobileNav) {
    hamburger.addEventListener("click", () => {
      const isOpen = mobileNav.classList.toggle("open");
      hamburger.classList.toggle("open", isOpen);
      hamburger.setAttribute("aria-expanded", isOpen);
    });

    // Dışarı tıklayınca kapat
    document.addEventListener("click", (e) => {
      if (!hamburger.contains(e.target) && !mobileNav.contains(e.target)) {
        mobileNav.classList.remove("open");
        hamburger.classList.remove("open");
      }
    });
  }

  // User dropdown
  const userMenuBtn = document.getElementById("userMenuBtn");
  const userDropdown = document.getElementById("userDropdown");
  if (userMenuBtn && userDropdown) {
    userMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = userDropdown.style.display === "block";
      userDropdown.style.display = isVisible ? "none" : "block";
    });
    document.addEventListener("click", () => {
      if (userDropdown) userDropdown.style.display = "none";
    });
  }
});

// ═══════════════════════════════════════════════
// 3. NAVBAR AUTH DURUMU
// ═══════════════════════════════════════════════
function updateNavbar(user) {
  const authButtons = document.getElementById("auth-buttons");
  const userMenu    = document.getElementById("user-menu");
  const userNameNav = document.getElementById("userNameNav");
  const userAvatar  = document.getElementById("userAvatarNav");
  const mobileAuthBtn = document.getElementById("mobile-auth-btn");

  if (!authButtons || !userMenu) return;

  if (user) {
    authButtons.classList.add("hidden");
    userMenu.classList.remove("hidden");

    const displayName = user.displayName || user.email?.split("@")[0] || "Kullanıcı";
    const initials    = displayName.split(" ").map(w => w[0]).join("").toUpperCase().slice(0,2);

    if (userNameNav) userNameNav.textContent = displayName.split(" ")[0];
    if (userAvatar)  userAvatar.textContent  = initials;
    if (mobileAuthBtn) {
      mobileAuthBtn.textContent = "Araçlarım →";
      mobileAuthBtn.href = "dashboard.html";
    }

    // Dropdown'dan Dashboard linkini kaldır (navbar'da zaten var)
    const dropdown = document.getElementById("userDropdown");
    if (dropdown) {
      dropdown.querySelectorAll("a.dropdown-item").forEach(a => {
        if ((a.getAttribute("href") || "").includes("dashboard.html")) a.remove();
      });
    }
  } else {
    authButtons.classList.remove("hidden");
    userMenu.classList.add("hidden");
    if (mobileAuthBtn) {
      mobileAuthBtn.textContent = "Giriş Yap";
      mobileAuthBtn.href = "login.html";
    }
  }
}

function injectProfileLink() {
  const dropdown = document.getElementById("userDropdown");
  if (!dropdown || dropdown.querySelector(".profile-nav-link")) return;
  const isTools = window.location.pathname.includes("/tools/");
  const href = isTools ? "../profile.html" : "profile.html";
  const link = document.createElement("a");
  link.href = href;
  link.className = "dropdown-item profile-nav-link";
  link.textContent = "👤 Profilim";
  const logoutBtn = dropdown.querySelector("#logoutBtn");
  if (logoutBtn) {
    dropdown.insertBefore(link, logoutBtn);
  } else {
    dropdown.appendChild(link);
  }
}

function injectAdminLink() {
  const dropdown = document.getElementById("userDropdown");
  if (!dropdown || dropdown.querySelector(".admin-nav-link")) return;
  const isTools = window.location.pathname.includes("/tools/");
  const href = isTools ? "../admin.html" : "admin.html";
  const divider = document.createElement("div");
  divider.className = "dropdown-divider";
  const link = document.createElement("a");
  link.href = href;
  link.className = "dropdown-item admin-nav-link";
  link.textContent = "⚙️ Admin Paneli";
  const logoutBtn = dropdown.querySelector("#logoutBtn");
  if (logoutBtn) {
    dropdown.insertBefore(divider, logoutBtn);
    dropdown.insertBefore(link, divider);
  } else {
    dropdown.appendChild(link);
  }
}

// ═══════════════════════════════════════════════
// 4. AUTH STATE DİNLEYİCİSİ
// ═══════════════════════════════════════════════
let currentUser = null;

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  updateNavbar(user);

  if (user) {
    // Firestore'da kullanıcı profilini oluştur / son giriş zamanını güncelle
    try {
      const userRef = doc(db, "users", user.uid);
      const { getDoc, updateDoc, addDoc, collection, Timestamp } =
        await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      const snap = await getDoc(userRef);

      if (!snap.exists()) {
        // Davet token'ı kontrol et (localStorage'a login öncesi kaydedilmiş olabilir)
        const pendingToken = localStorage.getItem("pendingInvite");
        let statusToSet = "pending";
        let inviteTools = [];
        let inviteDurationMonths = null;

        if (pendingToken) {
          try {
            const invRef = doc(db, "invitations", pendingToken);
            const invSnap = await getDoc(invRef);
            if (invSnap.exists()) {
              const inv = invSnap.data();
              const isValid = !inv.used &&
                              inv.expiresAt.toDate() > new Date() &&
                              (!inv.email || inv.email.toLowerCase() === user.email?.toLowerCase());
              if (isValid) {
                statusToSet    = "active";
                inviteTools    = inv.tools || [];
                inviteDurationMonths = inv.durationMonths ?? null;
                // Daveti kullanıldı olarak işaretle
                await updateDoc(invRef, { used: true, usedBy: user.uid, usedAt: serverTimestamp() });
              }
            }
          } catch (e) { console.warn("Davet doğrulanamadı:", e.message); }
          localStorage.removeItem("pendingInvite");
        }

        // Kullanıcı dokümanını oluştur
        await setDoc(userRef, {
          email:       user.email,
          displayName: user.displayName || user.email?.split("@")[0],
          photoURL:    user.photoURL || null,
          role:        "user",
          status:      statusToSet,
          accessExpiry: inviteDurationMonths
            ? Timestamp.fromDate(addMonthsToDate(new Date(), inviteDurationMonths))
            : null,
          createdAt:   serverTimestamp(),
          lastLogin:   serverTimestamp()
        });

        // Araç izinlerini oluştur (davet varsa)
        if (inviteTools.length) {
          const now = new Date();
          const expiry = inviteDurationMonths ? addMonthsToDate(now, inviteDurationMonths) : null;
          for (const toolId of inviteTools) {
            await addDoc(collection(db, "user_permissions"), {
              userId:    user.uid,
              toolId,
              active:    true,
              startsAt:  Timestamp.fromDate(now),
              expiresAt: expiry ? Timestamp.fromDate(expiry) : null,
              grantedBy: "invite",
              grantedAt: serverTimestamp(),
              note:      "Davet ile otomatik oluşturuldu"
            });
          }
        }
      } else {
        // Sonraki girişler → lastLogin güncelle + admin linki kontrol et
        const role = snap.data()?.role;
        injectProfileLink();
        if (role === "admin" || role === "superadmin") injectAdminLink();
        await updateDoc(userRef, { lastLogin: serverTimestamp() });
      }

      // Bildirimleri başlat (her giriş yapan kullanıcı için)
      initNotifications(user.uid).catch(() => {});
    } catch (err) {
      console.warn("Profil güncellenemedi:", err.message);
    }
  }

  // Sayfaya özel auth hook (her sayfa kendi fonksiyonunu tanımlayabilir)
  if (typeof window.__onAuthResolved === "function") {
    window.__onAuthResolved(user);
  }
});

// ═══════════════════════════════════════════════
// 5. ÇIKIŞ
// ═══════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await signOut(auth);
        showToast("Çıkış yapıldı.", "success");
        setTimeout(() => { window.location.href = "index.html"; }, 800);
      } catch (err) {
        showToast("Çıkış yapılamadı: " + err.message, "error");
      }
    });
  }
});

// ═══════════════════════════════════════════════
// 6. GOOGLE GİRİŞ (ortak yardımcı)
// ═══════════════════════════════════════════════
async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user") {
      throw err;
    }
    return null;
  }
}

// ═══════════════════════════════════════════════
// 7. TOAST BİLDİRİMLERİ
// ═══════════════════════════════════════════════
const TOAST_ICONS = {
  success: "✅",
  error:   "❌",
  warning: "⚠️",
  info:    "ℹ️"
};

function showToast(message, type = "info", duration = 3500) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span style="font-size:1.1rem;">${TOAST_ICONS[type] || "ℹ️"}</span>
    <span>${message}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hiding");
    toast.addEventListener("animationend", () => toast.remove());
  }, duration);
}

// ═══════════════════════════════════════════════
// 8. SAYFA KORUYUCU (Dashboard gibi auth gerektiren sayfalar için)
// ═══════════════════════════════════════════════
/**
 * Kullanıcı giriş yapmamışsa login sayfasına yönlendir.
 * Kullanım: dashboard.js içinde requireAuth() çağır.
 */
function requireAuth(redirectUrl = "login.html") {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      if (!user) {
        window.location.href = redirectUrl + "?redirect=" + encodeURIComponent(window.location.pathname);
      } else {
        resolve(user);
      }
    });
  });
}

// ═══════════════════════════════════════════════
// 9. TARİH FORMATLAYICI
// ═══════════════════════════════════════════════
function formatDate(timestamp, options = {}) {
  if (!timestamp) return "—";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return new Intl.DateTimeFormat("tr-TR", {
    year:  "numeric",
    month: "long",
    day:   "numeric",
    ...options
  }).format(date);
}

function formatRelativeDate(timestamp) {
  if (!timestamp) return "—";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  const diff  = Date.now() - date.getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);

  if (mins < 1)   return "Az önce";
  if (mins < 60)  return `${mins} dakika önce`;
  if (hours < 24) return `${hours} saat önce`;
  if (days < 7)   return `${days} gün önce`;
  return formatDate(timestamp);
}

// ═══════════════════════════════════════════════
// 10. ARAÇ ERİŞİM KONTROLÜ
// ═══════════════════════════════════════════════
/**
 * Kullanıcının belirli bir araca erişimi var mı?
 * Admin her zaman true döner.
 */
async function checkToolAccess(uid, toolId) {
  if (!uid) return { allowed: false, reason: "not_authenticated" };
  try {
    const { getDoc: _get, getDocs: _gets, collection: _col, query: _q, where: _w } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

    const userSnap = await _get(doc(db, "users", uid));
    const now = new Date();

    if (userSnap.exists()) {
      const data = userSnap.data();
      const role   = data.role   || "user";
      const status = data.status || "active"; // eksik status = eski kullanıcı → aktif

      // Durum kontrolleri
      if (status === "suspended") return { allowed: false, reason: "suspended" };
      if (status === "pending")   return { allowed: false, reason: "pending_approval" };

      // Hesap sona erme kontrolü (global)
      if (data.accessExpiry) {
        const expDate = data.accessExpiry.toDate ? data.accessExpiry.toDate() : new Date(data.accessExpiry);
        if (expDate < now) return { allowed: false, reason: "account_expired" };
      }

      // Admin / superadmin her zaman geçer
      if (role === "admin" || role === "superadmin")
        return { allowed: true, reason: "admin" };
    }

    // "all_tools" genel iznini kontrol et
    const allSnap = await _gets(_q(_col(db,"user_permissions"),
      _w("userId","==",uid), _w("toolId","==","all_tools"), _w("active","==",true)));
    for (const d of allSnap.docs) {
      const p = d.data();
      if ((!p.expiresAt || p.expiresAt.toDate() > now) && (!p.startsAt || p.startsAt.toDate() <= now))
        return { allowed: true, reason: "all_tools_permission" };
    }

    // Spesifik araç iznini kontrol et
    const toolSnap = await _gets(_q(_col(db,"user_permissions"),
      _w("userId","==",uid), _w("toolId","==",toolId), _w("active","==",true)));
    for (const d of toolSnap.docs) {
      const p = d.data();
      if (p.expiresAt && p.expiresAt.toDate() < now) return { allowed: false, reason: "expired" };
      if (p.startsAt && p.startsAt.toDate() > now)   return { allowed: false, reason: "not_started_yet" };
      return { allowed: true, reason: "tool_permission" };
    }

    return { allowed: false, reason: "no_permission" };
  } catch (err) {
    console.warn("checkToolAccess:", err.message);
    return { allowed: false, reason: "error" };
  }
}

/**
 * Araç sayfalarında auth + izin kontrolü.
 * Kullanım: const user = await requireToolAccess("tool_isg_reports");
 */
async function requireToolAccess(toolId, opts = {}) {
  const { loadingEl="page-loading", authGateEl="auth-gate", mainEl="main-content" } = opts;
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      unsub();
      const hide = id => { const e=document.getElementById(id); if(e) e.style.display="none"; };
      const show = (id,d="block") => { const e=document.getElementById(id); if(e) e.style.display=d; };
      hide(loadingEl);

      if (!user) { show(authGateEl); resolve(null); return; }

      const { allowed, reason } = await checkToolAccess(user.uid, toolId);
      if (allowed) { show(mainEl); resolve(user); return; }

      const msgs = {
        no_permission:    "Bu araca erişim izniniz bulunmamaktadır. Yöneticinizle iletişime geçin.",
        expired:          "Bu araç için erişim süreniz dolmuştur. Yöneticinizle iletişime geçin.",
        account_expired:  "Hesap erişim süreniz dolmuştur. Yöneticinizle iletişime geçin.",
        not_started_yet:  "Erişim süreniz henüz başlamamıştır.",
        suspended:        "Hesabınız askıya alınmıştır. Yöneticinizle iletişime geçin.",
        pending_approval: "Hesabınız admin onayı beklemektedir. Onaylandıktan sonra erişebilirsiniz.",
        error:            "Erişim kontrolü sırasında bir hata oluştu."
      };
      const isTools = window.location.pathname.includes("/tools/");
      const dash = isTools ? "../dashboard.html" : "dashboard.html";
      const home = isTools ? "../index.html" : "index.html";

      document.body.insertAdjacentHTML("beforeend",`
        <div style="position:fixed;inset:0;background:var(--bg-page);display:flex;align-items:center;justify-content:center;z-index:9999;padding:1rem;">
          <div class="card" style="text-align:center;max-width:440px;padding:2.5rem;width:100%;">
            <div style="font-size:4rem;margin-bottom:1rem;">🔒</div>
            <h2 style="margin-bottom:1rem;color:var(--text-primary);">Erişim Yetkiniz Yok</h2>
            <p style="color:var(--text-muted);margin-bottom:1.5rem;line-height:1.6;">${msgs[reason]||"Erişim reddedildi."}</p>
            <div style="display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap;">
              <a href="${dash}" class="btn btn-primary">📊 Araçlarıma Dön</a>
              <a href="${home}" class="btn btn-ghost">🏠 Ana Sayfa</a>
            </div>
          </div>
        </div>`);
      resolve(null);
    });
  });
}

// ═══════════════════════════════════════════════
// 11. YARDIMCILAR
// ═══════════════════════════════════════════════
function addMonthsToDate(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

// Davet linki için token sakla (login öncesi çağrılabilir)
window.saveInviteToken = function(token) {
  if (token) localStorage.setItem("pendingInvite", token);
};

// login.html?invite=TOKEN → otomatik kaydet
(function() {
  const token = new URLSearchParams(window.location.search).get("invite");
  if (token) localStorage.setItem("pendingInvite", token);
})();

// ═══════════════════════════════════════════════
// 13. SITE CONFIG — her sayfada uygula
// ═══════════════════════════════════════════════
const SITE_CFG_KEY = "ozisg_site_cfg";
const SITE_CFG_TTL = 5 * 60 * 1000; // 5 dakika

export async function getSiteConfig() {
  try {
    const cached = sessionStorage.getItem(SITE_CFG_KEY);
    if (cached) {
      const { data, ts } = JSON.parse(cached);
      if (Date.now() - ts < SITE_CFG_TTL) return data;
    }
  } catch {}
  try {
    const snap = await getDoc(doc(db, "site_config", "main"));
    const data = snap.exists() ? snap.data() : {};
    sessionStorage.setItem(SITE_CFG_KEY, JSON.stringify({ data, ts: Date.now() }));
    return data;
  } catch { return {}; }
}

export function clearSiteConfigCache() {
  sessionStorage.removeItem(SITE_CFG_KEY);
}

async function applySiteConfig() {
  const cfg = await getSiteConfig();
  if (!cfg || !Object.keys(cfg).length) return;

  const path = window.location.pathname;
  const isAdmin = path.includes("admin.html");
  const isLogin = path.includes("login.html");

  // ── Bakım Modu ──────────────────────────────
  if (cfg.maintenance?.active && !isAdmin && !isLogin) {
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;padding:2rem;">
        <div style="text-align:center;max-width:480px;">
          <div style="font-size:4rem;margin-bottom:1.5rem;">🔧</div>
          <h1 style="font-size:1.75rem;font-weight:800;margin-bottom:1rem;color:#1e293b;">Bakım Çalışması</h1>
          <p style="color:#64748b;font-size:1.1rem;line-height:1.6;">${cfg.maintenance.message || "Site bakım çalışması yapılmaktadır. Kısa süre içinde geri döneceğiz."}</p>
        </div>
      </div>`;
    return;
  }

  // ── Duyuru Bandı ────────────────────────────
  if (cfg.announcement?.active && cfg.announcement?.text) {
    const bar = document.createElement("div");
    bar.id = "announcement-bar";
    bar.style.cssText = `background:${cfg.announcement.bgColor||"#f97316"};color:${cfg.announcement.textColor||"#fff"};text-align:center;padding:8px 16px;font-size:0.875rem;font-weight:600;position:relative;z-index:200;`;
    bar.textContent = cfg.announcement.text;
    document.body.insertAdjacentElement("afterbegin", bar);
  }

  // ── Logo ────────────────────────────────────
  const logoEl = document.querySelector(".navbar-logo");
  if (logoEl) {
    if (cfg.logoImageUrl) {
      logoEl.innerHTML = `<img src="${cfg.logoImageUrl}" alt="Logo" style="height:30px;width:auto;object-fit:contain;">`;
      logoEl.style.cssText += ";background:none;padding:0;";
    } else if (cfg.logoText) {
      logoEl.textContent = cfg.logoText;
    }
  }
  const brandNameEl = document.querySelector(".navbar-brand-name");
  if (brandNameEl && cfg.siteName) brandNameEl.textContent = cfg.siteName;

  // ── Mod Bazlı Renk Uygulayıcı ───────────────
  function applyThemeColors(theme) {
    if (!theme) return;
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const modeColors = isDark ? theme.dark : theme.light;

    // Önce genel primary rengi uygula (fallback)
    if (theme.primaryColor) {
      document.documentElement.style.setProperty("--accent-primary", theme.primaryColor);
    }
    if (theme.headerGradientFrom) {
      document.documentElement.style.setProperty("--navy-900", theme.headerGradientFrom);
      document.documentElement.style.setProperty("--navy-700", theme.headerGradientTo || theme.headerGradientFrom);
    }

    // Mod'a özel renkler varsa üzerine yaz
    if (modeColors?.primaryColor) {
      document.documentElement.style.setProperty("--accent-primary", modeColors.primaryColor);
    }
    if (modeColors?.headerFrom) {
      document.documentElement.style.setProperty("--navy-900", modeColors.headerFrom);
      document.documentElement.style.setProperty("--navy-700", modeColors.headerTo || modeColors.headerFrom);
    }
  }

  applyThemeColors(cfg.theme);

  // Tema toggle'a da bağla — değiştiğinde mod renklerini yeniden uygula
  const themeToggleBtn = document.getElementById("themeToggle");
  if (themeToggleBtn && cfg.theme && !themeToggleBtn.dataset.colorBound) {
    themeToggleBtn.dataset.colorBound = "1";
    themeToggleBtn.addEventListener("click", () => {
      // Toggle biraz bekledikten sonra (dom güncellendikten sonra) uygula
      requestAnimationFrame(() => applyThemeColors(cfg.theme));
    });
  }

  // ── Favicon ─────────────────────────────────
  if (cfg.faviconUrl) {
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = cfg.faviconUrl;
  }

  // ── Sayfa Bazlı Tasarım ──────────────────────
  if (cfg.pageDesign) {
    const pagePath = window.location.pathname;
    const pageFile = pagePath.split("/").pop() || "index.html";
    const pageId   = pageFile.replace(".html", "") || "index";
    const pd       = cfg.pageDesign[pageId];
    if (pd) {
      // Devre dışı sayfa → bakım yönlendirmesi
      if (pd.disabled && !isAdmin && !isLogin) {
        document.body.innerHTML = `
          <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;padding:2rem;">
            <div style="text-align:center;max-width:400px;">
              <div style="font-size:3.5rem;margin-bottom:1rem;">🚧</div>
              <h1 style="font-size:1.5rem;font-weight:700;margin-bottom:.75rem;color:#1e293b;">Bu Sayfa Şu An Kullanılamıyor</h1>
              <p style="color:#64748b;margin-bottom:1.5rem;">Sayfa geçici olarak devre dışı bırakılmıştır.</p>
              <a href="index.html" style="display:inline-block;padding:.6rem 1.5rem;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Ana Sayfaya Dön</a>
            </div>
          </div>`;
        return;
      }
      // Renk override
      if (pd.primaryColor) document.documentElement.style.setProperty("--accent-primary", pd.primaryColor);
      // Font ailesi
      if (pd.fontFamily) {
        document.documentElement.style.setProperty("--font-sans", `'${pd.fontFamily}', sans-serif`);
        document.body.style.fontFamily = `'${pd.fontFamily}', sans-serif`;
      }
      // Font ölçeği
      if (pd.fontScale && pd.fontScale !== 100) {
        document.documentElement.style.fontSize = (pd.fontScale / 100) + "rem";
      }
      // Header gradyanı override
      if (pd.headerFrom) {
        document.documentElement.style.setProperty("--navy-900", pd.headerFrom);
        document.documentElement.style.setProperty("--navy-700", pd.headerTo || pd.headerFrom);
      }
    }
  }

  // ── Menü Görünürlük & Sıralama ──────────────
  if (cfg.menu?.length) {
    const navUl    = document.querySelector(".navbar-nav");
    const mobileNav = document.getElementById("mobileNav");
    if (navUl) navUl.style.display = "flex";

    cfg.menu.forEach((item) => {
      // Desktop
      if (navUl) {
        navUl.querySelectorAll("li a.nav-link").forEach(a => {
          const href = a.getAttribute("href") || "";
          if (href === item.url || href.endsWith("/" + item.url)) {
            const li = a.closest("li");
            if (li) {
              li.style.display = item.visible === false ? "none" : "";
              li.style.order   = item.order ?? "";
              if (item.label) a.textContent = item.label;
            }
          }
        });
      }
      // Mobile
      if (mobileNav) {
        mobileNav.querySelectorAll("a.nav-link").forEach(a => {
          const href = a.getAttribute("href") || "";
          if (href === item.url || href.endsWith("/" + item.url)) {
            a.style.display = item.visible === false ? "none" : "";
            a.style.order   = item.order ?? "";
            if (item.label) a.textContent = `${item.icon || ""} ${item.label}`.trim();
          }
        });
      }
    });

    // Özel (custom) menü öğesi ekle
    cfg.menu?.filter(i => i.custom && i.visible !== false).forEach((item) => {
      if (navUl) {
        const exists = [...navUl.querySelectorAll("a")].some(a => a.getAttribute("href") === item.url);
        if (!exists) {
          const li = document.createElement("li");
          li.style.order = item.order ?? "";
          li.innerHTML = `<a href="${item.url}" class="nav-link">${item.label}</a>`;
          navUl.appendChild(li);
        }
      }
      if (mobileNav) {
        const exists = [...mobileNav.querySelectorAll("a")].some(a => a.getAttribute("href") === item.url);
        if (!exists) {
          const a = document.createElement("a");
          a.href = item.url;
          a.className = "nav-link";
          a.style.order = item.order ?? "";
          a.textContent = `${item.icon || "🔗"} ${item.label}`;
          mobileNav.appendChild(a);
        }
      }
    });
  }

  // ── Footer ───────────────────────────────────
  if (cfg.footer) {
    const f = cfg.footer;
    // Copyright
    const copyrightEl = document.querySelector(".footer-bottom span:first-child");
    if (copyrightEl && f.copyright) copyrightEl.textContent = f.copyright;

    // Footer brand açıklaması
    const brandTextEl = document.querySelector(".footer-brand-text");
    if (brandTextEl && f.description) brandTextEl.textContent = f.description;

    // Logo (footer)
    const footerLogoEl = document.querySelector(".footer .navbar-logo");
    if (footerLogoEl) {
      if (cfg.logoImageUrl) {
        footerLogoEl.innerHTML = `<img src="${cfg.logoImageUrl}" alt="Logo" style="height:28px;width:auto;object-fit:contain;">`;
        footerLogoEl.style.cssText += ";background:none;padding:0;";
      } else if (cfg.logoText) {
        footerLogoEl.textContent = cfg.logoText;
      }
    }
    const footerBrandName = document.querySelector(".footer .navbar-brand-name");
    if (footerBrandName && cfg.siteName) footerBrandName.textContent = cfg.siteName;

    // Sosyal medya (footer Bağlantı bölümü)
    const socialLinks = { linkedin:"LinkedIn", github:"GitHub", twitter:"Twitter/X", instagram:"Instagram", youtube:"YouTube" };
    const footerLinks = document.querySelector(".footer-links:last-of-type");
    if (footerLinks && f.social) {
      let html = "";
      Object.entries(socialLinks).forEach(([key, label]) => {
        if (f.social[key]) html += `<li><a href="${f.social[key]}" target="_blank" rel="noopener">${label}</a></li>`;
      });
      (f.customLinks || []).forEach(l => {
        html += `<li><a href="${l.url}" target="_blank" rel="noopener">${l.label}</a></li>`;
      });
      if (html) footerLinks.innerHTML = html;
    }
  }

  // ── SEO Meta Etiketleri ──────────────────────
  if (cfg.seo && !isAdmin) {
    const s = cfg.seo;
    const setMeta = (name, content, attr = "name") => {
      if (!content) return;
      let el = document.querySelector(`meta[${attr}="${name}"]`);
      if (!el) { el = document.createElement("meta"); el.setAttribute(attr, name); document.head.appendChild(el); }
      el.setAttribute("content", content);
    };

    if (s.defaultDescription) setMeta("description", s.defaultDescription);
    if (s.keywords)            setMeta("keywords",    s.keywords);

    if (s.defaultTitle && document.title && !document.title.includes(s.defaultTitle)) {
      const sep = s.titleSeparator || " | ";
      document.title = document.title + sep + s.defaultTitle;
    }

    if (s.defaultDescription) setMeta("og:description", s.defaultDescription, "property");
    if (s.ogImage)             setMeta("og:image",       s.ogImage,            "property");
    setMeta("og:title", document.title, "property");
    setMeta("og:type",  "website",      "property");

    if (s.googleAnalyticsId && !document.getElementById("ga-script")) {
      const gaSrc = document.createElement("script");
      gaSrc.id  = "ga-script";
      gaSrc.src = `https://www.googletagmanager.com/gtag/js?id=${s.googleAnalyticsId}`;
      gaSrc.async = true;
      document.head.appendChild(gaSrc);
      const gaInit = document.createElement("script");
      gaInit.id = "ga-init";
      gaInit.textContent = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${s.googleAnalyticsId}');`;
      document.head.appendChild(gaInit);
    }

    if (s.googleTagManagerId && !document.getElementById("gtm-script")) {
      const gtmScript = document.createElement("script");
      gtmScript.id = "gtm-script";
      gtmScript.textContent = `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${s.googleTagManagerId}');`;
      document.head.appendChild(gtmScript);
    }
  }

  // ── Özel CSS ─────────────────────────────────
  if (cfg.customCode?.headCSS) {
    let styleEl = document.getElementById("ozisg-custom-css");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "ozisg-custom-css";
      document.head.appendChild(styleEl);
    }
    let css = cfg.customCode.headCSS;
    css = css.replace(/<script[\s\S]*?<\/script>/gi, "");
    css = css.replace(/javascript\s*:/gi, "");
    css = css.replace(/expression\s*\([^)]*\)/gi, "");
    css = css.replace(/url\s*\(\s*data:[^)]*\)/gi, "");
    css = css.replace(/@import[^;]*;/gi, "");
    styleEl.textContent = css;
  }

  // ── Hero İçeriği ─────────────────────────────
  if (cfg.hero && (window.location.pathname.endsWith("index.html") || window.location.pathname.endsWith("/"))) {
    const h = cfg.hero;
    const set = (id, val) => { if (val) { const el = document.getElementById(id); if (el) el.textContent = val; } };
    set("hero-eyebrow-text", h.eyebrow);
    set("hero-title-text",   h.titleLine1);
    set("hero-name-text",    h.name);
    set("hero-subtitle-text",h.subtitle);
    set("hero-btn1",         h.btn1Text);
    set("hero-btn2",         h.btn2Text);
    if (h.btn1Url) { const el = document.getElementById("hero-btn1"); if (el) el.href = h.btn1Url; }
    if (h.btn2Url) { const el = document.getElementById("hero-btn2"); if (el) el.href = h.btn2Url; }
    if (h.titleColor) {
      const titleEl = document.querySelector(".hero-title");
      if (titleEl) titleEl.style.color = h.titleColor;
    }
    if (h.subtitleColor) {
      const subEl = document.getElementById("hero-subtitle-text");
      if (subEl) subEl.style.color = h.subtitleColor;
    }
  }

  // ── Ana Sayfa Bölüm Ayarları ─────────────────
  if (cfg.homeSections && (window.location.pathname.endsWith("index.html") || window.location.pathname.endsWith("/"))) {
    Object.entries(cfg.homeSections).forEach(([sectionId, settings]) => {
      const section = document.getElementById(sectionId);
      if (!section) return;

      // Görünürlük
      if (settings.visible === false) {
        section.style.display = "none";
        return;
      }

      // Sıralama
      if (settings.order !== undefined) section.style.order = settings.order;

      // Arka plan rengi
      if (settings.bgColor) section.style.backgroundColor = settings.bgColor;

      // Başlık/alt başlık override
      if (settings.title) {
        const titleEl = section.querySelector(".section-title");
        if (titleEl) titleEl.textContent = settings.title;
      }
      if (settings.subtitle) {
        const subEl = section.querySelector(".section-subtitle");
        if (subEl) subEl.textContent = settings.subtitle;
      }
    });

    // Sıralama çalışması için main'in display'i flex olmalı
    const main = document.querySelector("main.page-content");
    if (main) main.style.display = "flex", main.style.flexDirection = "column";
  }
}

document.addEventListener("DOMContentLoaded", () => { applySiteConfig(); });

// ═══════════════════════════════════════════════
// 12. GLOBAL DIŞA AKTARIMLAR
// ═══════════════════════════════════════════════
export {
  auth,
  db,
  currentUser,
  showToast,
  requireAuth,
  requireToolAccess,
  checkToolAccess,
  signInWithGoogle,
  formatDate,
  formatRelativeDate
};

// window üzerinden de erişilebilir (non-module scriptler için)
window.showToast          = showToast;
window.signInWithGoogle   = signInWithGoogle;
window.requireAuth        = requireAuth;
window.requireToolAccess  = requireToolAccess;
window.checkToolAccess    = checkToolAccess;
window.formatDate         = formatDate;
window.formatRelativeDate = formatRelativeDate;
window.getSiteConfig      = getSiteConfig;
window.clearSiteConfigCache = clearSiteConfigCache;
