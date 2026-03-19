/**
 * rpa.js — RPA Snippet kütüphanesi + Admin CRUD
 */

import { auth, db, showToast, formatDate } from "./app.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, query, orderBy, getDocs,
  addDoc, updateDoc, deleteDoc,
  doc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let allSnippets   = [];
let currentTool   = "all";
let searchTerm    = "";
let isAdmin       = false;
let editingId     = null;

const TOOL_LABELS = {
  uipath:        { label: "UiPath",          color: "badge-primary", icon: "🤖" },
  power_automate:{ label: "Power Automate",  color: "badge-info",    icon: "⚡" },
  python:        { label: "Python",          color: "badge-success", icon: "🐍" },
  other:         { label: "Diğer",           color: "badge-muted",   icon: "💻" },
};

// ─── Auth ───
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists() && snap.data().role === "admin") {
      isAdmin = true;
      document.getElementById("admin-add-snippet-btn")?.classList.remove("hidden");
    }
  } catch {}
});

// ─── Sayfa yükle ───
document.addEventListener("DOMContentLoaded", () => {
  loadSnippets();
  setupEventListeners();
});

async function loadSnippets() {
  try {
    const q = query(collection(db, "rpa_snippets"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);

    document.querySelectorAll(".skeleton-card").forEach(el => el.remove());

    allSnippets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSnippets();
  } catch (err) {
    document.querySelectorAll(".skeleton-card").forEach(el => el.remove());
    console.error("Snippetler yüklenemedi:", err);
  }
}

// ─── Render ───
function renderSnippets() {
  const list  = document.getElementById("snippets-list");
  const empty = document.getElementById("snippets-empty");
  list.innerHTML = "";

  let filtered = allSnippets.filter(s => {
    const toolMatch = currentTool === "all" || s.tool === currentTool;
    const termMatch = !searchTerm ||
      s.title?.toLowerCase().includes(searchTerm) ||
      s.description?.toLowerCase().includes(searchTerm) ||
      s.tags?.some(t => t.toLowerCase().includes(searchTerm));
    return toolMatch && termMatch;
  });

  if (filtered.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  filtered.forEach(s => list.appendChild(createSnippetCard(s)));
}

function createSnippetCard(snippet) {
  const div = document.createElement("div");
  div.className = "card";
  div.style.marginBottom = "var(--space-4)";
  div.dataset.snippetId = snippet.id;

  const tool  = TOOL_LABELS[snippet.tool] || TOOL_LABELS.other;
  const escaped = escapeHtml(snippet.code || "");

  div.innerHTML = `
    <div class="card-header">
      <div style="display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap;flex:1;">
        <span style="font-size:1.4rem;">${tool.icon}</span>
        <h3 style="font-size:var(--text-lg);font-weight:var(--font-bold);">${snippet.title}</h3>
        <span class="badge ${tool.color}">${tool.label}</span>
        ${snippet.category ? `<span class="badge badge-muted">${snippet.category}</span>` : ""}
      </div>
      ${isAdmin ? `
        <button class="btn btn-ghost btn-sm edit-snippet-btn" data-id="${snippet.id}" style="flex-shrink:0;">
          ✏️ Düzenle
        </button>` : ""}
    </div>
    <div class="card-body">
      ${snippet.description
        ? `<p style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--space-4);">${snippet.description}</p>`
        : ""}

      <div class="code-block">
        <div class="code-header">
          <span class="code-lang">${snippet.tool || "code"}</span>
          <button class="code-copy-btn" data-code="${encodeURIComponent(snippet.code || "")}">📋 Kopyala</button>
        </div>
        <pre><code>${escaped}</code></pre>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:var(--space-4);flex-wrap:wrap;gap:var(--space-3);">
        <div style="display:flex;flex-wrap:wrap;gap:var(--space-2);">
          ${snippet.tags?.map(t => `<span class="badge badge-muted">#${t}</span>`).join("") || ""}
        </div>
        <span style="font-size:var(--text-xs);color:var(--text-muted);">
          ${formatDate(snippet.createdAt)}
        </span>
      </div>
    </div>`;

  // Kopyala butonu
  div.querySelector(".code-copy-btn")?.addEventListener("click", async (e) => {
    const code = decodeURIComponent(e.target.dataset.code);
    await navigator.clipboard.writeText(code).catch(() => {});
    e.target.textContent = "✅ Kopyalandı!";
    e.target.classList.add("copied");
    setTimeout(() => {
      e.target.textContent = "📋 Kopyala";
      e.target.classList.remove("copied");
    }, 2000);
    showToast("Kod kopyalandı!", "success");
  });

  // Admin düzenleme
  div.querySelector(".edit-snippet-btn")?.addEventListener("click", () => openSnippetModal(snippet));

  return div;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Event Listeners ───
function setupEventListeners() {
  // Tool tabs
  document.getElementById("toolTabs")?.addEventListener("click", e => {
    const btn = e.target.closest(".cat-tab");
    if (!btn) return;
    document.querySelectorAll(".cat-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentTool = btn.dataset.tool;
    renderSnippets();
  });

  // Arama
  let timer;
  document.getElementById("snippetSearch")?.addEventListener("input", e => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      searchTerm = e.target.value.trim().toLowerCase();
      renderSnippets();
    }, 300);
  });

  // Modal
  document.getElementById("openSnippetModal")?.addEventListener("click", () => openSnippetModal());
  document.getElementById("closeSnippetModal")?.addEventListener("click", closeSnippetModal);
  document.getElementById("cancelSnippetModal")?.addEventListener("click", closeSnippetModal);
  document.getElementById("snippetModal")?.addEventListener("click", e => { if (e.target === e.currentTarget) closeSnippetModal(); });
  document.getElementById("saveSnippetBtn")?.addEventListener("click", saveSnippet);
  document.getElementById("deleteSnippetBtn")?.addEventListener("click", deleteSnippet);
}

// ─── Modal ───
function openSnippetModal(snippet = null) {
  editingId = snippet?.id || null;
  document.getElementById("snippetModalTitle").textContent = snippet ? "Snippet Düzenle" : "Snippet Ekle";
  document.getElementById("editSnippetId").value   = snippet?.id || "";
  document.getElementById("snippetTitle").value    = snippet?.title || "";
  document.getElementById("snippetTool").value     = snippet?.tool || "uipath";
  document.getElementById("snippetCategory").value = snippet?.category || "";
  document.getElementById("snippetDesc").value     = snippet?.description || "";
  document.getElementById("snippetCode").value     = snippet?.code || "";
  document.getElementById("snippetTags").value     = snippet?.tags?.join(", ") || "";
  document.getElementById("snippetFormError")?.classList.add("hidden");
  document.getElementById("deleteSnippetBtn")?.classList.toggle("hidden", !snippet);
  document.getElementById("snippetModal").style.display = "flex";
}

function closeSnippetModal() {
  document.getElementById("snippetModal").style.display = "none";
  editingId = null;
}

// ─── Kaydet ───
async function saveSnippet() {
  const title = document.getElementById("snippetTitle").value.trim();
  const code  = document.getElementById("snippetCode").value.trim();

  if (!title || !code) {
    document.getElementById("snippetFormErrorText").textContent = "Başlık ve kod zorunludur.";
    document.getElementById("snippetFormError").classList.remove("hidden");
    return;
  }

  const btn = document.getElementById("saveSnippetBtn");
  btn.classList.add("btn-loading"); btn.disabled = true;
  document.getElementById("snippetFormError").classList.add("hidden");

  const tags = document.getElementById("snippetTags").value
    .split(",").map(t => t.trim()).filter(Boolean);

  const data = {
    title,
    code,
    tool:        document.getElementById("snippetTool").value,
    category:    document.getElementById("snippetCategory").value.trim() || null,
    description: document.getElementById("snippetDesc").value.trim() || null,
    tags,
    updatedAt:   serverTimestamp()
  };

  try {
    if (editingId) {
      await updateDoc(doc(db, "rpa_snippets", editingId), data);
      const idx = allSnippets.findIndex(s => s.id === editingId);
      if (idx > -1) allSnippets[idx] = { ...allSnippets[idx], ...data, updatedAt: new Date() };
      showToast("Snippet güncellendi.", "success");
    } else {
      data.authorId  = auth.currentUser.uid;
      data.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, "rpa_snippets"), data);
      allSnippets.unshift({ id: ref.id, ...data, createdAt: new Date() });
      showToast("Snippet eklendi! 🤖", "success");
    }
    renderSnippets();
    closeSnippetModal();
  } catch (err) {
    document.getElementById("snippetFormErrorText").textContent = "Kayıt başarısız: " + err.message;
    document.getElementById("snippetFormError").classList.remove("hidden");
  } finally {
    btn.classList.remove("btn-loading"); btn.disabled = false;
  }
}

// ─── Sil ───
async function deleteSnippet() {
  if (!editingId) return;
  if (!confirm("Bu snippet'i silmek istediğinize emin misiniz?")) return;
  try {
    await deleteDoc(doc(db, "rpa_snippets", editingId));
    allSnippets = allSnippets.filter(s => s.id !== editingId);
    renderSnippets();
    showToast("Snippet silindi.", "success");
    closeSnippetModal();
  } catch (err) {
    showToast("Silinemedi: " + err.message, "error");
  }
}
