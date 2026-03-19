/**
 * categories-admin.js — Kategori (Taxonomy) Yönetimi
 * Admin paneli → Kategoriler sekmesi
 * Firestore: categories/{catId}
 */

import { db, showToast } from "./app.js";
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Sabitler ───────────────────────────────────
const CAT_TYPES = [
  { value: "blog",    label: "✍️ Blog Yazıları" },
  { value: "library", label: "📚 Kütüphane" },
  { value: "tool",    label: "🛠️ Araçlar" },
];

const CAT_COLORS = [
  "#2563eb","#7c3aed","#dc2626","#16a34a",
  "#0891b2","#d97706","#db2777","#64748b",
];

// ── Durum ──────────────────────────────────────
let allCategories = [];
let editingCatId  = null;

// ── Yardımcı ──────────────────────────────────
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g,"&amp;")
    .replace(/"/g,"&quot;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;");
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/ğ/g,"g").replace(/ü/g,"u").replace(/ş/g,"s")
    .replace(/ı/g,"i").replace(/ö/g,"o").replace(/ç/g,"c")
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-|-$/g,"");
}

// ══════════════════════════════════════════════
// VERİ YÜKLEME
// ══════════════════════════════════════════════
async function loadCategories() {
  try {
    const snap = await getDocs(query(collection(db, "categories"), orderBy("type"), orderBy("order")));
    allCategories = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    // order index yoksa sıralamasız yükle
    try {
      const snap = await getDocs(collection(db, "categories"));
      allCategories = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.type || "").localeCompare(b.type || "") || (a.order || 0) - (b.order || 0));
    } catch (e) {
      showToast("Kategoriler yüklenemedi: " + e.message, "error");
      allCategories = [];
    }
  }
}

// ══════════════════════════════════════════════
// ANA PANEL RENDER
// ══════════════════════════════════════════════
function renderCategories() {
  const panel = document.getElementById("categories-panel");
  if (!panel) return;

  // Type'a göre grupla
  const grouped = {};
  CAT_TYPES.forEach(t => { grouped[t.value] = []; });
  allCategories.forEach(c => {
    if (grouped[c.type]) grouped[c.type].push(c);
    else { grouped[c.type] = grouped[c.type] || []; grouped[c.type].push(c); }
  });

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-3);margin-bottom:var(--space-6);">
      <div>
        <h3 style="font-weight:var(--font-bold);font-size:var(--text-lg);">🏷️ Kategori Yönetimi</h3>
        <p style="font-size:var(--text-sm);color:var(--text-muted);margin-top:2px;">Blog yazıları, kütüphane dokümanları ve araçlar için kategoriler oluşturun.</p>
      </div>
      <button class="btn btn-primary btn-sm" onclick="openCatModal()">➕ Yeni Kategori</button>
    </div>

    ${CAT_TYPES.map(type => `
      <div class="card" style="padding:var(--space-5);margin-bottom:var(--space-4);">
        <h4 style="font-weight:var(--font-semibold);margin-bottom:var(--space-4);">${type.label}</h4>
        ${(grouped[type.value] || []).length === 0
          ? `<p style="color:var(--text-muted);font-size:var(--text-sm);">Bu türde henüz kategori yok.</p>`
          : `<div style="display:flex;flex-direction:column;gap:var(--space-2);">
              ${(grouped[type.value] || []).map(cat => renderCatRow(cat)).join("")}
            </div>`
        }
      </div>
    `).join("")}

    <!-- Kategori Ekle/Düzenle Modalı -->
    <div id="cat-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9500;align-items:center;justify-content:center;">
      <div style="background:var(--bg-surface,#fff);border-radius:12px;padding:var(--space-6);width:440px;max-width:95vw;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-5);">
          <h3 style="font-weight:700;" id="cat-modal-title">Yeni Kategori</h3>
          <button class="btn btn-ghost btn-sm" onclick="closeCatModal()">✕</button>
        </div>
        <div id="cat-modal-body"></div>
      </div>
    </div>`;
}

function renderCatRow(cat) {
  const parentCat = cat.parentId ? allCategories.find(c => c.id === cat.parentId) : null;
  const childCount = allCategories.filter(c => c.parentId === cat.id).length;
  return `
    <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);border:1px solid var(--border-color);border-radius:var(--border-radius);background:var(--bg-surface);${cat.parentId ? "margin-left:var(--space-6);" : ""}">
      <div style="width:12px;height:12px;border-radius:50%;background:${cat.color||"#6366f1"};flex-shrink:0;"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:var(--font-semibold);font-size:var(--text-sm);">${esc(cat.name)}</div>
        <div style="font-size:var(--text-xs);color:var(--text-muted);">
          /${esc(cat.slug)}
          ${parentCat ? ` · Alt: ${esc(parentCat.name)}` : ""}
          ${childCount > 0 ? ` · ${childCount} alt kategori` : ""}
        </div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;">
        <button class="btn btn-ghost btn-sm" onclick="openCatModal('${cat.id}')">✏️</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);"
          onclick="deleteCat('${cat.id}','${esc(cat.name)}')">🗑️</button>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════
