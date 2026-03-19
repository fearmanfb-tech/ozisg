/**
 * admin.js — Admin Paneli v2
 * Faz 1: Kullanıcı Yönetimi + Onay Akışı + Davet Sistemi
 */

import { auth, db, showToast } from "./app.js";
import { writeNotification } from "./notifications.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, getDoc, setDoc, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Araç listesi ──────────────────────────────
const TOOLS = [
  { id: "tool_isg_reports",  label: "🛡️ İSG Günlük Rapor" },
  { id: "tool_work_permits", label: "📋 İş İzni Takip" },
  { id: "tool_ptk",          label: "📊 PTK Kontrol" },
  { id: "tool_levha",        label: "🪧 Levha Merkezi" },
  { id: "tool_kroki",        label: "🗺️ Acil Durum Krokisi" },
  { id: "tool_kkd",          label: "🦺 KKD Yönetim" },
  { id: "tool_budget",       label: "💰 Bütçe Takip" },
];
const TOOL_MAP = Object.fromEntries(TOOLS.map(t => [t.id, t.label]));
TOOL_MAP["all_tools"] = "⭐ Tüm Araçlar";

const DURATION_OPTIONS = [
  { label: "1 Ay",    months: 1 },
  { label: "3 Ay",    months: 3 },
  { label: "6 Ay",    months: 6 },
  { label: "1 Yıl",   months: 12 },
  { label: "Süresiz", months: null },
];

// ── Durum ─────────────────────────────────────
let currentAdmin     = null;
let currentAdminRole = null;
let allUsers         = [];
let allPerms         = [];
let approvingUserId  = null;
let editingPermId    = null;

// ══════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════
onAuthStateChanged(auth, async (user) => {
  document.getElementById("page-loading").style.display = "none";
  if (!user) { showAccessDenied(); return; }

  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists()) { showAccessDenied(); return; }

  const role = snap.data().role;
  if (role !== "admin" && role !== "superadmin") { showAccessDenied(); return; }

  currentAdmin     = user;
  currentAdminRole = role;

  const badge = document.getElementById("adminRoleBadge");
  if (badge && role === "superadmin") {
    badge.textContent = "⭐ Süper Admin";
    badge.style.cssText = "background:#f97316;color:#fff;padding:4px 14px;border-radius:99px;font-size:var(--text-sm);font-weight:var(--font-semibold);";
  }

  document.getElementById("admin-content").style.display = "block";
  buildInviteToolsList();
  await Promise.all([loadUsers(), loadPermissions(), loadLogs()]);
});

function showAccessDenied() {
  const el = document.getElementById("access-denied");
  if (el) el.style.display = "flex";
}

// ══════════════════════════════════════════════
// VERİ YÜKLEME
// ══════════════════════════════════════════════
async function loadUsers() {
  try {
    const snap = await getDocs(collection(db, "users"));
    allUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    updateStats();
    renderPendingTab();
    renderUsersTable();
  } catch (err) {
    showToast("Kullanıcılar yüklenemedi: " + err.message, "error");
  }
}

async function loadPermissions() {
  try {
    const snap = await getDocs(collection(db, "user_permissions"));
    allPerms = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.grantedAt?.toMillis?.() || 0) - (a.grantedAt?.toMillis?.() || 0));
    updateStats();
    renderPermsTable(allPerms);
  } catch (err) {
    showToast("İzinler yüklenemedi: " + err.message, "error");
  }
}

window.refreshUsers = async function() {
  await Promise.all([loadUsers(), loadPermissions()]);
  showToast("Yenilendi.", "info");
};

// ══════════════════════════════════════════════
// İSTATİSTİKLER
// ══════════════════════════════════════════════
function updateStats() {
  const now      = new Date();
  const pending  = allUsers.filter(u => u.status === "pending").length;
  const active   = allUsers.filter(u => u.status === "active").length;
  const susp     = allUsers.filter(u => u.status === "suspended").length;
  const permNow  = new Date();
  const actPerms = allPerms.filter(p => p.active && (!p.expiresAt || p.expiresAt.toDate() > permNow)).length;
  const expPerms = allPerms.filter(p => p.expiresAt && p.expiresAt.toDate() < permNow).length;

  setEl("statTotalUsers",   allUsers.length);
  setEl("statPendingUsers", pending);
  setEl("statActiveUsers",  active);
  setEl("statSuspended",    susp);
  setEl("statActivePerms",  actPerms);
  setEl("statExpiredPerms", expPerms);
  setEl("statTotalPerms",   allPerms.length);

  // Pending tab badge
  const btn = document.getElementById("pendingTabBtn");
  if (btn) {
    btn.innerHTML = pending > 0
      ? `⏳ Onay Bekleyenler <span class="tab-badge">${pending}</span>`
      : "⏳ Onay Bekleyenler";
  }
}

