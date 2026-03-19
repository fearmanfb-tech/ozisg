/**
 * blog.js — Blog listesi + Admin CRUD
 */

import { auth, db, showToast, formatDate } from "./app.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, query, where, orderBy, limit,
  startAfter, getDocs, addDoc, updateDoc, deleteDoc,
  doc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── State ───
let currentCategory = "all";
let searchTerm      = "";
let lastVisible     = null;
let isLoading       = false;
let isAdmin         = false;
let allPosts        = [];   // filtreleme için hafızada tutulur
const PAGE_SIZE     = 9;

// ─── DOM ───
const postsGrid       = document.getElementById("posts-grid");
const postsEmpty      = document.getElementById("posts-empty");
const loadMoreBtn     = document.getElementById("loadMoreBtn");
const loadMoreContainer = document.getElementById("load-more-container");
const searchInput     = document.getElementById("searchInput");

// ─── Auth kontrolü (admin mi?) ───
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const role = snap.data().role;
    if (snap.exists() && (role === "admin" || role === "superadmin")) {
      isAdmin = true;
      document.getElementById("admin-new-post-btn")?.classList.remove("hidden");
    }
  } catch {}
});

// ─── Sayfa yüklenince yazıları getir ───
document.addEventListener("DOMContentLoaded", () => {
  loadPosts(true);
  setupEventListeners();
});

