/**
 * profile.js — Kullanıcı Profil Sayfası
 */

import { auth, db, showToast } from "./app.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, updateDoc, collection, query,
  where, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const TOOL_LABELS = {
  tool_isg_reports:  "🛡️ İSG Günlük Rapor",
  tool_work_permits: "📋 Teknik İş Takip",
  tool_budget:       "💰 Bütçe Takip",
  tool_ptk:          "📊 PTK Kontrol",
  tool_levha:        "🪧 Levha Merkezi",
  tool_kroki:        "🗺️ Acil Durum Krokisi",
  tool_kkd:          "🦺 KKD Yönetim",
  all_tools:         "⭐ Tüm Araçlar",
};

onAuthStateChanged(auth, async (user) => {
  document.getElementById("profile-loading").style.display = "none";

  if (!user) {
    document.getElementById("profile-gate").style.display = "block";
    return;
  }

  document.getElementById("profile-content").style.display = "block";
  await loadProfile(user);
  await loadPermissions(user.uid);
});

async function loadProfile(user) {
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? snap.data() : {};

    const displayName = data.displayName || user.displayName || "";
    const email       = data.email       || user.email       || "";
    const photoURL    = data.photoURL    || user.photoURL    || "";
    const role        = data.role        || "user";
    const status      = data.status      || "active";

    // Üst başlık
    setEl("profileHeaderName",  displayName || "İsimsiz Kullanıcı");
    setEl("profileHeaderEmail", email);

    // Avatar
    const avatarEl = document.getElementById("profileAvatarLarge");
    if (photoURL) {
      avatarEl.innerHTML = `<img src="${photoURL}" alt="Profil" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.parentElement.textContent='${initials(displayName)}'">`;
    } else {
      avatarEl.textContent = initials(displayName);
    }

    // Rozetler
    document.getElementById("profileRoleBadge").textContent   = roleName(role);
    document.getElementById("profileStatusBadge").textContent = statusName(status);

    // Form alanları
    document.getElementById("profileDisplayName").value = displayName;
    document.getElementById("profileEmail").value       = email;
    document.getElementById("profilePhotoURL").value    = photoURL;
    setEl("profileUid", user.uid);

    // Hesap tarihleri
    setEl("profileCreatedAt",    fmtDate(data.createdAt));
    setEl("profileLastLogin",    fmtDate(data.lastLogin));

    const expiry = data.accessExpiry;
    const expiryEl = document.getElementById("profileAccessExpiry");
    if (!expiry) {
      expiryEl.textContent = "Süresiz";
      expiryEl.style.color = "var(--accent-success)";
    } else {
      const d   = expiry.toDate ? expiry.toDate() : new Date(expiry);
      const now = new Date();
      const diff = Math.ceil((d - now) / 86400000);
      expiryEl.textContent = d.toLocaleDateString("tr-TR");
      if (diff < 0) {
        expiryEl.style.color = "var(--accent-danger)";
        expiryEl.textContent += " (Doldu)";
      } else if (diff <= 30) {
        expiryEl.style.color = "var(--accent-warning)";
        expiryEl.textContent += ` (${diff} gün kaldı)`;
      }
    }

    // Blog editörü linki
    if (role === "editor" || role === "admin" || role === "superadmin") {
      document.getElementById("blogEditorLink").style.display = "flex";
    }

    // Kaydet butonu
    document.getElementById("saveProfileBtn").addEventListener("click", () => saveProfile(user.uid));

  } catch (err) {
    showToast("Profil yüklenemedi: " + err.message, "error");
  }
}

async function saveProfile(uid) {
  const displayName = document.getElementById("profileDisplayName").value.trim();
  const photoURL    = document.getElementById("profilePhotoURL").value.trim();
  const alertEl     = document.getElementById("profileSaveAlert");
  const btn         = document.getElementById("saveProfileBtn");

  if (!displayName) {
    showAlert(alertEl, "Ad Soyad boş olamaz.", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Kaydediliyor…";

  try {
    await updateDoc(doc(db, "users", uid), {
      displayName,
      photoURL: photoURL || null,
      updatedAt: serverTimestamp()
    });

    // Avatar'ı güncelle
    const avatarEl = document.getElementById("profileAvatarLarge");
    if (photoURL) {
      avatarEl.innerHTML = `<img src="${photoURL}" alt="Profil" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.parentElement.textContent='${initials(displayName)}'">`;
    } else {
      avatarEl.textContent = initials(displayName);
    }
    setEl("profileHeaderName", displayName);

    showAlert(alertEl, "Profil güncellendi.", "success");
    showToast("Profil kaydedildi ✅", "success");
  } catch (err) {
    showAlert(alertEl, "Kayıt başarısız: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Kaydet";
  }
}

async function loadPermissions(uid) {
  const container = document.getElementById("profilePermsList");
  try {
    const q = query(
      collection(db, "user_permissions"),
      where("userId", "==", uid),
      where("active", "==", true)
    );
    const snap = await getDocs(q);
    const now  = new Date();

    if (snap.empty) {
      container.innerHTML = `
        <div style="text-align:center;padding:var(--space-8);color:var(--text-muted);">
          <div style="font-size:2rem;margin-bottom:var(--space-3);">🔒</div>
          <p style="font-size:var(--text-sm);">Henüz tanımlı araç erişiminiz yok.</p>
        </div>`;
      return;
    }

    const perms = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    container.innerHTML = perms.map(p => {
      const isExpired = p.expiresAt && p.expiresAt.toDate() < now;
      const expDate   = p.expiresAt ? p.expiresAt.toDate() : null;
      const diff      = expDate ? Math.ceil((expDate - now) / 86400000) : null;
      let statusHtml;
      if (isExpired) {
        statusHtml = `<span class="badge badge-danger">Doldu</span>`;
      } else if (diff !== null && diff <= 14) {
        statusHtml = `<span class="badge badge-warning">${diff} gün kaldı</span>`;
      } else if (!expDate) {
        statusHtml = `<span class="badge badge-success">Süresiz</span>`;
      } else {
        statusHtml = `<span class="badge badge-success">${expDate.toLocaleDateString("tr-TR")}</span>`;
      }
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:var(--space-3) 0;border-bottom:1px solid var(--border-subtle);">
          <span style="font-size:var(--text-sm);font-weight:var(--font-medium);">
            ${TOOL_LABELS[p.toolId] || p.toolId}
          </span>
          ${statusHtml}
        </div>`;
    }).join("");
  } catch {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:var(--text-sm);">İzinler yüklenemedi.</div>`;
  }
}

// ── Yardımcılar ──
function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("tr-TR", { year:"numeric", month:"long", day:"numeric" });
}

function initials(name) {
  return (name || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

function roleName(role) {
  const map = { superadmin:"⭐ Süper Admin", admin:"🔑 Admin", editor:"✍️ Editör", user:"👤 Kullanıcı" };
  return map[role] || role;
}

function statusName(status) {
  const map = { active:"✅ Aktif", pending:"⏳ Onay Bekliyor", suspended:"⏸ Askıda" };
  return map[status] || status;
}

function showAlert(el, msg, type) {
  el.textContent  = msg;
  el.style.background = type === "success" ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)";
  el.style.color      = type === "success" ? "var(--accent-success)" : "var(--accent-danger)";
  el.style.border     = `1px solid ${type === "success" ? "var(--accent-success)" : "var(--accent-danger)"}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}