// ══════════════════════════════════════════════
// ONAY BEKLEYENLERle TAB
// ══════════════════════════════════════════════
function renderPendingTab() {
  const container = document.getElementById("pending-list");
  if (!container) return;
  const pending = allUsers.filter(u => u.status === "pending");

  if (!pending.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div>✅</div>
        <p>Onay bekleyen kullanıcı yok.</p>
      </div>`;
    return;
  }

  container.innerHTML = pending.map(u => `
    <div class="pending-card">
      <div class="user-avatar-mini">${nameInitials(u)}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:var(--font-semibold);">${esc(u.displayName || "—")}</div>
        <div style="font-size:var(--text-sm);color:var(--text-muted);">${esc(u.email || "—")}</div>
        <div style="font-size:var(--text-xs);color:var(--text-muted);margin-top:2px;">Kayıt: ${fmtDate(u.createdAt)}</div>
      </div>
      <div style="display:flex;gap:var(--space-2);flex-shrink:0;">
        <button class="btn btn-success btn-sm" onclick="openApprovalModal('${u.id}')">✅ Onayla</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);" onclick="rejectUser('${u.id}','${esc(u.displayName || u.email)}')">❌ Reddet</button>
      </div>
    </div>`).join("");
}

// ══════════════════════════════════════════════
// ONAY MODALİ
// ══════════════════════════════════════════════
window.openApprovalModal = function(uid) {
  const user = allUsers.find(u => u.id === uid);
  if (!user) return;
  approvingUserId = uid;

  setEl("approvalUserAvatar", nameInitials(user));
  setEl("approvalUserName",   user.displayName || "—");
  setEl("approvalUserEmail",  user.email || "—");
  document.getElementById("approvalRole").value = "user";
  document.getElementById("approvalNote").value = "";

  // Araç checkboxları
  document.getElementById("approvalToolsList").innerHTML = TOOLS.map(t => `
    <label class="tool-check-item">
      <input type="checkbox" name="approval-tool" value="${t.id}" />
      <span>${t.label}</span>
    </label>`).join("");

  // Süre pilleri
  document.getElementById("approvalDurationList").innerHTML = DURATION_OPTIONS.map((d, i) => `
    <button type="button" class="duration-pill${i === 4 ? " active" : ""}"
      data-months="${d.months ?? ""}" onclick="selectApprovalDuration(this)">
      ${d.label}
    </button>`).join("");

  document.getElementById("approvalModal").style.display = "flex";
};

window.closeApprovalModal = function() {
  document.getElementById("approvalModal").style.display = "none";
  approvingUserId = null;
};

window.selectApprovalDuration = function(btn) {
  document.querySelectorAll("#approvalDurationList .duration-pill")
    .forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
};

window.confirmApproval = async function() {
  if (!approvingUserId) return;

  const selectedTools = [...document.querySelectorAll("input[name='approval-tool']:checked")]
    .map(c => c.value);
  if (!selectedTools.length) { showToast("En az bir araç seçin.", "warning"); return; }

  const durationBtn = document.querySelector("#approvalDurationList .duration-pill.active");
  const months = durationBtn?.dataset.months ? parseInt(durationBtn.dataset.months) : null;
  const role   = document.getElementById("approvalRole").value;
  const note   = document.getElementById("approvalNote").value.trim();
  const expiry = months ? addMonths(new Date(), months) : null;
  const now    = new Date();

  const btn = document.getElementById("confirmApprovalBtn");
  btn.disabled = true; btn.textContent = "⏳ Onaylanıyor…";

  try {
    // 1. Kullanıcı durumunu güncelle
    await updateDoc(doc(db, "users", approvingUserId), {
      status:      "active",
      role,
      accessExpiry: expiry ? Timestamp.fromDate(expiry) : null,
      approvedBy:  currentAdmin.uid,
      approvedAt:  serverTimestamp(),
      notes:       note || null,
    });

    // 2. Her araç için user_permission oluştur
    for (const toolId of selectedTools) {
      await addDoc(collection(db, "user_permissions"), {
        userId:    approvingUserId,
        toolId,
        active:    true,
        startsAt:  Timestamp.fromDate(now),
        expiresAt: expiry ? Timestamp.fromDate(expiry) : null,
        grantedBy: currentAdmin.uid,
        grantedAt: serverTimestamp(),
        note:      note || null,
      });
    }

    // 3. Log
    const u = allUsers.find(u => u.id === approvingUserId);
    await logActivity("user_approved",
      `${u?.email || approvingUserId} onaylandı — ${selectedTools.length} araç, ${months ? months + " ay" : "Süresiz"}`);

    // Kullanıcıya bildirim gönder
    await writeNotification(
      approvingUserId,
      "account_approved",
      "Hesabınız Onaylandı",
      `Hesabınız onaylandı ve ${selectedTools.length} araca erişiminiz tanımlandı. Araçlarınıza erişmek için giriş yapabilirsiniz.`
    );

    showToast("Kullanıcı onaylandı ✅", "success");
    closeApprovalModal();
    await Promise.all([loadUsers(), loadPermissions()]);
  } catch (err) {
    showToast("Hata: " + err.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "✅ Onayla ve Aktifleştir";
  }
};

window.rejectUser = async function(uid, name) {
  if (!confirm(`"${name}" kullanıcısını reddetmek ve hesabını silmek istiyor musunuz?\nBu işlem geri alınamaz.`)) return;
  try {
    await deleteDoc(doc(db, "users", uid));
    await logActivity("user_rejected", `${name} reddedildi ve silindi.`);
    showToast("Kullanıcı reddedildi.", "info");
    await loadUsers();
  } catch (err) {
    showToast("Hata: " + err.message, "error");
  }
};

// ══════════════════════════════════════════════
// KULLANICILAR TABLOSU
// ══════════════════════════════════════════════
window.renderUsersTable = function() {
  const container = document.getElementById("users-table");
  if (!container) return;

  const search = document.getElementById("searchUsers")?.value.toLowerCase() || "";
  const filter = document.getElementById("usersFilter")?.value || "all";

  const filtered = allUsers.filter(u => {
    const matchSearch = !search ||
      u.email?.toLowerCase().includes(search) ||
      u.displayName?.toLowerCase().includes(search);
    const matchFilter =
      filter === "all" ||
      u.status === filter ||
      (filter === "admin" && (u.role === "admin" || u.role === "superadmin"));
    return matchSearch && matchFilter;
  });

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><p>Kullanıcı bulunamadı.</p></div>`;
    return;
  }

  const now = new Date();
  container.innerHTML = `
    <table class="admin-table">
      <thead><tr>
        <th>Kullanıcı</th><th>E-posta</th><th>Rol</th><th>Durum</th>
        <th>Araçlar</th><th>Erişim Bitiş</th><th>Kayıt</th><th>İşlem</th>
      </tr></thead>
      <tbody>
        ${filtered.map(u => {
          const permCount = allPerms.filter(p => p.userId === u.id && p.active &&
            (!p.expiresAt || p.expiresAt.toDate() > now)).length;
          const expDate = u.accessExpiry
            ? (u.accessExpiry.toDate?.() || new Date(u.accessExpiry)) : null;
          const expStr = expDate ? expDate.toLocaleDateString("tr-TR") : "Süresiz";
          const expStyle = expDate && (expDate - now) / 86400000 <= 7
            ? "color:var(--accent-danger);font-weight:700;" : "";
          const isSelf    = u.id === currentAdmin.uid;
          const isHigher  = u.role === "superadmin" || (u.role === "admin" && currentAdminRole !== "superadmin");
          const canManage = !isSelf && !isHigher;

          return `<tr>
            <td>
              <div class="user-avatar-cell">
                <div class="user-avatar-mini">${nameInitials(u)}</div>
                <span style="font-weight:var(--font-semibold);">${esc(u.displayName || "—")}</span>
              </div>
            </td>
            <td style="color:var(--text-secondary);font-size:var(--text-sm);">${esc(u.email || "—")}</td>
            <td>${roleBadge(u.role)}</td>
            <td>${statusBadge(u.status)}</td>
            <td>
              <span style="font-weight:var(--font-bold);color:${permCount > 0 ? "var(--accent-success)" : "var(--text-muted)"};">${permCount}</span>
              ${permCount > 0 ? `<button class="btn btn-ghost btn-sm" style="margin-left:4px;font-size:10px;" onclick="filterPermsByUser('${u.id}')">Gör</button>` : ""}
            </td>
            <td style="font-size:var(--text-xs);${expStyle}">${expStr}</td>
            <td style="color:var(--text-muted);font-size:var(--text-xs);">${fmtDate(u.createdAt)}</td>
            <td>
              <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
                <button class="btn btn-primary btn-sm" onclick="openGrantModalForUser('${u.id}')">➕ Araç</button>
                ${canManage ? `
                  ${u.status === "suspended"
                    ? `<button class="btn btn-success btn-sm" onclick="setUserStatus('${u.id}','active')">▶ Aktifleştir</button>`
                    : u.status === "active"
                    ? `<button class="btn btn-ghost btn-sm" style="color:var(--accent-warning);" onclick="setUserStatus('${u.id}','suspended')">⏸ Askıya Al</button>`
                    : ""}
                  <button class="btn btn-ghost btn-sm" style="font-size:10px;color:var(--accent-primary);"
                    onclick="openRoleModal('${u.id}','${u.role}')">🎭 Rol</button>
                  <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);"
                    onclick="deleteUser('${u.id}','${esc(u.displayName || u.email)}')">🗑️</button>
                ` : isSelf ? `<span style="font-size:10px;color:var(--text-muted);">Sen</span>` : ""}
              </div>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
};

