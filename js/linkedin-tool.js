/**
 * linkedin-tool.js — LinkedIn İçerik Formatörü
 * Giriş gerektirmez; tamamen client-side çalışır.
 */

import { showToast } from "./app.js";

// ─── State ───
let selectedBullet = "▶";
let selectedEmoji  = "";

// ─── DOM Elementleri ───
const hookInput   = document.getElementById("hookInput");
const bodyInput   = document.getElementById("bodyInput");
const ctaInput    = document.getElementById("ctaInput");
const hashtagInput= document.getElementById("hashtagInput");
const generateBtn = document.getElementById("generateBtn");
const copyBtn     = document.getElementById("copyBtn");
const copyRawBtn  = document.getElementById("copyRawBtn");
const clearAllBtn = document.getElementById("clearAllBtn");
const previewBody = document.getElementById("previewBody");
const rawOutput   = document.getElementById("rawOutput");
const charCount   = document.getElementById("charCount");
const charWarning = document.getElementById("charWarning");
const hookCount   = document.getElementById("hookCount");

// ─── Karakter Sayacı (Hook) ───
hookInput?.addEventListener("input", () => {
  hookCount.textContent = hookInput.value.length;
});

// ─── Bullet Seçici ───
document.getElementById("bulletOptions")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".bullet-opt");
  if (!btn) return;
  document.querySelectorAll(".bullet-opt").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  selectedBullet = btn.dataset.bullet;
});

// ─── Emoji Seçici ───
document.getElementById("emojiPicker")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".emoji-opt");
  if (!btn) return;
  document.querySelectorAll(".emoji-opt").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  selectedEmoji = btn.dataset.emoji;
});

// ─── LinkedIn İçerik Üretici ───
function generateLinkedInPost() {
  const hook     = hookInput.value.trim();
  const body     = bodyInput.value.trim();
  const cta      = ctaInput.value.trim();
  const rawTags  = hashtagInput.value.trim();

  if (!hook && !body) {
    showToast("Lütfen en azından bir hook veya içerik girin.", "warning");
    return;
  }

  let post = "";

  // 1. Kancalı Giriş
  if (hook) {
    const hookLine = selectedEmoji ? `${selectedEmoji} ${hook}` : hook;
    // LinkedIn'de ilk 2 satır kritik
    post += hookLine + "\n\n";
  }

  // 2. Ana İçerik → Maddelere Dönüştür
  if (body) {
    const lines = body.split("\n");
    const formattedLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return ""; // boş satır = paragraf ayrımı
      // Zaten bir madde işareti veya emoji ile başlıyorsa dokunma
      if (/^[•▶✅🔹→⚡🎯💡📌💪🧠📊🛡️]/.test(trimmed)) return trimmed;
      return `${selectedBullet} ${trimmed}`;
    });
    post += formattedLines.join("\n") + "\n\n";
  }

  // 3. Kapanış / CTA
  if (cta) {
    post += cta + "\n\n";
  }

  // 4. Hashtagler
  if (rawTags) {
    const tags = rawTags
      .split(/[,،\s]+/)
      .map(t => t.trim().replace(/^#/, ""))
      .filter(Boolean)
      .slice(0, 8) // max 8
      .map(t => `#${t}`)
      .join(" ");
    post += tags;
  }

  const finalPost = post.trim();

  // Önizleme
  previewBody.style.color = "var(--text-primary)";
  previewBody.textContent = finalPost;

  // Ham çıktı
  rawOutput.value = finalPost;

  // Karakter sayacı
  const len = finalPost.length;
  charCount.textContent = len;
  if (len > 3000) {
    charWarning.classList.remove("hidden");
    charCount.style.color = "var(--accent-danger)";
  } else {
    charWarning.classList.add("hidden");
    charCount.style.color = len > 2500 ? "var(--accent-warning)" : "var(--text-muted)";
  }

  showToast("İçerik oluşturuldu! 🎉", "success");
}

generateBtn?.addEventListener("click", generateLinkedInPost);

// Enter ile de oluştur (hook input'ta)
hookInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) generateLinkedInPost();
});

// ─── Kopyalama ───
async function copyToClipboard(text, btn) {
  if (!text) {
    showToast("Önce içerik oluşturun.", "warning");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    const originalText = btn.textContent;
    btn.textContent = "✅ Kopyalandı!";
    setTimeout(() => { btn.textContent = originalText; }, 2000);
    showToast("Panoya kopyalandı!", "success");
  } catch {
    // Fallback
    rawOutput.select();
    document.execCommand("copy");
    showToast("Kopyalandı (eski yöntem).", "info");
  }
}

copyBtn?.addEventListener("click",    () => copyToClipboard(rawOutput.value, copyBtn));
copyRawBtn?.addEventListener("click", () => copyToClipboard(rawOutput.value, copyRawBtn));

// ─── Temizle ───
clearAllBtn?.addEventListener("click", () => {
  hookInput.value   = "";
  bodyInput.value   = "";
  ctaInput.value    = "";
  hashtagInput.value= "";
  hookCount.textContent = "0";
  previewBody.innerHTML = `
    <p style="color:var(--text-muted); text-align:center; padding: var(--space-8);">
      Sol taraftaki formu doldurun ve butona basın.<br>Önizleme burada görünecek.
    </p>`;
  rawOutput.value = "";
  charCount.textContent = "0";
  charWarning.classList.add("hidden");
  showToast("Form temizlendi.", "info");
});

// ─── Otomatik Önizleme (canlı) ───
let debounceTimer;
function debouncedGenerate() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (hookInput.value.trim() || bodyInput.value.trim()) {
      generateLinkedInPost();
    }
  }, 600);
}

[hookInput, bodyInput, ctaInput, hashtagInput].forEach(el => {
  el?.addEventListener("input", debouncedGenerate);
});
