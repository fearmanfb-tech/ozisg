/**
 * contact.js — İletişim Formu İşleyicisi
 * Firestore /messages koleksiyonuna yazar.
 * Admin paneli inbox'ında görünür.
 */

import { db, showToast } from "./app.js";
import {
  collection, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── DOM Referansları ───────────────────────────
const form        = document.getElementById("contactForm");
const submitBtn   = document.getElementById("submitBtn");
const successBox  = document.getElementById("successBox");
const formCard    = document.getElementById("contactFormCard");
const formError   = document.getElementById("formErrorMsg");
const formErrText = document.getElementById("formErrorText");
const charCount   = document.getElementById("charCount");

// ── Karakter Sayacı ────────────────────────────
document.getElementById("cf-message")?.addEventListener("input", function() {
  if (charCount) charCount.textContent = `${this.value.length} / 2000`;
});

// ── Validasyon Helpers ─────────────────────────
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function setFieldError(fieldId, errId, show) {
  const field = document.getElementById(fieldId);
  const err   = document.getElementById(errId);
  if (!field || !err) return;
  if (show) {
    field.classList.add("is-invalid");
    err.classList.add("show");
  } else {
    field.classList.remove("is-invalid");
    err.classList.remove("show");
  }
}

function clearErrors() {
  ["cf-name","cf-email","cf-message"].forEach(id => {
    document.getElementById(id)?.classList.remove("is-invalid");
  });
  ["err-name","err-email","err-message"].forEach(id => {
    document.getElementById(id)?.classList.remove("show");
  });
  if (formError) formError.style.display = "none";
}

// ── Yükleniyor / Hazır Durumları ───────────────
function setLoading(loading) {
  if (!submitBtn) return;
  if (loading) {
    submitBtn.classList.add("loading");
    submitBtn.disabled = true;
    submitBtn.querySelector(".btn-text").textContent = "Gönderiliyor…";
  } else {
    submitBtn.classList.remove("loading");
    submitBtn.disabled = false;
    submitBtn.querySelector(".btn-text").textContent = "📨 Mesajı Gönder";
  }
}

function showFormError(msg) {
  if (!formError || !formErrText) return;
  formErrText.textContent = msg;
  formError.style.display = "flex";
  formError.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── Başarı Ekranı ──────────────────────────────
function showSuccess() {
  if (formCard)   formCard.style.display  = "none";
  if (successBox) successBox.style.display = "block";
  successBox?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── Formu Sıfırla (Yeni Mesaj) ─────────────────
window.resetContactForm = function() {
  form?.reset();
  if (charCount) charCount.textContent = "0 / 2000";
  clearErrors();
  if (formCard)   formCard.style.display   = "";
  if (successBox) successBox.style.display = "none";
};

// ── Form Gönderim ──────────────────────────────
form?.addEventListener("submit", async function(e) {
  e.preventDefault();
  clearErrors();

  // ── 1. Honeypot kontrolü (bot tespiti) ────────
  const honeypot = document.getElementById("hp-website")?.value.trim();
  if (honeypot) {
    // Bot yakalandı — sessizce bitir, kullanıcı zannetsin gitti
    showSuccess();
    return;
  }

  // ── 2. Değerleri al ───────────────────────────
  const name    = document.getElementById("cf-name")?.value.trim()    || "";
  const email   = document.getElementById("cf-email")?.value.trim()   || "";
  const subject = document.getElementById("cf-subject")?.value        || "Genel Bilgi";
  const message = document.getElementById("cf-message")?.value.trim() || "";

  // ── 3. Doğrulama ──────────────────────────────
  let hasError = false;

  if (!name || name.length < 2) {
    setFieldError("cf-name", "err-name", true);
    hasError = true;
  }
  if (!email || !isValidEmail(email)) {
    setFieldError("cf-email", "err-email", true);
    hasError = true;
  }
  if (!message || message.length < 10) {
    setFieldError("cf-message", "err-message", true);
    document.getElementById("err-message").textContent = "Mesajınız en az 10 karakter olmalı.";
    hasError = true;
  }

  if (hasError) {
    showFormError("Lütfen kırmızı işaretli alanları kontrol edin.");
    return;
  }

  // ── 4. Firestore'a yaz ────────────────────────
  setLoading(true);

  try {
    await addDoc(collection(db, "messages"), {
      name,
      email,
      subject,
      message,
      status:    "unread",          // admin inbox için
      starred:   false,
      createdAt: serverTimestamp(),
      source:    "contact_form",    // hangi formdan geldiği
      userAgent: navigator.userAgent.slice(0, 200),
    });

    // ── 5. Başarı ─────────────────────────────
    showSuccess();
    showToast("Mesajınız başarıyla iletildi! ✅", "success");

  } catch (err) {
    console.error("[contact.js] Firestore hata:", err);
    showFormError("Mesajınız gönderilemedi: " + (err.message || "Bilinmeyen hata. Lütfen tekrar deneyin."));
    showToast("Gönderim başarısız. Lütfen tekrar deneyin.", "error");
    setLoading(false);
  }
});

// ── Canlı Validasyon (alan terk edilince) ──────
["cf-name","cf-email","cf-message"].forEach(id => {
  document.getElementById(id)?.addEventListener("blur", function() {
    if (id === "cf-name"    && this.value.trim().length >= 2)  setFieldError(id, "err-name",    false);
    if (id === "cf-email"   && isValidEmail(this.value))        setFieldError(id, "err-email",   false);
    if (id === "cf-message" && this.value.trim().length >= 10)  setFieldError(id, "err-message", false);
  });
});