document.getElementById("searchUsers")?.addEventListener("input", window.renderUsersTable);

window.setUserStatus = async function(uid, newStatus) {
  const u = allUsers.find(u => u.id === uid);
  if (!u) return;
  const label = newStatus === "suspended" ? "askıya almak" : "aktifleştirmek";
  if (!confirm(`"${u.displayName || u.email}" kullanıcısını ${label} istiyor musunuz?`)) return;
  try {
    await updateDoc(doc(db, "users", uid), { status: newStatus });
    await logActivity(
      newStatus === "suspended" ? "user_suspended" : "user_activated",
      `${u.email} ${newStatus === "suspended" ? "askıya alındı" : "aktifleştirildi"}`
    );
    showToast(`Kullanıcı ${newStatus === "suspended" ? "askıya alındı" : "aktifleştirildi"}.`, "success");
    await loadUsers();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.openRoleModal = function(uid, currentRole) {
  const u = allUsers.find(u => u.id === uid);
  if (!u) return;

  // superadmin için tüm roller, admin için sadece user/editor
  const roles = currentAdminRole === "superadmin"
    ? [
        { value: "user",       label: "👤 Kullanıcı" },
        { value: "editor",     label: "✍️ Editör" },
        { value: "admin",      label: "⚙️ Admin" },
        { value: "superadmin", label: "👑 Superadmin" },
      ]
    : [
        { value: "user",   label: "👤 Kullanıcı" },
        { value: "editor", label: "✍️ Editör" },
      ];

  const overlay = document.createElement("div");
  overlay.id = "roleModalOverlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9000;display:flex;align-items:center;justify-content:center;";
  overlay.innerHTML = `
    <div style="background:var(--bg-surface,#fff);border-radius:12px;padding:var(--space-6,24px);width:340px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
      <h3 style="font-weight:700;margin-bottom:var(--space-1,4px);font-size:1rem;">🎭 Rol Değiştir</h3>
      <p style="font-size:0.8rem;color:var(--text-muted,#888);margin-bottom:var(--space-4,16px);">
        ${u.displayName || u.email}
      </p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:var(--space-5,20px);">
        ${roles.map(r => `
          <label style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:2px solid ${r.value===currentRole?"var(--accent-primary,#2563eb)":"var(--border-color,#e2e8f0)"};border-radius:8px;cursor:pointer;transition:.15s;"
            onmouseover="this.style.borderColor='var(--accent-primary,#2563eb)'" onmouseout="this.style.borderColor='${r.value===currentRole?"var(--accent-primary,#2563eb)":"var(--border-color,#e2e8f0)"}'">
            <input type="radio" name="roleSelect" value="${r.value}" ${r.value===currentRole?"checked":""} style="accent-color:var(--accent-primary,#2563eb);" />
            <span style="font-size:0.9rem;">${r.label}</span>
            ${r.value===currentRole?'<span style="margin-left:auto;font-size:0.7rem;color:var(--accent-primary,#2563eb);font-weight:600;">Mevcut</span>':""}
          </label>`).join("")}
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost" style="flex:1;" onclick="document.getElementById('roleModalOverlay').remove()">İptal</button>
        <button class="btn btn-primary" style="flex:2;" onclick="saveRole('${uid}','${u.email}')">💾 Kaydet</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
};

window.saveRole = async function(uid, email) {
  const selected = document.querySelector('input[name="roleSelect"]:checked');
  if (!selected) return;
  const newRole = selected.value;
  const overlay = document.getElementById("roleModalOverlay");

  // Superadmin rolü sadece superadmin verebilir
  if (newRole === "superadmin" && currentAdminRole !== "superadmin") {
    showToast("Superadmin rolü yalnızca superadmin tarafından verilebilir.", "error");
    return;
  }
  // Admin rolü sadece superadmin verebilir
  if (newRole === "admin" && currentAdminRole !== "superadmin") {
    showToast("Admin rolü yalnızca superadmin tarafından verilebilir.", "error");
    return;
  }

  try {
    await updateDoc(doc(db, "users", uid), { role: newRole });
    await logActivity("role_changed", `${email} → ${newRole}`);
    showToast(`Rol "${newRole}" olarak güncellendi.`, "success");
    if (overlay) overlay.remove();
    await loadUsers();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.deleteUser = async function(uid, name) {
  if (!confirm(`"${name}" kullanıcısını kalıcı olarak silmek istiyor musunuz?\nBu işlem geri alınamaz.`)) return;
  try {
    await deleteDoc(doc(db, "users", uid));
    await logActivity("user_deleted", `${name} silindi`);
    showToast("Kullanıcı silindi.", "success");
    await loadUsers();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

// ══════════════════════════════════════════════
// İZİNLER TABLOSU
// ══════════════════════════════════════════════
function renderPermsTable(perms) {
  const container = document.getElementById("perms-table");
  if (!container) return;
  if (!perms.length) {
    container.innerHTML = `<div class="empty-state"><p>Henüz izin tanımlanmamış.</p></div>`;
    return;
  }
  const now = new Date();
  container.innerHTML = `
    <table class="admin-table">
      <thead><tr>
        <th>Kullanıcı</th><th>Araç</th><th>Durum</th>
        <th>Başlangıç</th><th>Bitiş</th><th>Not</th><th>İşlem</th>
      </tr></thead>
      <tbody>
        ${perms.map(p => {
          const isExp = p.expiresAt && p.expiresAt.toDate() < now;
          const badge = !p.active
            ? `<span class="badge badge-danger">Pasif</span>`
            : isExp
            ? `<span class="badge badge-warning">Doldu</span>`
            : `<span class="badge badge-success">Aktif</span>`;
          const end = p.expiresAt
            ? p.expiresAt.toDate().toLocaleDateString("tr-TR")
            : `<span style="color:var(--accent-success);">Süresiz</span>`;
          return `<tr>
            <td style="font-weight:var(--font-semibold);">${esc(getUserName(p.userId))}</td>
            <td>${TOOL_MAP[p.toolId] || p.toolId}</td>
            <td>${badge}</td>
            <td style="font-size:var(--text-xs);color:var(--text-muted);">${fmtDate(p.startsAt)}</td>
            <td style="font-size:var(--text-xs);">${end}</td>
            <td style="font-size:var(--text-xs);color:var(--text-muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.note || "—"}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="openEditPerm('${p.id}')">✏️</button></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

window.filterPermsByUser = function(uid) {
  switchTab("permissions");
  renderPermsTable(allPerms.filter(p => p.userId === uid));
};

// ── Grant Modal ───────────────────────────────
window.openGrantModal = function() {
  editingPermId = null;
  setEl("grantModalTitle", "Araç Erişimi Ver");
  document.getElementById("editPermId").value       = "";
  document.getElementById("grantUserId").value      = "";
  document.getElementById("grantToolId").value      = "";
  document.getElementById("grantStartDate").value   = todayStr();
  document.getElementById("grantEndDate").value     = "";
  document.getElementById("grantNote").value        = "";
  document.getElementById("grantActive").checked    = true;
  document.getElementById("grantError").classList.add("hidden");
  document.getElementById("deletePermBtn").classList.add("hidden");
  fillUserSelect();
  document.getElementById("grantModal").style.display = "flex";
};

window.openGrantModalForUser = function(uid) {
  openGrantModal();
  document.getElementById("grantUserId").value = uid;
};

window.openEditPerm = function(id) {
  const p = allPerms.find(p => p.id === id);
  if (!p) return;
  editingPermId = id;
  setEl("grantModalTitle", "İzni Düzenle");
  document.getElementById("editPermId").value     = id;
  document.getElementById("grantUserId").value    = p.userId;
  document.getElementById("grantToolId").value    = p.toolId;
  document.getElementById("grantStartDate").value = p.startsAt  ? p.startsAt.toDate().toISOString().split("T")[0]  : "";
  document.getElementById("grantEndDate").value   = p.expiresAt ? p.expiresAt.toDate().toISOString().split("T")[0] : "";
  document.getElementById("grantNote").value      = p.note || "";
  document.getElementById("grantActive").checked  = p.active !== false;
  document.getElementById("grantError").classList.add("hidden");
  document.getElementById("deletePermBtn").classList.remove("hidden");
  fillUserSelect();
  document.getElementById("grantModal").style.display = "flex";
};

function fillUserSelect() {
  const sel  = document.getElementById("grantUserId");
  const prev = sel.value;
  sel.innerHTML = `<option value="">Kullanıcı seçin…</option>`;
  allUsers.filter(u => u.status === "active" || u.status === undefined).forEach(u => {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = `${u.displayName || u.email} (${u.email})`;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

window.closeGrantModal = function() {
  document.getElementById("grantModal").style.display = "none";
  editingPermId = null;
};

window.savePerm = async function() {
  const userId = document.getElementById("grantUserId").value;
  const toolId = document.getElementById("grantToolId").value;
  const startD = document.getElementById("grantStartDate").value;
  const endD   = document.getElementById("grantEndDate").value;
  const note   = document.getElementById("grantNote").value.trim();
  const active = document.getElementById("grantActive").checked;

  if (!userId || !toolId) {
    document.getElementById("grantErrorText").textContent = "Kullanıcı ve araç seçimi zorunludur.";
    document.getElementById("grantError").classList.remove("hidden");
    return;
  }

  const data = {
    userId, toolId, active,
    note:      note || null,
    startsAt:  startD ? Timestamp.fromDate(new Date(startD))                : null,
    expiresAt: endD   ? Timestamp.fromDate(new Date(endD + "T23:59:59"))    : null,
    grantedBy: currentAdmin.uid,
    updatedAt: serverTimestamp()
  };

  try {
    if (editingPermId) {
      await updateDoc(doc(db, "user_permissions", editingPermId), data);
      showToast("İzin güncellendi ✅", "success");
    } else {
      data.grantedAt = serverTimestamp();
      await addDoc(collection(db, "user_permissions"), data);
      await logActivity("permission_granted", `${getUserName(userId)} → ${TOOL_MAP[toolId] || toolId}`);

      // Kullanıcıya bildirim gönder
      const toolLabel = TOOL_MAP[toolId] || toolId;
      const expText   = data.expiresAt
        ? ` (${new Date(document.getElementById("grantEndDate").value).toLocaleDateString("tr-TR")} tarihine kadar)`
        : " (Süresiz)";
      await writeNotification(
        userId,
        "permission_granted",
        "Araç Erişimi Verildi",
        `${toolLabel} aracına erişim izniniz tanımlandı${expText}.`
      );

      showToast("İzin verildi ✅", "success");
    }
    closeGrantModal();
    await loadPermissions();
    window.renderUsersTable();
  } catch (err) {
    document.getElementById("grantErrorText").textContent = "Hata: " + err.message;
    document.getElementById("grantError").classList.remove("hidden");
  }
};

window.deletePerm = async function() {
  if (!editingPermId || !confirm("Bu izni silmek istiyor musunuz?")) return;
  try {
    await deleteDoc(doc(db, "user_permissions", editingPermId));
    showToast("İzin silindi.", "success");
    closeGrantModal();
    await loadPermissions();
  } catch (err) { showToast("Silinemedi: " + err.message, "error"); }
};

// ══════════════════════════════════════════════
// DAVET SİSTEMİ
// ══════════════════════════════════════════════
function buildInviteToolsList() {
  const el = document.getElementById("inviteToolsList");
  if (!el) return;
  el.innerHTML = TOOLS.map(t => `
    <label class="tool-check-item">
      <input type="checkbox" name="invite-tool" value="${t.id}" />
      <span>${t.label}</span>
    </label>`).join("");
}

window.selectInviteDuration = function(btn) {
  document.querySelectorAll(".invite-duration").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
};

function generateToken() {
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 8)).join("-");
}

window.createInvite = async function() {
  const email   = document.getElementById("inviteEmail").value.trim();
  const role    = document.getElementById("inviteRole").value;
  const tools   = [...document.querySelectorAll("input[name='invite-tool']:checked")].map(c => c.value);
  const dBtn    = document.querySelector(".invite-duration.active");
  const months  = dBtn?.dataset.months ? parseInt(dBtn.dataset.months) : null;
  const message = document.getElementById("inviteMessage").value.trim();

  if (!email)        { showToast("E-posta adresi gereklidir.", "warning"); return; }
  if (!tools.length) { showToast("En az bir araç seçin.", "warning"); return; }

  const token  = generateToken();
  const linkExpiry = new Date(); linkExpiry.setDate(linkExpiry.getDate() + 7);

  // Site kök URL'ini hesapla
  const parts = window.location.pathname.split("/").filter(Boolean);
  const base  = window.location.origin + (parts.length > 1 ? "/" + parts.slice(0, -1).join("/") + "/" : "/");
  const inviteUrl = `${base}login.html?invite=${token}`;

  try {
    await setDoc(doc(db, "invitations", token), {
      email, role, tools,
      durationMonths: months,
      message:        message || null,
      invitedBy:      currentAdmin.uid,
      invitedByEmail: currentAdmin.email,
      createdAt:      serverTimestamp(),
      expiresAt:      Timestamp.fromDate(linkExpiry),
      used: false, usedBy: null, usedAt: null
    });

    await logActivity("invite_created", `${email} için davet oluşturuldu`);

    document.getElementById("inviteResultUrl").value = inviteUrl;
    document.getElementById("inviteResult").style.display = "block";
    showToast("Davet linki oluşturuldu. Kopyalayıp paylaşın.", "success");
    await loadInvitations();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.copyInviteUrl = function() {
  const input = document.getElementById("inviteResultUrl");
  input.select();
  navigator.clipboard.writeText(input.value)
    .then(() => showToast("Link kopyalandı ✅", "success"))
    .catch(() => { document.execCommand("copy"); showToast("Kopyalandı.", "success"); });
};

async function loadInvitations() {
  try {
    const snap    = await getDocs(collection(db, "invitations"));
    const invites = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(i => !i.used)
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    renderInviteList(invites);
  } catch (err) { console.warn("Davetler yüklenemedi:", err.message); }
}

function renderInviteList(invites) {
  const el = document.getElementById("invite-list");
  if (!el) return;
  if (!invites.length) {
    el.innerHTML = `<div style="text-align:center;padding:var(--space-8);color:var(--text-muted);font-size:var(--text-sm);">Aktif davet yok.</div>`;
    return;
  }
  el.innerHTML = invites.map(inv => `
    <div style="display:flex;align-items:center;gap:var(--space-4);padding:var(--space-4);border-bottom:1px solid var(--border-subtle);">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:var(--font-semibold);font-size:var(--text-sm);">${esc(inv.email)}</div>
        <div style="font-size:var(--text-xs);color:var(--text-muted);margin-top:2px;">
          ${inv.tools?.map(t => TOOL_MAP[t] || t).join(", ")} ·
          ${inv.durationMonths ? inv.durationMonths + " ay" : "Süresiz"} ·
          Son: ${inv.expiresAt ? inv.expiresAt.toDate().toLocaleDateString("tr-TR") : "—"}
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);flex-shrink:0;"
        onclick="revokeInvite('${inv.id}')">İptal</button>
    </div>`).join("");
}

window.revokeInvite = async function(id) {
  if (!confirm("Bu daveti iptal etmek istiyor musunuz?")) return;
  try {
    await deleteDoc(doc(db, "invitations", id));
    showToast("Davet iptal edildi.", "info");
    await loadInvitations();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

// ══════════════════════════════════════════════
// AKTİVİTE LOGLARI
// ══════════════════════════════════════════════
async function loadLogs() {
  const container = document.getElementById("logs-list");
  if (!container) return;
  try {
    const snap = await getDocs(collection(db, "admin_logs"));
    const logs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
      .slice(0, 100);

    if (!logs.length) {
      container.innerHTML = `<div class="empty-state"><p>Henüz aktivite kaydı yok.</p></div>`;
      return;
    }

    const icons = {
      permission_granted: "🔑", permission_revoked: "🚫",
      user_approved: "✅",      user_rejected: "❌",
      user_deleted: "🗑️",       user_suspended: "⏸",
      user_activated: "▶",      role_changed: "🔄",
      invite_created: "✉️",     user_login: "👤",
      system: "⚙️"
    };

    container.innerHTML = logs.map(l => `
      <div style="display:flex;align-items:center;gap:var(--space-4);padding:var(--space-3) var(--space-5);border-bottom:1px solid var(--border-subtle);">
        <span style="font-size:1.1rem;width:24px;text-align:center;flex-shrink:0;">${icons[l.type] || "📋"}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:var(--text-sm);font-weight:var(--font-semibold);">${esc(l.description || "—")}</div>
          <div style="font-size:var(--text-xs);color:var(--text-muted);">
            ${l.adminEmail ? esc(l.adminEmail) + " · " : ""}${l.createdAt?.toDate ? l.createdAt.toDate().toLocaleString("tr-TR") : "—"}
          </div>
        </div>
      </div>`).join("");
  } catch {
    container.innerHTML = `<div class="empty-state"><p>Log yüklenemedi.</p></div>`;
  }
}

async function logActivity(type, description) {
  try {
    await addDoc(collection(db, "admin_logs"), {
      type, description,
      adminId:    currentAdmin?.uid,
      adminEmail: currentAdmin?.email,
      createdAt:  serverTimestamp()
    });
  } catch { /* sessizce geç */ }
}

// ══════════════════════════════════════════════
// BLOG YÖNETİMİ
// ══════════════════════════════════════════════
let blogCurrentSub = "pending";
let allBlogPosts   = [];

async function loadBlogPosts() {
  try {
    const snap = await getDocs(collection(db, "posts"));
    allBlogPosts = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    renderBlogSub(blogCurrentSub);
    updateBlogTabBadge();
  } catch (err) {
    showToast("Blog yazıları yüklenemedi: " + err.message, "error");
  }
}

function updateBlogTabBadge() {
  const pending = allBlogPosts.filter(p => p.status === "pending_review").length;
  const btn = document.getElementById("blogTabBtn");
  if (btn) {
    btn.innerHTML = pending > 0
      ? `✍️ Blog <span class="tab-badge">${pending}</span>`
      : "✍️ Blog";
  }
}

window.switchBlogSub = function(sub) {
  blogCurrentSub = sub;
  document.querySelectorAll(".blog-subtab").forEach(b => {
    const isActive = b.dataset.sub === sub;
    b.style.borderBottomColor = isActive ? "var(--accent-primary)" : "transparent";
    b.style.color = isActive ? "var(--accent-primary)" : "var(--text-muted)";
  });
  renderBlogSub(sub);
};

function renderBlogSub(sub) {
  document.getElementById("blog-pending-list").style.display = sub === "pending" ? "block" : "none";
  document.getElementById("blog-all-list").style.display     = sub === "all"     ? "block" : "none";

  if (sub === "pending") renderBlogPending();
  else                   renderBlogAll();
}

function renderBlogPending() {
  const container = document.getElementById("blog-pending-list");
  const pending   = allBlogPosts.filter(p => p.status === "pending_review");

  if (!pending.length) {
    container.innerHTML = `<div class="empty-state"><div>✅</div><p>İnceleme bekleyen yazı yok.</p></div>`;
    return;
  }

  container.innerHTML = pending.map(p => {
    const author = allUsers.find(u => u.id === p.authorId);
    const authorName = author ? (author.displayName || author.email) : "Bilinmiyor";
    return `
      <div style="border:1px solid var(--border-subtle);border-radius:var(--border-radius);padding:var(--space-5);margin-bottom:var(--space-4);background:var(--bg-surface);">
        <div style="display:flex;align-items:flex-start;gap:var(--space-4);flex-wrap:wrap;">
          ${p.coverImage
            ? `<img src="${esc(p.coverImage)}" alt="" style="width:80px;height:60px;object-fit:cover;border-radius:6px;flex-shrink:0;" onerror="this.style.display='none'" />`
            : `<div style="width:80px;height:60px;background:var(--bg-surface-3);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">✍️</div>`
          }
          <div style="flex:1;min-width:200px;">
            <div style="font-weight:var(--font-bold);font-size:var(--text-base);margin-bottom:4px;">${esc(p.title)}</div>
            <div style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:6px;">
              ✍️ ${esc(authorName)} · 📅 ${fmtDate(p.createdAt)} ·
              ${p.category === "scientific"
                ? `<span class="badge badge-info" style="font-size:10px;">Bilimsel</span>`
                : `<span class="badge badge-primary" style="font-size:10px;">Kişisel</span>`}
            </div>
            ${p.excerpt ? `<p style="font-size:var(--text-sm);color:var(--text-secondary);margin:0;line-height:1.5;">${esc(p.excerpt)}</p>` : ""}
          </div>
          <div style="display:flex;gap:var(--space-2);flex-shrink:0;">
            <a href="blog-post.html?id=${p.id}" target="_blank" class="btn btn-ghost btn-sm">👁️ Önizle</a>
            <button class="btn btn-success btn-sm" onclick="approvePost('${p.id}')">✅ Onayla</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);" onclick="openRejectModal('${p.id}')">❌ Reddet</button>
          </div>
        </div>
      </div>`;
  }).join("");
}

function renderBlogAll() {
  const container = document.getElementById("blog-all-list");
  if (!allBlogPosts.length) {
    container.innerHTML = `<div class="empty-state"><p>Henüz yazı yok.</p></div>`;
    return;
  }

  container.innerHTML = `
    <table class="admin-table">
      <thead><tr>
        <th>Başlık</th><th>Yazar</th><th>Kategori</th><th>Durum</th><th>Tarih</th><th>İşlem</th>
      </tr></thead>
      <tbody>
        ${allBlogPosts.map(p => {
          const author = allUsers.find(u => u.id === p.authorId);
          const authorName = author ? (author.displayName || author.email) : "—";
          const statusMap = {
            published:      `<span class="badge badge-success">Yayında</span>`,
            pending_review: `<span class="badge badge-warning">İnceleniyor</span>`,
            draft:          `<span class="badge badge-muted">Taslak</span>`,
            rejected:       `<span class="badge badge-danger">Reddedildi</span>`,
          };
          const badge = statusMap[p.status] || (p.published
            ? `<span class="badge badge-success">Yayında</span>`
            : `<span class="badge badge-muted">Taslak</span>`);
          return `<tr>
            <td style="font-weight:var(--font-semibold);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.title)}</td>
            <td style="font-size:var(--text-sm);color:var(--text-muted);">${esc(authorName)}</td>
            <td>${p.category === "scientific" ? "📄 Bilimsel" : "✍️ Kişisel"}</td>
            <td>${badge}</td>
            <td style="font-size:var(--text-xs);color:var(--text-muted);">${fmtDate(p.createdAt)}</td>
            <td>
              <div style="display:flex;gap:4px;">
                ${p.published
                  ? `<button class="btn btn-ghost btn-sm" style="color:var(--accent-warning);" onclick="unpublishPost('${p.id}')">⏸ Yayından Al</button>`
                  : p.status === "pending_review"
                  ? `<button class="btn btn-success btn-sm" onclick="approvePost('${p.id}')">✅ Onayla</button>`
                  : ""}
                <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);" onclick="adminDeletePost('${p.id}','${esc(p.title)}')">🗑️</button>
              </div>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

window.approvePost = async function(postId) {
  try {
    await updateDoc(doc(db, "posts", postId), {
      status:    "published",
      published: true,
      reviewedBy: currentAdmin.uid,
      reviewedAt: serverTimestamp(),
      rejectionReason: null
    });
    const p = allBlogPosts.find(p => p.id === postId);
    await logActivity("post_approved", `"${p?.title || postId}" yazısı onaylandı`);

    // Yazara bildirim gönder
    if (p?.authorId) {
      await writeNotification(
        p.authorId,
        "post_approved",
        "Yazınız Yayınlandı",
        `"${p.title}" başlıklı yazınız incelenerek yayınlandı.`
      );
    }

    showToast("Yazı yayınlandı ✅", "success");
    await loadBlogPosts();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.openRejectModal = function(postId) {
  document.getElementById("rejectPostId").value = postId;
  document.getElementById("rejectReason").value = "";
  document.getElementById("rejectPostModal").style.display = "flex";
};

window.closeRejectModal = function() {
  document.getElementById("rejectPostModal").style.display = "none";
};

window.confirmRejectPost = async function() {
  const postId = document.getElementById("rejectPostId").value;
  const reason = document.getElementById("rejectReason").value.trim();
  if (!reason) { showToast("Gerekçe girmelisiniz.", "warning"); return; }

  try {
    await updateDoc(doc(db, "posts", postId), {
      status:         "rejected",
      published:      false,
      reviewedBy:     currentAdmin.uid,
      reviewedAt:     serverTimestamp(),
      rejectionReason: reason
    });
    const p = allBlogPosts.find(p => p.id === postId);
    await logActivity("post_rejected", `"${p?.title || postId}" reddedildi`);

    // Yazara bildirim gönder
    if (p?.authorId) {
      await writeNotification(
        p.authorId,
        "post_rejected",
        "Yazınız Reddedildi",
        `"${p.title}" başlıklı yazınız reddedildi. Gerekçe: ${reason}`
      );
    }

    showToast("Yazı reddedildi.", "info");
    closeRejectModal();
    await loadBlogPosts();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.unpublishPost = async function(postId) {
  if (!confirm("Bu yazıyı yayından kaldırmak istiyor musunuz?")) return;
  try {
    await updateDoc(doc(db, "posts", postId), { status: "draft", published: false });
    showToast("Yazı yayından kaldırıldı.", "info");
    await loadBlogPosts();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.adminDeletePost = async function(postId, title) {
  if (!confirm(`"${title}" yazısını kalıcı olarak silmek istiyor musunuz?`)) return;
  try {
    await deleteDoc(doc(db, "posts", postId));
    await logActivity("post_deleted", `"${title}" silindi`);
    showToast("Yazı silindi.", "success");
    await loadBlogPosts();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

// ══════════════════════════════════════════════
// TAB YÖNETİMİ
// ══════════════════════════════════════════════
window.switchTab = function(tab) {
  document.querySelectorAll(".admin-tab")
    .forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".tab-content")
    .forEach(c => { c.style.display = c.id === `tab-${tab}` ? "block" : "none"; });

  if (tab === "invite") loadInvitations();
  if (tab === "logs")   loadLogs();
  if (tab === "blog")   loadBlogPosts();
  if (tab === "site" && typeof window.initSiteConfigAdmin === "function") window.initSiteConfigAdmin();
};

// ══════════════════════════════════════════════
// YARDIMCILAR
// ══════════════════════════════════════════════
function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("tr-TR");
}

function nameInitials(u) {
  return (u.displayName || u.email || "?")
    .split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getUserName(uid) {
  const u = allUsers.find(u => u.id === uid);
  return u ? (u.displayName || u.email) : uid?.slice(0, 8) + "…";
}

function statusBadge(status) {
  const map = {
    active:    `<span class="badge badge-success">Aktif</span>`,
    pending:   `<span class="badge badge-warning">Onay Bekliyor</span>`,
    suspended: `<span class="badge badge-danger">Askıda</span>`,
    rejected:  `<span class="badge" style="background:var(--bg-surface-3);color:var(--text-muted);">Reddedildi</span>`,
  };
  return map[status] || `<span class="badge badge-muted">${status || "Bilinmiyor"}</span>`;
}

function roleBadge(role) {
  const map = {
    superadmin: `<span class="badge" style="background:#f97316;color:#fff;">⭐ Süper Admin</span>`,
    admin:      `<span class="badge badge-primary">🔑 Admin</span>`,
    editor:     `<span class="badge" style="background:var(--accent-info,#0ea5e9);color:#fff;">✍️ Editör</span>`,
    user:       `<span class="badge badge-muted">👤 Kullanıcı</span>`,
  };
  return map[role] || `<span class="badge badge-muted">${role || "—"}</span>`;
}
