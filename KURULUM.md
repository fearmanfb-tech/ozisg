# ozisg.com Portal — Kurulum Rehberi

## Dosya Yapısı
```
ozisg-portal/
├── index.html              ← Ana sayfa
├── dashboard.html          ← Araç paneli (auth korumalı)
├── login.html              ← Giriş / Kayıt
├── linkedin-tool.html      ← LinkedIn formatörü
├── blog.html               ← (eklenecek)
├── kutuphane.html          ← (eklenecek)
├── rpa.html                ← (eklenecek)
├── tools/
│   ├── isg-rapor.html      ← (eklenecek)
│   ├── is-izni.html        ← (eklenecek)
│   └── butce.html          ← (eklenecek)
├── css/
│   ├── master.css          ← Tüm projelere taşınabilir ana CSS
│   ├── index.css
│   └── dashboard.css
├── js/
│   ├── firebase-config.js  ← Firebase yapılandırması
│   ├── app.js              ← Auth + dark mode + toast (tüm sayfalarda)
│   ├── index.js            ← Ana sayfa veri yükleme
│   ├── login.js            ← Giriş/kayıt mantığı
│   ├── dashboard.js        ← Dashboard mantığı
│   └── linkedin-tool.js    ← LinkedIn formatörü mantığı
└── firestore.rules         ← Firebase güvenlik kuralları
```

## Adım 1: Firebase Projesi Oluştur

1. https://console.firebase.google.com → Yeni Proje
2. **Authentication** → Sign-in methods → Email/Şifre ve Google'ı etkinleştir
3. **Firestore Database** → Veritabanı oluştur → **Production mode** seç
4. **Proje Ayarları** → Uygulamalarım → Web uygulaması ekle → Config nesnesini kopyala

## Adım 2: firebase-config.js'i Güncelle

`js/firebase-config.js` dosyasındaki `firebaseConfig` nesnesini kendi değerlerinizle doldurun.

## Adım 3: Firestore Kurallarını Yükle

```bash
# Firebase CLI kurulu değilse:
npm install -g firebase-tools
firebase login

# Projeyi başlat:
firebase init firestore

# Kuralları yükle:
firebase deploy --only firestore:rules
```

Ya da Firebase Console → Firestore → Kurallar sekmesine `firestore.rules` içeriğini yapıştırın.

## Adım 4: Admin Hesabı Oluştur

1. Sitede kayıt olun (login.html)
2. Firebase Console → Firestore → `users` koleksiyonu → kendi UID'nizi bulun
3. `role` alanını `"admin"` olarak güncelleyin

## Adım 5: Sunucuya Yükle (cPanel)

Tüm dosyaları `public_html/` klasörüne yükleyin.
- Firebase CDN'den yüklendiği için build gerekmez.
- HTTPS zorunludur (Firebase Auth gereksinimi).

## Diğer Projelerde Master CSS Kullanımı

```html
<!-- Başka bir projeden ozisg.com CSS'ini bağla -->
<link rel="stylesheet" href="https://ozisg.com/css/master.css" />
```

## Firestore Koleksiyon Yapısı

| Koleksiyon | Okuma | Yazma | Not |
|---|---|---|---|
| `posts` | Herkes (published) | Sadece admin | Blog yazıları |
| `books` | Herkes | Sadece admin | Kitap kütüphanesi |
| `rpa_snippets` | Herkes | Sadece admin | Kod parçacıkları |
| `users/{uid}` | Sadece kendisi | Kendisi (role hariç) | Kullanıcı profili |
| `tool_isg_reports` | Sahibi | Sahibi | İSG raporları |
| `tool_work_permits` | Sahibi | Sahibi | İş izinleri |
| `tool_budget` | Sahibi | Sahibi | Bütçe kayıtları |
| `tool_floor_plans` | Sahibi | Sahibi | Kat planları |
