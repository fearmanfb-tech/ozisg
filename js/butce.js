/**
 * butce.js — Bütçe Takip Aracı
 */

import { auth, db, showToast } from "./app.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, query, where, orderBy,
  getDocs, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let currentUser    = null;
let allTransactions = [];
let editingId      = null;
let selectedType   = "expense";

const CAT_LABELS = {
  maas:"💼 Maaş", kira:"🏠 Kira", market:"🛒 Market",
  fatura:"🧾 Fatura", ulasim:"🚗 Ulaşım", saglik:"💊 Sağlık",
  egitim:"📚 Eğitim", eglence:"🎬 Eğlence", diger:"📦 Diğer",
};

const fmt = (n) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 2 }).format(n);

onAuthStateChanged(auth, (user) => {
  document.getElementById("page-loading").style.display = "none";
  if (!user) { document.getElementById("auth-gate").style.display = "block"; return; }
  currentUser = user;
  document.getElementById("main-content").style.display = "block";
  document.getElementById("txDate").value = new Date().toISOString().split("T")[0];
  // Bu ayki filtrele varsayılan
  document.getElementById("filterBudgetMonth").value = new Date().toISOString().slice(0, 7);
  loadTransactions();
  setupEvents();
});

async function loadTransactions() {
  try {
    const q = query(
      collection(db, "tool_budget"),
      where("userId", "==", currentUser.uid),
      orderBy("date", "desc")
    );
    const snap = await getDocs(q);
    allTransactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    document.getElementById("transactions-loading").style.display = "none";
    document.getElementById("transactions-list").style.display = "block";
    render();
  } catch (err) {
    console.error(err);
    document.getElementById("transactions-loading").style.display = "none";
  }
}

function getFiltered() {
  const type   = document.getElementById("filterType").value;
  const cat    = document.getElementById("filterCategory").value;
  const month  = document.getElementById("filterBudgetMonth").value;
  return allTransactions.filter(t =>
    (type === "all" || t.type === type) &&
    (cat === "all" || t.category === cat) &&
    (!month || t.date?.startsWith(month))
  );
}

function render() {
  const filtered = getFiltered();
  const list  = document.getElementById("transactions-list");
  const empty = document.getElementById("transactions-empty");

  // Özet hesapla (tüm kayıtlar üzerinden, aylık filtreli)
  const month = document.getElementById("filterBudgetMonth").value;
  const monthData = month ? allTransactions.filter(t => t.date?.startsWith(month)) : allTransactions;
  const income  = monthData.filter(t => t.type === "income").reduce((s, t) => s + (t.amount || 0), 0);
  const expense = monthData.filter(t => t.type === "expense").reduce((s, t) => s + (t.amount || 0), 0);
  const net = income - expense;

  document.getElementById("totalIncome").textContent  = fmt(income);
  document.getElementById("totalExpense").textContent = fmt(expense);
  const netEl = document.getElementById("netBalance");
  netEl.textContent  = fmt(net);
  netEl.style.color  = net >= 0 ? "var(--accent-success)" : "var(--accent-danger)";

  // Kategori barları
  renderCategoryBars(monthData.filter(t => t.type === "expense"));

  if (!filtered.length) { list.innerHTML = ""; empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");

  list.innerHTML = filtered.map(t => {
    const isIncome = t.type === "income";
    return `
      <div class="card" style="margin-bottom:var(--space-3);">
        <div class="card-body" style="padding:var(--space-4) var(--space-5);">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);">
            <div style="display:flex;align-items:center;gap:var(--space-3);flex:1;min-width:0;">
              <div style="width:40px;height:40px;border-radius:var(--border-radius);background:${isIncome?"rgba(16,185,129,0.1)":"rgba(239,68,68,0.1)"};display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0;">
                ${isIncome ? "📥" : "📤"}
              </div>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:var(--font-semibold);font-size:var(--text-sm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.description}</div>
                <div style="font-size:var(--text-xs);color:var(--text-muted);">
                  ${CAT_LABELS[t.category] || t.category || "—"} · ${t.date || ""}
                  ${t.note ? ` · ${t.note}` : ""}
                </div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:var(--space-3);flex-shrink:0;">
              <span style="font-size:var(--text-base);font-weight:var(--font-bold);color:${isIncome?"var(--accent-success)":"var(--accent-danger)"};">
                ${isIncome ? "+" : "-"}${fmt(t.amount || 0)}
              </span>
              <button class="btn btn-ghost btn-sm" onclick="openEditTx('${t.id}')" style="width:32px;height:32px;padding:0;font-size:var(--text-xs);">✏️</button>
            </div>
          </div>
        </div>
      </div>`;
  }).join("");
}

function renderCategoryBars(expenses) {
  const container = document.getElementById("category-bars");
  const inner     = document.getElementById("category-bars-inner");
  if (!expenses.length) { container.style.display = "none"; return; }
  container.style.display = "block";

  const total = expenses.reduce((s, t) => s + (t.amount || 0), 0);
  const bycat = {};
  expenses.forEach(t => { bycat[t.category] = (bycat[t.category] || 0) + (t.amount || 0); });

  const sorted = Object.entries(bycat).sort((a, b) => b[1] - a[1]);
  inner.innerHTML = sorted.map(([cat, amount]) => {
    const pct = total > 0 ? (amount / total * 100).toFixed(1) : 0;
    return `
      <div style="margin-bottom:var(--space-4);">
        <div style="display:flex;justify-content:space-between;font-size:var(--text-sm);margin-bottom:var(--space-2);">
          <span>${CAT_LABELS[cat] || cat}</span>
          <span style="font-weight:var(--font-semibold);">${fmt(amount)} <span style="color:var(--text-muted);font-weight:normal;">(${pct}%)</span></span>
        </div>
        <div style="height:8px;background:var(--bg-surface-3);border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--accent-primary),var(--accent-secondary));border-radius:4px;transition:width 0.6s ease;"></div>
        </div>
      </div>`;
  }).join("");
}

function setupEvents() {
  document.getElementById("openNewTxBtn")?.addEventListener("click", () => openModal());
  document.getElementById("closeTxModal")?.addEventListener("click", closeModal);
  document.getElementById("cancelTxModal")?.addEventListener("click", closeModal);
  document.getElementById("txModal")?.addEventListener("click", e => { if (e.target===e.currentTarget) closeModal(); });
  document.getElementById("saveTxBtn")?.addEventListener("click", saveTx);
  document.getElementById("deleteTxBtn")?.addEventListener("click", deleteTx);

  // Tip butonları
  document.querySelectorAll(".tx-type-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedType = btn.dataset.type;
      document.getElementById("txType").value = selectedType;
      document.querySelectorAll(".tx-type-btn").forEach(b => {
        const isExp = b.dataset.type === "expense";
        const isSelected = b.dataset.type === selectedType;
        b.style.borderColor = isSelected ? (isExp ? "var(--accent-danger)" : "var(--accent-success)") : "var(--border-color)";
        b.style.color = isSelected ? (isExp ? "var(--accent-danger)" : "var(--accent-success)") : "var(--text-muted)";
        b.style.background = isSelected ? (isExp ? "rgba(239,68,68,0.06)" : "rgba(16,185,129,0.06)") : "none";
      });
    });
  });

  // Filtreler
  ["filterType","filterCategory","filterBudgetMonth"].forEach(id => {
    document.getElementById(id)?.addEventListener("change", render);
  });
}