// ─── Yazıları Firestore'dan çek ───
async function loadPosts(reset = false) {
  if (isLoading) return;
  isLoading = true;

  if (reset) {
    lastVisible = null;
    allPosts    = [];
    postsGrid.innerHTML = "";
  }

  try {
    const constraints = [
      collection(db, "posts"),
      where("published", "==", true),
      orderBy("createdAt", "desc"),
      limit(PAGE_SIZE)
    ];

    if (currentCategory !== "all") {
      constraints.splice(2, 0, where("category", "==", currentCategory));
    }

    if (lastVisible) constraints.push(startAfter(lastVisible));

    const q = query(...constraints);
    const snap = await getDocs(q);

    // Skeleton'ları temizle
    postsGrid.querySelectorAll(".skeleton-card").forEach(el => el.remove());

    if (snap.empty && allPosts.length === 0) {
      postsEmpty.classList.remove("hidden");
      loadMoreContainer.classList.add("hidden");
      isLoading = false;
      return;
    }

    postsEmpty.classList.add("hidden");
    lastVisible = snap.docs[snap.docs.length - 1];

    snap.docs.forEach(d => {
      const post = { id: d.id, ...d.data() };
      allPosts.push(post);
      postsGrid.appendChild(createPostCard(post));
    });

    // Daha fazla yükle butonu
    if (snap.docs.length === PAGE_SIZE) {
      loadMoreContainer.classList.remove("hidden");
    } else {
      loadMoreContainer.classList.add("hidden");
    }

    // Aktif arama varsa filtrele
    if (searchTerm) filterBySearch();

  } catch (err) {
    console.error("Yazılar yüklenemedi:", err);
    postsGrid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:var(--space-12);">
        Yazılar yüklenirken hata oluştu. Sayfayı yenileyin.
      </div>`;
  } finally {
    isLoading = false;
  }
}

// ─── Kart oluştur ───
function createPostCard(post) {
  const div = document.createElement("div");
  div.className = "card post-card";
  div.dataset.postId = post.id;

  const categoryBadge = post.category === "scientific"
    ? '<span class="badge badge-info">Bilimsel Makale</span>'
    : '<span class="badge badge-primary">Kişisel</span>';

  div.innerHTML = `
    ${post.coverImage
      ? `<img class="card-img" src="${post.coverImage}" alt="${post.title}" loading="lazy" onerror="this.style.display='none'" />`
      : `<div class="card-img" style="background:linear-gradient(135deg,var(--navy-700),var(--navy-500));display:flex;align-items:center;justify-content:center;font-size:3rem;">✍️</div>`
    }
    <div class="card-body" style="flex:1;display:flex;flex-direction:column;">
      <div class="post-meta">
        ${categoryBadge}
        <span>${formatDate(post.createdAt)}</span>
      </div>
      <h3 class="post-title">${post.title}</h3>
      <p class="post-excerpt">${post.excerpt || ""}</p>
      ${post.tags?.length ? `<div class="post-tags">${post.tags.slice(0,3).map(t=>`<span class="badge badge-muted">#${t}</span>`).join("")}</div>` : ""}
    </div>
    <div class="card-footer" style="display:flex;justify-content:space-between;align-items:center;">
      <a href="blog-post.html?id=${post.id}" style="font-size:var(--text-sm);color:var(--accent-primary);font-weight:var(--font-semibold);">
        Devamını Oku →
      </a>
      ${isAdmin ? `
        <button class="btn btn-ghost btn-sm edit-post-btn" data-id="${post.id}" style="font-size:var(--text-xs);">
          ✏️ Düzenle
        </button>` : ""}
    </div>`;

  // Admin düzenleme
  div.querySelector(".edit-post-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    openEditModal(post);
  });

  return div;
}

// ─── Arama Filtresi ───
function filterBySearch() {
  const term = searchTerm.toLowerCase();
  const cards = postsGrid.querySelectorAll(".card.post-card");
  let visibleCount = 0;

  cards.forEach(card => {
    const id    = card.dataset.postId;
    const post  = allPosts.find(p => p.id === id);
    if (!post) return;

    const match = !term ||
      post.title?.toLowerCase().includes(term) ||
      post.excerpt?.toLowerCase().includes(term) ||
      post.tags?.some(t => t.toLowerCase().includes(term));

    card.style.display = match ? "" : "none";
    if (match) visibleCount++;
  });

  postsEmpty.classList.toggle("hidden", visibleCount > 0);
}

// ─── Event Listeners ───
function setupEventListeners() {
  // Kategori tabları
  document.getElementById("categoryTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".cat-tab");
    if (!btn) return;
    document.querySelectorAll(".cat-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentCategory = btn.dataset.cat;
    loadPosts(true);
  });

  // Arama
  let searchTimer;
  searchInput?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTerm = searchInput.value.trim();
      filterBySearch();
    }, 300);
  });

  // Daha fazla yükle
  loadMoreBtn?.addEventListener("click", () => loadPosts(false));

  // Modal aç (yeni yazı)
  document.getElementById("openPostModal")?.addEventListener("click", () => openPostModal());

  // Modal kapat
  document.getElementById("closePostModal")?.addEventListener("click", closePostModal);
  document.getElementById("cancelPostModal")?.addEventListener("click", closePostModal);

  // Overlay tıklama ile kapat
  document.getElementById("postModal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closePostModal();
  });

  // Kaydet
  document.getElementById("savePostBtn")?.addEventListener("click", savePost);

  // Sil
  document.getElementById("deletePostBtn")?.addEventListener("click", () => {
    const id = document.getElementById("editPostId").value;
    if (!id) return;
    closePostModal();
    openDeleteConfirm(id);
  });

  // Silme onay modal
  document.getElementById("closeDeleteModal")?.addEventListener("click", closeDeleteConfirm);
  document.getElementById("cancelDeleteBtn")?.addEventListener("click", closeDeleteConfirm);
  document.getElementById("confirmDeleteBtn")?.addEventListener("click", confirmDelete);
}

// ─── MODAL: Yeni Yazı ───
function openPostModal(post = null) {
  const modal    = document.getElementById("postModal");
  const title    = document.getElementById("postModalTitle");
  const deleteBtn = document.getElementById("deletePostBtn");

  // Formu temizle / doldur
  document.getElementById("editPostId").value        = post?.id || "";
  document.getElementById("postTitle").value         = post?.title || "";
  document.getElementById("postCategory").value      = post?.category || "personal";
  document.getElementById("postPublished").value     = post?.published !== false ? "true" : "false";
  document.getElementById("postCover").value         = post?.coverImage || "";
  document.getElementById("postExcerpt").value       = post?.excerpt || "";
  document.getElementById("postContent").value       = post?.content || "";
  document.getElementById("postTags").value          = post?.tags?.join(", ") || "";
  document.getElementById("postFormError")?.classList.add("hidden");

  title.textContent = post ? "Yazıyı Düzenle" : "Yeni Yazı Ekle";
  deleteBtn?.classList.toggle("hidden", !post);

  modal.style.display = "flex";
}

function closePostModal() {
  document.getElementById("postModal").style.display = "none";
}

function openEditModal(post) {
  openPostModal(post);
}

// ─── Yazı Kaydet (Ekle / Güncelle) ───
async function savePost() {
  const id      = document.getElementById("editPostId").value;
  const title   = document.getElementById("postTitle").value.trim();
  const content = document.getElementById("postContent").value.trim();
  const errorEl = document.getElementById("postFormError");
  const errText = document.getElementById("postFormErrorText");

  if (!title || !content) {
    errText.textContent = "Başlık ve içerik zorunludur.";
    errorEl.classList.remove("hidden");
    return;
  }

  errorEl.classList.add("hidden");
  const saveBtn = document.getElementById("savePostBtn");
  saveBtn.classList.add("btn-loading");
  saveBtn.disabled = true;

  const tags = document.getElementById("postTags").value
    .split(",").map(t => t.trim()).filter(Boolean);

  const data = {
    title,
    content,
    excerpt:    document.getElementById("postExcerpt").value.trim(),
    category:   document.getElementById("postCategory").value,
    published:  document.getElementById("postPublished").value === "true",
    coverImage: document.getElementById("postCover").value.trim() || null,
    tags,
    updatedAt:  serverTimestamp()
  };

  try {
    if (id) {
      // Güncelle
      await updateDoc(doc(db, "posts", id), data);
      showToast("Yazı güncellendi.", "success");
      // Kartta güncelle
      const card = postsGrid.querySelector(`[data-post-id="${id}"]`);
      if (card) {
        const idx = allPosts.findIndex(p => p.id === id);
        const safeData = { ...data, updatedAt: { toDate: () => new Date() } };
        if (idx > -1) allPosts[idx] = { ...allPosts[idx], ...safeData };
        const newCard = createPostCard({ id, ...allPosts.find(p => p.id === id) });
        card.replaceWith(newCard);
      }
    } else {
      // Yeni ekle
      data.authorId  = auth.currentUser.uid;
      data.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, "posts"), data);
      // serverTimestamp() henüz resolve olmadığı için kartda yerel tarihi kullan
      const newPost = { id: ref.id, ...data, createdAt: { toDate: () => new Date() } };
      allPosts.unshift(newPost);
      postsGrid.insertBefore(createPostCard(newPost), postsGrid.firstChild);
      postsEmpty.classList.add("hidden");
      showToast("Yazı yayınlandı! 🎉", "success");
    }
    closePostModal();
  } catch (err) {
    errText.textContent = "Kayıt başarısız: " + err.message;
    errorEl.classList.remove("hidden");
  } finally {
    saveBtn.classList.remove("btn-loading");
    saveBtn.disabled = false;
  }
}

// ─── Yazı Silme ───
let pendingDeleteId = null;

function openDeleteConfirm(id) {
  pendingDeleteId = id;
  document.getElementById("deleteConfirmModal").style.display = "flex";
}

function closeDeleteConfirm() {
  pendingDeleteId = null;
  document.getElementById("deleteConfirmModal").style.display = "none";
}

async function confirmDelete() {
  if (!pendingDeleteId) return;
  const btn = document.getElementById("confirmDeleteBtn");
  btn.classList.add("btn-loading");
  btn.disabled = true;

  try {
    await deleteDoc(doc(db, "posts", pendingDeleteId));
    const card = postsGrid.querySelector(`[data-post-id="${pendingDeleteId}"]`);
    card?.remove();
    allPosts = allPosts.filter(p => p.id !== pendingDeleteId);
    if (allPosts.length === 0) postsEmpty.classList.remove("hidden");
    showToast("Yazı silindi.", "success");
    closeDeleteConfirm();
  } catch (err) {
    showToast("Silme başarısız: " + err.message, "error");
  } finally {
    btn.classList.remove("btn-loading");
    btn.disabled = false;
  }
}
