/**
 * blog-post.js — Tekil yazı sayfası
 */

import { auth, db, showToast, formatDate } from "./app.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, getDocs, collection,
  query, where, orderBy, limit,
  updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const params = new URLSearchParams(window.location.search);
const postId = params.get("id");

const loadingEl   = document.getElementById("post-loading");
const notFoundEl  = document.getElementById("post-not-found");
const contentEl   = document.getElementById("post-content");

let currentPost = null;
let isAdmin     = false;

// ─── Auth ───
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const role = snap.data().role;
    if (snap.exists() && (role === "admin" || role === "superadmin")) {
      isAdmin = true;
      document.getElementById("post-admin-actions")?.classList.remove("hidden");
    }
  } catch {}
});

// ─── Sayfa Yükle ───
document.addEventListener("DOMContentLoaded", async () => {
  if (!postId) { showNotFound(); return; }
  await loadPost();
  setupEditModal();
});

async function loadPost() {
  try {
    const snap = await getDoc(doc(db, "posts", postId));
    if (!snap.exists() || snap.data().published === false) {
      showNotFound();
      return;
    }

    currentPost = { id: snap.id, ...snap.data() };
    renderPost(currentPost);
    loadSidebarPosts(currentPost.id, currentPost.category);
  } catch (err) {
    console.error(err);
    showNotFound();
  }
}

function showNotFound() {
  loadingEl.style.display  = "none";
  notFoundEl.classList.remove("hidden");
}

function renderPost(post) {
  loadingEl.style.display = "none";
  contentEl.classList.remove("hidden");

  // Meta tags
  document.title = `${post.title} — ozisg.com`;

  // Kapak
  if (post.coverImage) {
    document.getElementById("post-cover-wrap").innerHTML =
      `<img src="${post.coverImage}" alt="${post.title}"
        style="width:100%;max-height:460px;object-fit:cover;" />`;
  }

  // Kategori badge
  const cat = post.category === "scientific"
    ? '<span class="badge badge-info" style="font-size:var(--text-sm);padding:6px 14px;">📄 Bilimsel Makale</span>'
    : '<span class="badge badge-primary" style="font-size:var(--text-sm);padding:6px 14px;">✍️ Kişisel</span>';
  document.getElementById("post-category-badge").innerHTML = cat;

  // Başlık
  document.getElementById("post-title").textContent = post.title;

  // Meta
  document.getElementById("post-meta").innerHTML = `
    <span>📅 ${formatDate(post.createdAt)}</span>
    ${post.updatedAt ? `<span>🔄 Güncellendi: ${formatDate(post.updatedAt)}</span>` : ""}
    <span>✍️ Oğuzhan Çetin</span>`;

  // İçerik (HTML güvenli render — sadece admin yazdığı için XSS riski yok)
  document.getElementById("post-body").innerHTML = post.content || "";

  // Etiketler
  if (post.tags?.length) {
    document.getElementById("post-tags-wrap").innerHTML =
      `<div style="display:flex;flex-wrap:wrap;gap:var(--space-2);">
        ${post.tags.map(t => `<span class="badge badge-muted">#${t}</span>`).join("")}
      </div>`;
  }

  // Paylaş butonları
  const url   = encodeURIComponent(window.location.href);
  const title = encodeURIComponent(post.title);

  document.getElementById("shareLinkedIn")?.addEventListener("click", () => {
    window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${url}`, "_blank");
  });
  document.getElementById("shareTwitter")?.addEventListener("click", () => {
    window.open(`https://twitter.com/intent/tweet?text=${title}&url=${url}`, "_blank");
  });
  document.getElementById("copyLink")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(window.location.href);
    showToast("Link kopyalandı!", "success");
  });

  // Admin düzenleme butonu
  document.getElementById("editPostBtn")?.addEventListener("click", () => {
    fillEditModal(post);
    document.getElementById("editModal").style.display = "flex";
  });
}

// ─── Sidebar: Son Yazılar ───
async function loadSidebarPosts(currentId, category) {
  const container = document.getElementById("sidebar-recent");
  if (!container) return;
  try {
    const q = query(
      collection(db, "posts"),
      where("published", "==", true),
      orderBy("createdAt", "desc"),
      limit(5)
    );
    const snap = await getDocs(q);
    const others = snap.docs.filter(d => d.id !== currentId).slice(0, 4);

    if (others.length === 0) {
      container.innerHTML = `<p style="font-size:var(--text-xs);color:var(--text-muted);text-align:center;padding:var(--space-4);">Başka yazı yok.</p>`;
      return;
    }

    container.innerHTML = others.map(d => {
      const p = d.data();
      return `
        <a href="blog-post.html?id=${d.id}"
          style="display:block;padding:var(--space-3);border-radius:var(--border-radius);text-decoration:none;transition:background var(--transition-fast);"
          onmouseover="this.style.background='var(--bg-surface-3)'"
          onmouseout="this.style.background=''">
          <div style="font-size:var(--text-sm);font-weight:var(--font-semibold);color:var(--text-primary);margin-bottom:4px;line-height:1.3;">
            ${p.title}
          </div>
          <div style="font-size:var(--text-xs);color:var(--text-muted);">${formatDate(p.createdAt)}</div>
        </a>`;
    }).join("");
  } catch {
    container.innerHTML = "";
  }
}

// ─── Admin Düzenleme Modal ───
function fillEditModal(post) {
  document.getElementById("editPostId").value  = post.id;
  document.getElementById("editTitle").value   = post.title || "";
  document.getElementById("editCategory").value = post.category || "personal";
  document.getElementById("editPublished").value = post.published !== false ? "true" : "false";
  document.getElementById("editCover").value   = post.coverImage || "";
  document.getElementById("editExcerpt").value = post.excerpt || "";
  document.getElementById("editContent").value = post.content || "";
  document.getElementById("editTags").value    = post.tags?.join(", ") || "";
}

function setupEditModal() {
  document.getElementById("closeEditModal")?.addEventListener("click", () => {
    document.getElementById("editModal").style.display = "none";
  });
  document.getElementById("cancelEditModal")?.addEventListener("click", () => {
    document.getElementById("editModal").style.display = "none";
  });
  document.getElementById("saveEditBtn")?.addEventListener("click", saveEdit);
}

async function saveEdit() {
  const id      = document.getElementById("editPostId").value;
  const title   = document.getElementById("editTitle").value.trim();
  const content = document.getElementById("editContent").value.trim();
  if (!title || !content) { showToast("Başlık ve içerik zorunludur.", "warning"); return; }

  const btn = document.getElementById("saveEditBtn");
  btn.classList.add("btn-loading"); btn.disabled = true;

  const tags = document.getElementById("editTags").value
    .split(",").map(t => t.trim()).filter(Boolean);

  try {
    await updateDoc(doc(db, "posts", id), {
      title,
      content,
      excerpt:    document.getElementById("editExcerpt").value.trim(),
      category:   document.getElementById("editCategory").value,
      published:  document.getElementById("editPublished").value === "true",
      coverImage: document.getElementById("editCover").value.trim() || null,
      tags,
      updatedAt:  serverTimestamp()
    });
    showToast("Yazı güncellendi.", "success");
    document.getElementById("editModal").style.display = "none";
    // Sayfayı yenile
    setTimeout(() => location.reload(), 800);
  } catch (err) {
    showToast("Güncelleme başarısız: " + err.message, "error");
  } finally {
    btn.classList.remove("btn-loading"); btn.disabled = false;
  }
}