function openModal(t = null) {
  editingId = t?.id || null;
  selectedType = t?.type || "expense";
  document.getElementById("txModalTitle").textContent = t ? "İşlemi Düzenle" : "İşlem Ekle";
  document.getElementById("editTxId").value    = t?.id || "";
  document.getElementById("txDesc").value      = t?.description || "";
  document.getElementById("txAmount").value    = t?.amount || "";
  document.getElementById("txDate").value      = t?.date || new Date().toISOString().split("T")[0];
  document.getElementById("txCategory").value  = t?.category || "diger";
  document.getElementById("txNote").value      = t?.note || "";
  document.getElementById("txType").value      = selectedType;
  document.getElementById("txFormError")?.classList.add("hidden");
  document.getElementById("deleteTxBtn")?.classList.toggle("hidden", !t);

  // Tip butonları görünümü
  document.querySelectorAll(".tx-type-btn").forEach(b => {
    const isExp = b.dataset.type === "expense";
    const isSelected = b.dataset.type === selectedType;
    b.style.borderColor = isSelected ? (isExp ? "var(--accent-danger)" : "var(--accent-success)") : "var(--border-color)";
    b.style.color = isSelected ? (isExp ? "var(--accent-danger)" : "var(--accent-success)") : "var(--text-muted)";
    b.style.background = isSelected ? (isExp ? "rgba(239,68,68,0.06)" : "rgba(16,185,129,0.06)") : "none";
  });

  document.getElementById("txModal").style.display = "flex";
}

function closeModal() {
  document.getElementById("txModal").style.display = "none";
  editingId = null;
}

window.openEditTx = (id) => {
  const t = allTransactions.find(t => t.id === id);
  if (t) openModal(t);
};

async function saveTx() {
  const desc   = document.getElementById("txDesc").value.trim();
  const amount = parseFloat(document.getElementById("txAmount").value);
  const date   = document.getElementById("txDate").value;

  if (!desc || isNaN(amount) || amount <= 0 || !date) {
    document.getElementById("txFormErrorText").textContent = "Açıklama, tutar ve tarih zorunludur.";
    document.getElementById("txFormError").classList.remove("hidden");
    return;
  }

  const btn = document.getElementById("saveTxBtn");
  btn.classList.add("btn-loading"); btn.disabled = true;
  document.getElementById("txFormError").classList.add("hidden");

  const data = {
    userId:      currentUser.uid,
    description: desc,
    amount,
    type:        document.getElementById("txType").value,
    category:    document.getElementById("txCategory").value,
    date,
    note:        document.getElementById("txNote").value.trim() || null,
    updatedAt:   serverTimestamp()
  };

  try {
    if (editingId) {
      await updateDoc(doc(db, "tool_budget", editingId), data);
      const idx = allTransactions.findIndex(t => t.id === editingId);
      if (idx > -1) allTransactions[idx] = { ...allTransactions[idx], ...data };
      showToast("İşlem güncellendi.", "success");
    } else {
      data.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, "tool_budget"), data);
      allTransactions.unshift({ id: ref.id, ...data, createdAt: new Date() });
      showToast("İşlem eklendi! 💰", "success");
    }
    render();
    closeModal();
  } catch (err) {
    document.getElementById("txFormErrorText").textContent = "Kayıt başarısız: " + err.message;
    document.getElementById("txFormError").classList.remove("hidden");
  } finally {
    btn.classList.remove("btn-loading"); btn.disabled = false;
  }
}

async function deleteTx() {
  if (!editingId || !confirm("Bu işlemi silmek istediğinize emin misiniz?")) return;
  try {
    await deleteDoc(doc(db, "tool_budget", editingId));
    allTransactions = allTransactions.filter(t => t.id !== editingId);
    render();
    showToast("İşlem silindi.", "success");
    closeModal();
  } catch (err) {
    showToast("Silinemedi: " + err.message, "error");
  }
}
