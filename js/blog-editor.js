/**
 * blog-editor.js — Blog Editörü
 * Editör ve admin rolündeki kullanıcılar yazı oluşturabilir.
 * Akış: Taslak → İncelemeye Gönder → Admin onaylar → Yayında
 */

import { auth, db, showToast } from "./app.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, query, where, getDocs, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let currentUser     = null;
let currentUserRole = null;
let editingPostId   = null;
let myPosts         = [];

// ══════════════════════════════════════════════
// AUTH KONTROLÜ
// ══════════════════════════════════════════════
onAuthStateChanged(auth, async (user) => {
  document.getElementById("page-loading").style.display = "none";

  if (!user) {
    document.getElementById("auth-gate").style.display = "flex";
    return;
  }

  // Rol kontrolü — sadece editor/admin/superadmin erişebilir
  try {
    const { getDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists()) { showNoAccess(); return; }

    const role   = snap.data().role;
    const status = snap.data().status || "active";

    if (!["editor", "admin", "superadmin"].includes(role)) { showNoAccess(); return; }
    if (status !== "active") { showNoAccess(); return; }

    currentUser     = user;
    currentUserRole = role;

    // Badge
    const badge = document.getElementById("editorRoleBadge");
    if (badge) {
      if (role === "superadmin") { badge.textContent = "⭐ Süper Admin"; badge.style.background = "#f97316"; }
      else if (role === "admin") { badge.textContent = "🔑 Admin"; }
    }

    document.getElementById("main-content").style.display = "block";
    await loadMyPosts();
  } catch (err) {
    console.error(err);
    showNoAccess();
  }
});

function showNoAccess() {
  document.getElementById("auth-gate").style.display = "flex";
  document.getElementById("auth-gate").innerHTML = `
    <div style="text-align:center;padding:var(--space-8);">
      <div style="font-size:4rem;margin-bottom:var(--space-4);">🔒</div>
      <h2 style="margin-bottom:var(--space-3);">Erişim Yetkiniz Yok</h2>
      <p style="color:var(--text-muted);margin-bottom:var(--space-5);">Bu sayfa yalnızca editör ve admin kullanıcılara açıktır.</p>
      <a href="../dashboard.html" class="btn btn-primary">Dashboard'a Dön</a>
    </div>`;
}

// ══════════════════════════════════════════════
// YAZILARI YÜKLEyÜKLE
// ══════════════════════════════════════════════
async function loadMyPosts() {
  try {
    // Admin/superadmin tüm yazıları görür; editör sadece kendinkini
    let snap;
    if (currentUserRole === "admin" || currentUserRole === "superadmin") {
      snap = await getDocs(collection(db, "posts"));
    } else {
      snap = await getDocs(query(
        collection(db, "posts"),
        where("authorId", "==", currentUser.uid)
      ));
    }

    myPosts = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

    renderMyPosts();
  } catch (err) {
    showToast("Yazılar yüklenemedi: " + err.message, "error");
  }
}