// MODAL
// ══════════════════════════════════════════════
window.openCatModal = function(catId = null) {
  editingCatId = catId;
  const cat = catId ? allCategories.find(c => c.id === catId) : null;
  const titleEl = document.getElementById("cat-modal-title");
  if (titleEl) titleEl.textContent = cat ? "Kategoriyi Düzenle" : "Yeni Kategori";

  const body = document.getElementById("cat-modal-body");
  if (!body) return;

  const currentType = cat?.type || "blog";
  const currentColor = cat?.color || "#2563eb";

  // Üst kategori seçenekleri (aynı type + parentId olmayan)
  const parentOptions = allCategories
    .filter(c => c.type === currentType && !c.parentId && c.id !== catId)
    .map(c => `<option value="${c.id}" ${cat?.parentId === c.id ? "selected" : ""}>${esc(c.name)}</option>`)
    .join("");

  body.innerHTML = `
    <div class="form-group">
      <label class="form-label">Kategori Türü</label>
      <select id="cat-type" class="form-control" onchange="refreshParentOptions(this.value)">
        ${CAT_TYPES.map(t => `<option value="${t.value}" ${currentType===t.value?"selected":""}>${t.label}</option>`).join("")}
      </select>
    </div>

    <div class="form-group">
      <label class="form-label">Kategori Adı <span style="color:var(--accent-danger);">*</span></label>
      <input type="text" id="cat-name" class="form-control"
        value="${esc(cat?.name||"")}" placeholder="Örn: Temel İSG"
        oninput="const slug=document.getElementById('cat-slug');if(slug&&!slug.dataset.manual)slug.value=slugifyText(this.value);" />
    </div>

    <div class="form-group">
      <label class="form-label">URL Slug <span style="font-size:var(--text-xs);color:var(--text-muted);">(otomatik)</span></label>
      <input type="text" id="cat-slug" class="form-control" style="font-family:monospace;font-size:var(--text-sm);"
        value="${esc(cat?.slug||"")}" placeholder="temel-isg"
        oninput="this.dataset.manual='1';" />
    </div>

    <div class="form-group">
      <label class="form-label">Renk</label>
      <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;">
        <input type="color" id="cat-color-picker" value="${currentColor}"
          style="width:44px;height:36px;border:none;cursor:pointer;border-radius:4px;"
          oninput="document.getElementById('cat-color-hex').value=this.value;" />
        <input type="text" id="cat-color-hex" class="form-control" value="${currentColor}"
          style="width:90px;font-family:monospace;font-size:var(--text-sm);"
          oninput="if(this.value.match(/^#[0-9a-f]{6}$/i))document.getElementById('cat-color-picker').value=this.value;" />
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          ${CAT_COLORS.map(c => `
            <div onclick="document.getElementById('cat-color-picker').value='${c}';document.getElementById('cat-color-hex').value='${c}';"
              style="width:24px;height:24px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${c===currentColor?"#000":"transparent"};" title="${c}"></div>
          `).join("")}
        </div>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Üst Kategori <span style="font-size:var(--text-xs);color:var(--text-muted);">(opsiyonel)</span></label>
      <select id="cat-parent" class="form-control">
        <option value="">— Üst kategori yok (ana kategori) —</option>
        ${parentOptions}
      </select>
    </div>

    <div style="display:flex;gap:var(--space-3);margin-top:var(--space-5);">
      <button class="btn btn-ghost" style="flex:1;" onclick="closeCatModal()">İptal</button>
      <button class="btn btn-primary" style="flex:2;" onclick="saveCat()">💾 ${cat ? "Güncelle" : "Oluştur"}</button>
    </div>`;

  document.getElementById("cat-modal").style.display = "flex";
};

