/**
 * kutuphane.js — Kitap kütüphanesi + Admin CRUD
 */

import { auth, db, showToast } from "./app.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, query, orderBy, getDocs,
  addDoc, updateDoc, deleteDoc,
  doc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let allBooks      = [];
let currentGenre  = "all";
let currentSort   = "createdAt";
let searchText    = "";
let isAdmin       = false;
let selectedRating = 0;
let editingBookId  = null;

// ─── Auth ───
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists() && snap.data().role === "admin") {
      isAdmin = true;
      document.getElementById("admin-add-book-btn")?.classList.remove("hidden");
    }
  } catch {}
});

// ─── Sayfa yükle ───
document.addEventListener("DOMContentLoaded", () => {
  loadBooks();
  setupEventListeners();
});

async function loadBooks() {
  try {
    const q = query(collection(db, "books"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);

    document.querySelectorAll(".skeleton-card").forEach(el => el.remove());

    allBooks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderBooks();
    renderStats();
  } catch (err) {
    document.querySelectorAll(".skeleton-card").forEach(el => el.remove());
    console.error("Kitaplar yüklenemedi:", err);
  }
}

// ─── Render ───
function renderBooks() {
  const grid  = document.getElementById("books-grid");
  const empty = document.getElementById("books-empty");
  grid.innerHTML = "";

  let filtered = allBooks.filter(b => {
    const genreMatch = currentGenre === "all" || b.genre === currentGenre;
    const term = searchText.toLowerCase();
    const textMatch = !term ||
      b.title?.toLowerCase().includes(term) ||
      b.author?.toLowerCase().includes(term) ||
      b.review?.toLowerCase().includes(term);
    return genreMatch && textMatch;
  });

  // Sıralama
  if (currentSort === "rating") {
    filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  } else if (currentSort === "title") {
    filtered.sort((a, b) => (a.title || "").localeCompare(b.title || "", "tr"));
  }
  // createdAt zaten Firestore'dan desc geliyor

  if (filtered.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  filtered.forEach(b => grid.appendChild(createBookCard(b)));
}

function createBookCard(book) {
  const div = document.createElement("div");
  div.className = "card book-card";
  div.style.cssText = "padding:var(--space-6);display:flex;flex-direction:column;align-items:center;text-align:center;";

  const stars = Array.from({ length: 5 }, (_, i) =>
    `<span class="star ${i < (book.rating || 0) ? "filled" : ""}">★</span>`
  ).join("");

  div.innerHTML = `
    ${book.coverImage
      ? `<img src="${book.coverImage}" alt="${book.title}"
           style="width:120px;height:180px;object-fit:cover;border-radius:6px;box-shadow:var(--shadow-md);margin-bottom:var(--space-4);"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`
      : ""}
    <div style="width:120px;height:180px;background:linear-gradient(135deg,var(--navy-700),var(--navy-500));border-radius:6px;display:${book.coverImage ? "none" : "flex"};align-items:center;justify-content:center;font-size:2.5rem;margin-bottom:var(--space-4);box-shadow:var(--shadow-md);">📖</div>

    <div style="font-weight:var(--font-bold);font-size:var(--text-base);margin-bottom:var(--space-1);line-height:1.3;">${book.title}</div>
    <div style="font-size:var(--text-sm);color:var(--text-muted);margin-bottom:var(--space-3);">${book.author}</div>

    <div class="star-rating" style="margin-bottom:var(--space-3);">${stars}</div>

    ${book.genre ? `<span class="badge badge-muted" style="margin-bottom:var(--space-3);">${genreLabel(book.genre)}</span>` : ""}
    ${book.readYear ? `<div style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-3);">📅 ${book.readYear}</div>` : ""}

    ${book.review
      ? `<p style="font-size:var(--text-xs);color:var(--text-secondary);line-height:var(--leading-relaxed);cursor:pointer;"
           onclick="toggleReview(this)"
           data-full="${encodeURIComponent(book.review)}"
           data-short="${encodeURIComponent(book.review.slice(0,80))}${book.review.length > 80 ? '…' : ''}">
           ${book.review.slice(0, 80)}${book.review.length > 80 ? "…" : ""}
         </p>`
      : ""}

    ${isAdmin ? `
      <button class="btn btn-ghost btn-sm edit-book-btn" data-id="${book.id}"
        style="margin-top:var(--space-4);font-size:var(--text-xs);width:100%;">
        ✏️ Düzenle
      </button>` : ""}
  `;

  div.querySelector(".edit-book-btn")?.addEventListener("click", () => openBookModal(book));
  return div;
}

function genreLabel(g) {
  const map = { teknoloji:"Teknoloji", isg:"İSG", "kisisel-gelisim":"Kişisel Gelişim", roman:"Roman", bilim:"Bilim", diger:"Diğer" };
  return map[g] || g;
}

// İstatistikler
function renderStats() {
  if (!allBooks.length) return;
  document.getElementById("booksStats").style.display = "flex";
  document.getElementById("totalBooks").textContent = allBooks.length;
  const avg = allBooks.reduce((s, b) => s + (b.rating || 0), 0) / allBooks.length;
  document.getElementById("avgRating").textContent = avg.toFixed(1);
  document.getElementById("fiveStarCount").textContent = allBooks.filter(b => b.rating === 5).length;
}

// ─── Event Listeners ───
function setupEventListeners() {
  // Genre tabs
  document.getElementById("genreTabs")?.addEventListener("click", e => {
    const btn = e.target.closest(".cat-tab");
    if (!btn) return;
    document.querySelectorAll(".cat-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentGenre = btn.dataset.genre;
    renderBooks();
  });

  // Sıralama
  document.getElementById("sortSelect")?.addEventListener("change", e => {
    currentSort = e.target.value;
    renderBooks();
  });

  // Modal butonları
  document.getElementById("openBookModal")?.addEventListener("click", () => openBookModal());
  document.getElementById("closeBookModal")?.addEventListener("click", closeBookModal);
  document.getElementById("cancelBookModal")?.addEventListener("click", closeBookModal);
  document.getElementById("bookModal")?.addEventListener("click", e => { if (e.target === e.currentTarget) closeBookModal(); });
  document.getElementById("saveBookBtn")?.addEventListener("click", saveBook);
  document.getElementById("deleteBookBtn")?.addEventListener("click", deleteBook);

  // Yıldız input
  document.getElementById("starInput")?.addEventListener("click", e => {
    const btn = e.target.closest(".star-btn");
    if (!btn) return;
    selectedRating = parseInt(btn.dataset.val);
    document.getElementById("bookRating").value = selectedRating;
    document.querySelectorAll(".star-btn").forEach((b, i) => {
      b.classList.toggle("active", i < selectedRating);
    });
  });

  // Yorum karakter sayacı
  document.getElementById("bookReview")?.addEventListener("input", e => {
    document.getElementById("reviewCharCount").textContent = e.target.value.length;
  });

  // Metin araması
  let searchTimer;
  document.getElementById("bookSearch")?.addEventListener("input", e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchText = e.target.value.trim();
      renderBooks();
    }, 300);
  });
}

// ─── Modal ───
function openBookModal(book = null) {
  editingBookId = book?.id || null;

  document.getElementById("bookModalTitle").textContent = book ? "Kitabı Düzenle" : "Kitap Ekle";
  document.getElementById("editBookId").value   = book?.id || "";
  document.getElementById("bookTitle").value    = book?.title || "";
  document.getElementById("bookAuthor").value   = book?.author || "";
  document.getElementById("bookYear").value     = book?.readYear || "";
  document.getElementById("bookGenre").value    = book?.genre || "teknoloji";
  document.getElementById("bookCover").value    = book?.coverImage || "";
  document.getElementById("bookReview").value   = book?.review || "";
  document.getElementById("reviewCharCount").textContent = (book?.review || "").length;
  document.getElementById("bookFormError")?.classList.add("hidden");
  document.getElementById("deleteBookBtn")?.classList.toggle("hidden", !book);

  // Yıldızlar
  selectedRating = book?.rating || 0;
  document.getElementById("bookRating").value = selectedRating;
  document.querySelectorAll(".star-btn").forEach((b, i) => {
    b.classList.toggle("active", i < selectedRating);
  });

  document.getElementById("bookModal").style.display = "flex";
}

function closeBookModal() {
  document.getElementById("bookModal").style.display = "none";
  editingBookId = null;
}

// ─── Kaydet ───
async function saveBook() {
  const title  = document.getElementById("bookTitle").value.trim();
  const author = document.getElementById("bookAuthor").value.trim();

  if (!title || !author) {
    document.getElementById("bookFormErrorText").textContent = "Kitap adı ve yazar zorunludur.";
    document.getElementById("bookFormError").classList.remove("hidden");
    return;
  }

  const btn = document.getElementById("saveBookBtn");
  btn.classList.add("btn-loading"); btn.disabled = true;
  document.getElementById("bookFormError").classList.add("hidden");

  const data = {
    title,
    author,
    readYear:   parseInt(document.getElementById("bookYear").value) || null,
    genre:      document.getElementById("bookGenre").value,
    coverImage: document.getElementById("bookCover").value.trim() || null,
    review:     document.getElementById("bookReview").value.trim() || null,
    rating:     parseInt(document.getElementById("bookRating").value) || 0,
    updatedAt:  serverTimestamp()
  };

  try {
    if (editingBookId) {
      await updateDoc(doc(db, "books", editingBookId), data);
      const idx = allBooks.findIndex(b => b.id === editingBookId);
      if (idx > -1) allBooks[idx] = { ...allBooks[idx], ...data, updatedAt: new Date() };
      showToast("Kitap güncellendi.", "success");
    } else {
      data.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, "books"), data);
      allBooks.unshift({ id: ref.id, ...data, createdAt: new Date() });
      showToast("Kitap eklendi! 📚", "success");
    }
    renderBooks();
    renderStats();
    closeBookModal();
  } catch (err) {
    document.getElementById("bookFormErrorText").textContent = "Kayıt başarısız: " + err.message;
    document.getElementById("bookFormError").classList.remove("hidden");
  } finally {
    btn.classList.remove("btn-loading"); btn.disabled = false;
  }
}

// ─── Sil ───
async function deleteBook() {
  if (!editingBookId) return;
  if (!confirm("Bu kitabı silmek istediğinize emin misiniz?")) return;

  try {
    await deleteDoc(doc(db, "books", editingBookId));
    allBooks = allBooks.filter(b => b.id !== editingBookId);
    renderBooks();
    renderStats();
    showToast("Kitap silindi.", "success");
    closeBookModal();
  } catch (err) {
    showToast("Silinemedi: " + err.message, "error");
  }
}

// ─── Yorum aç/kapat ───
window.toggleReview = function(el) {
  const full  = decodeURIComponent(el.dataset.full);
  const short = decodeURIComponent(el.dataset.short);
  el.textContent = el.textContent.includes("…") ? full : short;
};
