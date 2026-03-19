/**
 * login.js — Giriş & Kayıt Sayfası Mantığı
 */

import {
  auth,
  showToast,
  signInWithGoogle
} from "./app.js";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { db } from "./firebase-config.js";
import {
  doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Giriş yapılmışsa dashboard'a yönlendir
onAuthStateChanged(auth, (user) => {
  if (user) {
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get("redirect") || "dashboard.html";
    window.location.href = redirect;
  }
});

// ─── Tab Switcher ───
const tabLogin    = document.getElementById("tabLogin");
const tabRegister = document.getElementById("tabRegister");
const formLogin   = document.getElementById("formLogin");
const formReg     = document.getElementById("formRegister");

// URL parametresine göre tab seç
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("tab") === "register") {
  switchTab("register");
}

function switchTab(tab) {
  if (tab === "login") {
    formLogin.style.display = "block";
    formReg.style.display   = "none";
    tabLogin.classList.add("active");
    tabRegister.classList.remove("active");
  } else {
    formLogin.style.display = "none";
    formReg.style.display   = "block";
    tabRegister.classList.add("active");
    tabLogin.classList.remove("active");
  }
}

tabLogin?.addEventListener("click",    () => switchTab("login"));
tabRegister?.addEventListener("click", () => switchTab("register"));

// ─── Hata Mesajları ───
const ERROR_MESSAGES = {
  "auth/user-not-found":      "Bu e-posta ile kayıtlı bir hesap bulunamadı.",
  "auth/wrong-password":      "Şifre yanlış. Lütfen tekrar deneyin.",
  "auth/email-already-in-use":"Bu e-posta zaten kullanımda.",
  "auth/weak-password":       "Şifre en az 6 karakter olmalıdır.",
  "auth/invalid-email":       "Geçerli bir e-posta adresi girin.",
  "auth/too-many-requests":   "Çok fazla başarısız deneme. Lütfen bekleyin.",
  "auth/network-request-failed": "İnternet bağlantısını kontrol edin.",
  "auth/popup-blocked":       "Popup engellendi. Tarayıcı ayarlarını kontrol edin.",
};

function getErrorMessage(code) {
  return ERROR_MESSAGES[code] || "Bir hata oluştu. Lütfen tekrar deneyin.";
}

function showError(container, textEl, code) {
  textEl.textContent = getErrorMessage(code);
  container.classList.remove("hidden");
}

function hideError(container) {
  container.classList.add("hidden");
}

// ─── GİRİŞ FORMU ───
const loginForm       = document.getElementById("loginForm");
const loginError      = document.getElementById("loginError");
const loginErrorText  = document.getElementById("loginErrorText");
const loginSubmitBtn  = document.getElementById("loginSubmitBtn");

loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError(loginError);

  const email    = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  if (!email || !password) {
    showError(loginError, loginErrorText, "auth/invalid-email");
    return;
  }

  loginSubmitBtn.classList.add("btn-loading");
  loginSubmitBtn.disabled = true;

  try {
    await signInWithEmailAndPassword(auth, email, password);
    showToast("Giriş yapıldı! Yönlendiriliyorsunuz…", "success");
  } catch (err) {
    showError(loginError, loginErrorText, err.code);
  } finally {
    loginSubmitBtn.classList.remove("btn-loading");
    loginSubmitBtn.disabled = false;
  }
});

// ─── KAYIT FORMU ───
const registerForm      = document.getElementById("registerForm");
const registerError     = document.getElementById("registerError");
const registerErrorText = document.getElementById("registerErrorText");
const registerSuccess   = document.getElementById("registerSuccess");
const registerSubmitBtn = document.getElementById("registerSubmitBtn");

registerForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError(registerError);
  registerSuccess?.classList.add("hidden");

  const name    = document.getElementById("regName").value.trim();
  const email   = document.getElementById("regEmail").value.trim();
  const pass    = document.getElementById("regPassword").value;
  const pass2   = document.getElementById("regPasswordConfirm").value;

  if (!name || !email || !pass) {
    registerErrorText.textContent = "Lütfen tüm alanları doldurun.";
    registerError.classList.remove("hidden");
    return;
  }

  if (pass !== pass2) {
    registerErrorText.textContent = "Şifreler eşleşmiyor.";
    registerError.classList.remove("hidden");
    return;
  }

  if (pass.length < 6) {
    showError(registerError, registerErrorText, "auth/weak-password");
    return;
  }

  registerSubmitBtn.classList.add("btn-loading");
  registerSubmitBtn.disabled = true;

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);

    // Profil adını güncelle
    await updateProfile(cred.user, { displayName: name });

    // Firestore'a kullanıcı dokümanı oluştur
    await setDoc(doc(db, "users", cred.user.uid), {
      email,
      displayName: name,
      photoURL:    null,
      role:        "user",
      createdAt:   serverTimestamp(),
      lastLogin:   serverTimestamp()
    });

    registerSuccess?.classList.remove("hidden");
    showToast("Hesabınız oluşturuldu!", "success");
  } catch (err) {
    showError(registerError, registerErrorText, err.code);
  } finally {
    registerSubmitBtn.classList.remove("btn-loading");
    registerSubmitBtn.disabled = false;
  }
});

// ─── GOOGLE GİRİŞ ───
async function handleGoogleLogin() {
  try {
    const user = await signInWithGoogle();
    if (user) {
      showToast("Google ile giriş yapıldı!", "success");
    }
  } catch (err) {
    showToast(getErrorMessage(err.code), "error");
  }
}

document.getElementById("googleLoginBtn")?.addEventListener("click", handleGoogleLogin);
document.getElementById("googleRegisterBtn")?.addEventListener("click", handleGoogleLogin);

// ─── ŞİFRE GÖR/GİZLE ───
function setupPasswordToggle(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn   = document.getElementById(btnId);
  if (!input || !btn) return;
  btn.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
    btn.textContent = input.type === "password" ? "👁" : "🙈";
  });
}

setupPasswordToggle("loginPassword",       "toggleLoginPassword");
setupPasswordToggle("regPassword",         "toggleRegPassword");

// ─── ŞİFRE SIFIRLAMA MODAL ───
const forgotModal   = document.getElementById("forgotModal");
const forgotMessage = document.getElementById("forgotMessage");

document.getElementById("forgotPasswordLink")?.addEventListener("click", (e) => {
  e.preventDefault();
  forgotModal.style.display = "flex";
});

function closeForgotModal() {
  forgotModal.style.display = "none";
  if (forgotMessage) {
    forgotMessage.className = "hidden";
    forgotMessage.textContent = "";
  }
}

document.getElementById("closeForgotModal")?.addEventListener("click",  closeForgotModal);
document.getElementById("cancelForgotModal")?.addEventListener("click", closeForgotModal);

document.getElementById("sendResetEmail")?.addEventListener("click", async () => {
  const email = document.getElementById("forgotEmail").value.trim();
  if (!email) {
    forgotMessage.className = "alert alert-danger";
    forgotMessage.textContent = "Lütfen e-posta adresinizi girin.";
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    forgotMessage.className = "alert alert-success";
    forgotMessage.textContent = "Sıfırlama bağlantısı gönderildi. E-postanızı kontrol edin.";
  } catch (err) {
    forgotMessage.className = "alert alert-danger";
    forgotMessage.textContent = getErrorMessage(err.code);
  }
});