window.closeCatModal = function() {
  document.getElementById("cat-modal").style.display = "none";
  editingCatId = null;
};

window.slugifyText = slugify;

window.refreshParentOptions = function(type) {
  const select = document.getElementById("cat-parent");
  if (!select) return;
  const options = allCategories
    .filter(c => c.type === type && !c.parentId && c.id !== editingCatId)
    .map(c => `<option value="${c.id}">${esc(c.name)}</option>`)
    .join("");
  select.innerHTML = `<option value="">— Üst kategori yok (ana kategori) —</option>${options}`;
};

window.saveCat = async function() {
  const name     = document.getElementById("cat-name")?.value.trim();
  const slug     = document.getElementById("cat-slug")?.value.trim() || slugify(name);
  const type     = document.getElementById("cat-type")?.value;
  const color    = document.getElementById("cat-color-hex")?.value || "#2563eb";
  const parentId = document.getElementById("cat-parent")?.value || null;

  if (!name) { showToast("Kategori adı zorunlu.", "warning"); return; }
  if (!slug) { showToast("Slug otomatik doldurulacak.", "warning"); return; }

  // Aynı slug çakışma kontrolü (aynı type içinde)
  const duplicate = allCategories.find(c =>
    c.slug === slug && c.type === type && c.id !== editingCatId
  );
  if (duplicate) { showToast(`"${slug}" slug'ı bu türde zaten var.`, "warning"); return; }

  const order = allCategories.filter(c => c.type === type).length;

  try {
    if (editingCatId) {
      await updateDoc(doc(db, "categories", editingCatId), {
        name, slug, type, color, parentId, updatedAt: serverTimestamp()
      });
      showToast("Kategori güncellendi.", "success");
    } else {
      await addDoc(collection(db, "categories"), {
        name, slug, type, color, parentId, order,
        createdAt: serverTimestamp()
      });
      showToast("Kategori oluşturuldu.", "success");
    }
    closeCatModal();
    await loadCategories();
    renderCategories();
  } catch (err) {
    showToast("Hata: " + err.message, "error");
  }
};

window.deleteCat = async function(catId, name) {
  // Alt kategorisi var mı kontrol et
  const hasChildren = allCategories.some(c => c.parentId === catId);
  if (hasChildren) {
    showToast(`"${name}" kategorisinin alt kategorileri var. Önce onları silin.`, "warning");
    return;
  }
  if (!confirm(`"${name}" kategorisini silmek istiyor musunuz?\nBu kategoriye atanmış içerikler kategorisiz kalır.`)) return;
  try {
    await deleteDoc(doc(db, "categories", catId));
    showToast("Kategori silindi.", "info");
    await loadCategories();
    renderCategories();
  } catch (err) {
    showToast("Hata: " + err.message, "error");
  }
};

// ══════════════════════════════════════════════
// KATEGORİ SEKMESİ AKTİF OLUNCA YÜKLE
// ══════════════════════════════════════════════
// admin.js'deki switchTab fonksiyonu çağrıldığında categories tab'ı aktif olursa yükle
const _origSwitchTab = window.switchTab;
window.switchTab = function(tab) {
  if (typeof _origSwitchTab === "function") _origSwitchTab(tab);
  if (tab === "categories" && allCategories.length === 0) {
    loadCategories().then(() => renderCategories());
  } else if (tab === "categories") {
    renderCategories();
  }
};

// ══════════════════════════════════════════════
// GLOBAL ERİŞİM (diğer JS dosyaları için)
// ══════════════════════════════════════════════
export async function getCategories(type = null) {
  if (allCategories.length === 0) await loadCategories();
  return type ? allCategories.filter(c => c.type === type) : allCategories;
}
window.getCategories = getCategories;
