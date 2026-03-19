/**
 * index.js — Ana Sayfa Veri Yükleme
 */

import { db, formatDate } from "./app.js";
import {
  collection, query, where, orderBy, limit, getDocs, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

document.addEventListener("DOMContentLoaded", async () => {
  await Promise.all([
    loadRecentPosts(),
    loadRecentBooks(),
    loadStats()
  ]);
});

// ─── İstatistikler ───
async function loadStats() {
  try {
    const [postsSnap, booksSnap, snippetsSnap] = await Promise.all([
      getCountFromServer(query(collection(db, "posts"), where("published", "==", true))),
      getCountFromServer(collection(db, "books")),
      getCountFromServer(collection(db, "rpa_snippets"))
    ]);
    const statPosts    = document.getElementById("stat-posts");
    const statBooks    = document.getElementById("stat-books");
    const statSnippets = document.getElementById("stat-snippets");

    if (statPosts)    statPosts.textContent    = postsSnap.data().count;
    if (statBooks)    statBooks.textContent    = booksSnap.data().count;
    if (statSnippets) statSnippets.textContent = snippetsSnap.data().count;
  } catch (err) {
    console.warn("İstatistikler yüklenemedi:", err.message);
  }
}

// ─── Son Blog Yazıları ───
async function loadRecentPosts() {
  const container = document.getElementById("posts-container");
  const skeletons = ["post-skeleton-1", "post-skeleton-2", "post-skeleton-3"];

  if (!container) return;

  try {
    const q = query(
      collection(db, "posts"),
      where("published", "==", true),
      orderBy("createdAt", "desc"),
      limit(3)
    );
    const snap = await getDocs(q);

    // Skeleton'ları kaldır
    skeletons.forEach(id => document.getElementById(id)?.remove());

    if (snap.empty) {
      container.innerHTML = `
        <div style="grid-column:1/-1; text-align:center; padding:var(--space-12); color:var(--text-muted);">
          <div style="font-size:2.5rem; margin-bottom:var(--space-4);">✍️</div>
          <p>Henüz yayınlanmış yazı bulunmuyor.</p>
        </div>`;
      return;
    }

    container.innerHTML = snap.docs.map(d => {
      const p = d.data();
      const categoryBadge = p.category === "scientific"
        ? '<span class="badge badge-info">Bilimsel Makale</span>'
        : '<span class="badge badge-primary">Kişisel</span>';

      return `
        <a href="blog-post.html?id=${d.id}" class="card post-card" style="text-decoration:none; color:inherit;">
          ${p.coverImage
            ? `<img class="card-img" src="${p.coverImage}" alt="${p.title}" loading="lazy" />`
            : `<div class="card-img" style="background:linear-gradient(135deg,var(--navy-700),var(--navy-500)); display:flex; align-items:center; justify-content:center; font-size:3rem;">✍️</div>`
          }
          <div class="card-body">
            <div class="post-meta">
              ${categoryBadge}
              <span>${formatDate(p.createdAt)}</span>
            </div>
            <h3 class="post-title">${p.title}</h3>
            <p class="post-excerpt">${p.excerpt || ""}</p>
            ${p.tags?.length ? `
              <div class="post-tags">
                ${p.tags.slice(0,3).map(t => `<span class="badge badge-muted">#${t}</span>`).join("")}
              </div>` : ""}
          </div>
          <div class="card-footer" style="font-size:var(--text-sm); color:var(--accent-primary);">
            Devamını Oku →
          </div>
        </a>`;
    }).join("");
  } catch (err) {
    skeletons.forEach(id => document.getElementById(id)?.remove());
    console.warn("Yazılar yüklenemedi:", err.message);
    container.innerHTML = `
      <div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:var(--space-8);">
        Yazılar yüklenirken bir hata oluştu.
      </div>`;
  }
}

// ─── Son Kitaplar ───
async function loadRecentBooks() {
  const container = document.getElementById("books-container");
  if (!container) return;

  try {
    const q = query(
      collection(db, "books"),
      orderBy("createdAt", "desc"),
      limit(6)
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      container.innerHTML = `
        <div style="grid-column:1/-1; text-align:center; padding:var(--space-8); color:var(--text-muted);">
          <p>Henüz kitap eklenmemiş.</p>
        </div>`;
      return;
    }

    container.innerHTML = snap.docs.map(d => {
      const b = d.data();
      const stars = Array.from({length:5}, (_, i) =>
        `<span class="star ${i < b.rating ? "filled" : ""}">★</span>`
      ).join("");

      return `
        <div class="card book-card">
          ${b.coverImage
            ? `<img class="book-cover" src="${b.coverImage}" alt="${b.title}" loading="lazy" />`
            : `<div class="book-cover-placeholder">📖</div>`
          }
          <div class="book-title">${b.title}</div>
          <div class="book-author">${b.author}</div>
          <div class="star-rating">${stars}</div>
          ${b.review ? `<p style="font-size:var(--text-xs); color:var(--text-muted); text-align:center;">${b.review.slice(0,80)}${b.review.length > 80 ? "…" : ""}</p>` : ""}
        </div>`;
    }).join("");
  } catch (err) {
    console.warn("Kitaplar yüklenemedi:", err.message);
  }
}
