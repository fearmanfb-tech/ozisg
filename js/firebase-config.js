/**
 * firebase-config.js
 * ─────────────────────────────────────────────
 * Firebase yapılandırması ve servis dışa aktarımları.
 *
 * KURULUM:
 *   1. Firebase Console → Proje Ayarları → Uygulamalarım → Web uygulaması ekle
 *   2. Aşağıdaki firebaseConfig nesnesini kendi değerlerinizle doldurun.
 *   3. Bu dosyayı .gitignore'a eklemeyin; değerleri .env veya CI secrets'a koyun
 *      ya da bu değerler zaten public'tir (Firebase Auth ile güvenlik rules korumanızı sağlar).
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── BURAYA KENDİ FIREBASE YAPILANDIRMANIZI GİRİN ───
// Firebase Console > Proje Ayarları > Genel > Uygulamalarınız > Web
const firebaseConfig = {
  apiKey:            "AIzaSyCdQ3BV6U26F7uvCKqAT0QijcKGkIhBodg",
  authDomain:        "ozisg-62bc0.firebaseapp.com",
  projectId:         "ozisg-62bc0",
  storageBucket:     "ozisg-62bc0.firebasestorage.app",
  messagingSenderId: "240693996673",
  appId:             "1:240693996673:web:0f7ea1ca030634c13e7180"
};
// ─────────────────────────────────────────────────────

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

export { app, auth, db };