function renderMyPosts() {
  const container = document.getElementById("my-posts-list");
  if (!container) return;

  if (!myPosts.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:var(--space-12);color:var(--text-muted);">
        <div style="font-size:2.5rem;margin-bottom:var(--space-3);">✍️</div>
        <p>Henüz hiç yazınız yok. İlk yazınızı oluşturun!</p>
        <button class="btn btn-primary" style="margin-top:var(--space-4);" onclick="switchEditorTab('write')">
          ➕ Yazı Yaz
        </button>
      </div>`;
    return;
  }

  const statusLabels = {
    draft:          `<span class="badge badge-muted">📄 Taslak</span>`,
    pending_review: `<span class="badge badge-warning">⏳ İncelemede</span>`,
    published:      `<span class="badge badge-success">✅ Yayında</span>`,
    rejected:       `<span class="badge badge-danger">❌ Reddedildi</span>`,
  };

  container.innerHTML = myPosts.map(p => {
    const statusKey = p.status || (p.published ? "published" : "draft");
    const badge     = statusLabels[statusKey] || statusLabels.draft;
    const canEdit   = !p.published && statusKey !== "pending_review";
    const canSubmit = statusKey === "draft" || statusKey === "rejected";

    return `
      <div class="my-post-card">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:var(--font-bold);margin-bottom:4px;">${esc(p.title)}</div>
          <div style="font-size:var(--text-xs);color:var(--text-muted);">
            📅 ${fmtDate(p.createdAt)} · ${badge}
          </div>
          ${statusKey === "rejected" && p.rejectionReason
            ? `<div style="font-size:var(--text-xs);color:var(--accent-danger);margin-top:4px;">
                ❌ Red: ${esc(p.rejectionReason)}
               </div>`
            : ""}
        </div>
        <div style="display:flex;gap:var(--space-2);flex-shrink:0;flex-wrap:wrap;">
          ${canEdit
            ? `<button class="btn btn-ghost btn-sm" onclick="editPost('${p.id}')">✏️ Düzenle</button>`
            : ""}
          ${canSubmit
            ? `<button class="btn btn-primary btn-sm" onclick="quickSubmit('${p.id}')">📤 Gönder</button>`
            : ""}
          ${statusKey === "published"
            ? `<a href="../blog-post.html?id=${p.id}" target="_blank" class="btn btn-ghost btn-sm">👁️ Görüntüle</a>`
            : ""}
          ${!p.published
            ? `<button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);" onclick="deleteMyPost('${p.id}','${esc(p.title)}')">🗑️</button>`
            : ""}
        </div>
      </div>`;
  }).join("");
}

// ══════════════════════════════════════════════
// YAZMA / DÜZENLEME
// ══════════════════════════════════════════════
window.newPost = function() {
  cancelEdit();
  switchEditorTab("write");
};

window.editPost = function(postId) {
  const post = myPosts.find(p => p.id === postId);
  if (!post) return;
  editingPostId = postId;

  document.getElementById("postTitle").value   = post.title || "";
  document.getElementById("postExcerpt").value = post.excerpt || "";
  document.getElementById("postContent").value = post.content || "";
  document.getElementById("postCategory").value = post.category || "personal";
  document.getElementById("postTags").value    = post.tags?.join(", ") || "";
  document.getElementById("postCover").value   = post.coverImage || "";

  previewCover();
  updateStatusDisplay(post.status || (post.published ? "published" : "draft"), post.rejectionReason);
  showEditingBanner();
  switchEditorTab("write");
  window.scrollTo({ top: 0, behavior: "smooth" });
};

window.cancelEdit = function() {
  editingPostId = null;
  document.getElementById("postTitle").value   = "";
  document.getElementById("postExcerpt").value = "";
  document.getElementById("postContent").value = "";
  document.getElementById("postCategory").value = "personal";
  document.getElementById("postTags").value    = "";
  document.getElementById("postCover").value   = "";
  document.getElementById("coverPreview").style.display = "none";
  document.getElementById("editing-banner").style.display  = "none";
  document.getElementById("rejectionCard").style.display   = "none";
  updateStatusDisplay("draft");
};

function showEditingBanner() {
  document.getElementById("editing-banner").style.display = "flex";
}

function updateStatusDisplay(status, rejectionReason) {
  const labels = {
    draft:          `<span class="badge badge-muted">📄 Taslak</span>`,
    pending_review: `<span class="badge badge-warning">⏳ İncelemede</span>`,
    published:      `<span class="badge badge-success">✅ Yayında</span>`,
    rejected:       `<span class="badge badge-danger">❌ Reddedildi</span>`,
  };
  const el = document.getElementById("postStatusDisplay");
  if (el) el.innerHTML = labels[status] || labels.draft;

  const rejCard = document.getElementById("rejectionCard");
  if (rejCard) {
    if (status === "rejected" && rejectionReason) {
      rejCard.style.display = "block";
      document.getElementById("rejectionText").textContent = rejectionReason;
    } else {
      rejCard.style.display = "none";
    }
  }
}

function getFormData() {
  return {
    title:     document.getElementById("postTitle").value.trim(),
    excerpt:   document.getElementById("postExcerpt").value.trim(),
    content:   document.getElementById("postContent").value.trim(),
    category:  document.getElementById("postCategory").value,
    tags:      document.getElementById("postTags").value.split(",").map(t => t.trim()).filter(Boolean),
    coverImage: document.getElementById("postCover").value.trim() || null,
  };
}

window.saveDraft = async function() {
  const data = getFormData();
  if (!data.title) { showToast("Başlık zorunludur.", "warning"); return; }

  const payload = {
    ...data,
    published: false,
    status:    "draft",
    updatedAt: serverTimestamp()
  };

  try {
    if (editingPostId) {
      await updateDoc(doc(db, "posts", editingPostId), payload);
      showToast("Taslak güncellendi.", "success");
    } else {
      payload.authorId  = currentUser.uid;
      payload.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, "posts"), payload);
      editingPostId = ref.id;
      showEditingBanner();
    }
    updateStatusDisplay("draft");
    showMsg("Taslak kaydedildi.");
    await loadMyPosts();
  } catch (err) { showToast("Kayıt başarısız: " + err.message, "error"); }
};

window.submitForReview = async function() {
  const data = getFormData();
  if (!data.title)   { showToast("Başlık zorunludur.", "warning"); return; }
  if (!data.content) { showToast("İçerik zorunludur.", "warning"); return; }

  if (!confirm("Yazıyı incelemeye göndermek istiyor musunuz? Admin onayladıktan sonra yayınlanacaktır.")) return;

  const payload = {
    ...data,
    published: false,
    status:    "pending_review",
    submittedAt: serverTimestamp(),
    updatedAt:   serverTimestamp(),
    rejectionReason: null
  };

  try {
    if (editingPostId) {
      await updateDoc(doc(db, "posts", editingPostId), payload);
    } else {
      payload.authorId  = currentUser.uid;
      payload.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, "posts"), payload);
      editingPostId = ref.id;
    }
    updateStatusDisplay("pending_review");
    showMsg("İncelemeye gönderildi! Admin onayından sonra yayınlanacak.", 5000);
    document.getElementById("editing-banner").style.display = "none";
    showToast("İncelemeye gönderildi ✅", "success");
    await loadMyPosts();
    switchEditorTab("myposts");
  } catch (err) { showToast("Gönderme başarısız: " + err.message, "error"); }
};

window.quickSubmit = async function(postId) {
  const post = myPosts.find(p => p.id === postId);
  if (!post) return;
  if (!confirm(`"${post.title}" yazısını incelemeye göndermek istiyor musunuz?`)) return;
  try {
    await updateDoc(doc(db, "posts", postId), {
      status: "pending_review",
      submittedAt: serverTimestamp(),
      rejectionReason: null
    });
    showToast("İncelemeye gönderildi ✅", "success");
    await loadMyPosts();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

window.deleteMyPost = async function(postId, title) {
  if (!confirm(`"${title}" yazısını silmek istiyor musunuz?`)) return;
  try {
    await deleteDoc(doc(db, "posts", postId));
    if (editingPostId === postId) cancelEdit();
    showToast("Yazı silindi.", "success");
    await loadMyPosts();
  } catch (err) { showToast("Hata: " + err.message, "error"); }
};

// ══════════════════════════════════════════════
// TOOLBAR
// ══════════════════════════════════════════════
window.fmt = function(type) {
  const ta = document.getElementById("postContent");
  const start = ta.selectionStart, end = ta.selectionEnd;
  const sel   = ta.value.substring(start, end);
  const tagMap = { bold: ["<strong>", "</strong>"], italic: ["<em>", "</em>"] };
  const [open, close] = tagMap[type];
  ta.value = ta.value.substring(0, start) + open + sel + close + ta.value.substring(end);
  ta.focus();
  ta.selectionStart = start + open.length;
  ta.selectionEnd   = start + open.length + sel.length;
};

window.fmtHeading = function(level) {
  const ta    = document.getElementById("postContent");
  const start = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf("\n", start - 1) + 1;
  const tag = `<h${level}>`;
  const closeTag = `</h${level}>`;
  const lineEnd = ta.value.indexOf("\n", start);
  const end = lineEnd === -1 ? ta.value.length : lineEnd;
  const line = ta.value.substring(lineStart, end);
  ta.value = ta.value.substring(0, lineStart) + tag + line + closeTag + ta.value.substring(end);
  ta.focus();
};

window.fmtList = function(type) {
  const ta  = document.getElementById("postContent");
  const pos = ta.selectionStart;
  const tag = type === "ul"
    ? "\n<ul>\n  <li></li>\n</ul>\n"
    : "\n<ol>\n  <li></li>\n</ol>\n";
  ta.value = ta.value.substring(0, pos) + tag + ta.value.substring(pos);
  ta.focus();
};

window.fmtLink = function() {
  const ta    = document.getElementById("postContent");
  const start = ta.selectionStart, end = ta.selectionEnd;
  const sel   = ta.value.substring(start, end) || "link metni";
  const url   = prompt("URL girin:", "https://");
  if (!url) return;
  const tag = `<a href="${url}" target="_blank">${sel}</a>`;
  ta.value = ta.value.substring(0, start) + tag + ta.value.substring(end);
  ta.focus();
};

window.fmtBlockquote = function() {
  const ta    = document.getElementById("postContent");
  const start = ta.selectionStart, end = ta.selectionEnd;
  const sel   = ta.value.substring(start, end) || "Alıntı metni";
  const tag   = `<blockquote>${sel}</blockquote>`;
  ta.value = ta.value.substring(0, start) + tag + ta.value.substring(end);
  ta.focus();
};

// ══════════════════════════════════════════════
// YARDIMCILAR
// ══════════════════════════════════════════════
window.autoSlug = function() { /* slug ileride eklenebilir */ };

window.previewCover = function() {
  const url     = document.getElementById("postCover").value.trim();
  const preview = document.getElementById("coverPreview");
  const img     = document.getElementById("coverImg");
  if (url) {
    img.src = url;
    preview.style.display = "block";
    img.onerror = () => { preview.style.display = "none"; };
  } else {
    preview.style.display = "none";
  }
};

window.switchEditorTab = function(tab) {
  document.querySelectorAll(".editor-tab")
    .forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  document.getElementById("editor-tab-write").style.display    = tab === "write"    ? "block" : "none";
  document.getElementById("editor-tab-myposts").style.display  = tab === "myposts"  ? "block" : "none";
  if (tab === "myposts") loadMyPosts();
};

function showMsg(text, duration = 3000) {
  const el = document.getElementById("postStatusMsg");
  if (!el) return;
  el.textContent = text;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, duration);
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("tr-TR");
}

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
