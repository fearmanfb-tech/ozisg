/**
 * site-config-admin.js — Site CMS Yönetimi
 * Admin panelinde "Site" sekmesi için tüm modüller.
 */

import { db, showToast, clearSiteConfigCache } from "./app.js";
import {
  doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CFG_REF = () => doc(db, "site_config", "main");

const DEFAULT_MENU = [
  { id: "home",      label: "Ana Sayfa",     url: "index.html",        icon: "🏠", visible: true, order: 0 },
  { id: "blog",      label: "Blog",          url: "blog.html",         icon: "✍️", visible: true, order: 1 },
  { id: "kutuphane", label: "Kütüphane",     url: "kutuphane.html",    icon: "📚", visible: true, order: 2 },
  { id: "rpa",       label: "RPA Köşesi",    url: "rpa.html",          icon: "🤖", visible: true, order: 3 },
  { id: "linkedin",  label: "LinkedIn Aracı",url: "linkedin-tool.html",icon: "💼", visible: true, order: 4 },
  { id: "dashboard", label: "Araçlarım",     url: "dashboard.html",    icon: "🛠️", visible: true, order: 5 },
];

const DEFAULT_TOOLS = [
  { id: "tool-isg",    label: "İSG Günlük Rapor Jeneratörü",   icon: "🛡️", visible: true, order: 0 },
  { id: "tool-permit", label: "Teknik İş Takip & İSG",         icon: "📋", visible: true, order: 1 },
  { id: "tool-budget", label: "Bütçe Takip Aracı",             icon: "💰", visible: true, order: 2 },
  { id: "tool-ptk",    label: "Periyodik Teknik Kontrol (PTK)", icon: "📊", visible: true, order: 3 },
  { id: "tool-levha",  label: "İSG Levha Merkezi",             icon: "🪧", visible: true, order: 4 },
  { id: "tool-kroki",  label: "Acil Durum Krokisi",            icon: "🗺️", visible: true, order: 5 },
  { id: "tool-floor",  label: "Kat Planı Çizici",              icon: "🏗️", visible: true, order: 6 },
];

let cfg = {};

// ══════════════════════════════════════════════
// YÜKLE & KAYDET
// ══════════════════════════════════════════════
async function loadConfig() {
  try {
    const snap = await getDoc(CFG_REF());
    cfg = snap.exists() ? snap.data() : {};
  } catch (err) {
    showToast("Config yüklenemedi: " + err.message, "error");
    cfg = {};
  }
}

async function saveSection(updates) {
  try {
    await setDoc(CFG_REF(), { ...updates, updatedAt: serverTimestamp() }, { merge: true });
    clearSiteConfigCache();
    showToast("Kaydedildi.", "success");
    return true;
  } catch (err) {
    showToast("Kaydedilemedi: " + err.message, "error");
    return false;
  }
}

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════
window.initSiteConfigAdmin = async function() {
  await loadConfig();
  renderGenel();
  renderExtras();
  renderGorunum();
  renderHeroContent();
  renderMenu();
  renderHakkimda();
  renderTools();
  renderDefaults();
  renderFooter();
  renderPageDesign();
  renderHomeSections();
  renderSeo();
  renderCustomCode();
};

// ══════════════════════════════════════════════
// 1. GENEL AYARLAR
// ══════════════════════════════════════════════
function renderGenel() {
  const el = document.getElementById("site-genel-form");
  if (!el) return;
  el.innerHTML = `
    <div class="form-group">
      <label class="form-label">Site Adı <span style="font-size:var(--text-xs);color:var(--text-muted);">(navbar brand)</span></label>
      <input type="text" id="cfg-siteName" class="form-control" value="${esc(cfg.siteName||"ozisg.com")}" placeholder="ozisg.com" />
    </div>
    <div class="form-group">
      <label class="form-label">Logo Metni <span style="font-size:var(--text-xs);color:var(--text-muted);">(navbar kutu)</span></label>
      <input type="text" id="cfg-logoText" class="form-control" value="${esc(cfg.logoText||"OZ")}" placeholder="OZ" maxlength="4" />
    </div>
    <div class="form-group">
      <label class="form-label">Logo Görsel URL'i <span style="font-size:var(--text-xs);color:var(--text-muted);">(dolu ise metni geçersiz kılar)</span></label>
      <div style="display:flex;gap:var(--space-2);align-items:flex-start;">
        <input type="url" id="cfg-logoImageUrl" class="form-control" value="${esc(cfg.logoImageUrl||"")}" placeholder="https://…"
          oninput="previewLogo()" />
        <button class="btn btn-ghost btn-sm" style="white-space:nowrap;flex-shrink:0;" onclick="document.getElementById('cfg-logoImageUrl').value='';previewLogo();">✕ Sil</button>
      </div>
      <div id="logo-img-preview" style="margin-top:var(--space-2);${cfg.logoImageUrl?"":"display:none;"}">
        <img id="logo-img-tag" src="${esc(cfg.logoImageUrl||"")}" alt="Logo"
          style="height:40px;max-width:200px;object-fit:contain;border:1px solid var(--border-color);border-radius:6px;padding:4px;background:#fff;" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Favicon URL'i <span style="font-size:var(--text-xs);color:var(--text-muted);">(tarayıcı sekmesi ikonu — .ico veya .png)</span></label>
      <div style="display:flex;gap:var(--space-2);align-items:flex-start;">
        <input type="url" id="cfg-faviconUrl" class="form-control" value="${esc(cfg.faviconUrl||"")}" placeholder="https://…/favicon.ico"
          oninput="previewFavicon()" />
        <button class="btn btn-ghost btn-sm" style="white-space:nowrap;flex-shrink:0;" onclick="document.getElementById('cfg-faviconUrl').value='';previewFavicon();">✕ Sil</button>
      </div>
      <div id="favicon-preview" style="margin-top:var(--space-2);display:flex;align-items:center;gap:var(--space-2);${cfg.faviconUrl?"":"display:none!important;"}">
        <img id="favicon-img-tag" src="${esc(cfg.faviconUrl||"")}" alt="Favicon"
          style="width:24px;height:24px;object-fit:contain;" />
        <span style="font-size:var(--text-xs);color:var(--text-muted);">Sekme önizlemesi</span>
      </div>
    </div>
    <button class="btn btn-primary" style="width:100%;margin-top:var(--space-4);" onclick="saveGenel()">💾 Kimlik Bilgilerini Kaydet</button>`;
}

window.previewLogo = function() {
  const url = document.getElementById("cfg-logoImageUrl")?.value.trim();
  const wrap = document.getElementById("logo-img-preview");
  const img  = document.getElementById("logo-img-tag");
  if (wrap && img) {
    if (url) { img.src = url; wrap.style.display = "block"; img.onerror = () => { wrap.style.display = "none"; }; }
    else wrap.style.display = "none";
  }
};

window.previewFavicon = function() {
  const url = document.getElementById("cfg-faviconUrl")?.value.trim();
  const wrap = document.getElementById("favicon-preview");
  const img  = document.getElementById("favicon-img-tag");
  if (wrap && img) {
    if (url) { img.src = url; wrap.style.display = "flex"; img.onerror = () => { wrap.style.display = "none"; }; }
    else wrap.style.display = "none";
  }
};

window.saveGenel = async function() {
  const ok = await saveSection({
    siteName:    document.getElementById("cfg-siteName").value.trim(),
    logoText:    document.getElementById("cfg-logoText").value.trim(),
    logoImageUrl:document.getElementById("cfg-logoImageUrl").value.trim() || null,
    faviconUrl:  document.getElementById("cfg-faviconUrl").value.trim() || null,
  });
  if (ok) { await loadConfig(); renderGenel(); }
};

// ══════════════════════════════════════════════
// 1b. EKSTRALAR (Duyuru + Bakım)
// ══════════════════════════════════════════════
function renderExtras() {
  const el = document.getElementById("site-extras-form");
  if (!el) return;
  el.innerHTML = `
    <!-- Duyuru Bandı -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
      <span style="font-weight:var(--font-semibold);font-size:var(--text-sm);">📢 Duyuru Bandı</span>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <span style="font-size:var(--text-xs);color:var(--text-muted);">Aktif</span>
        <div class="toggle-switch" onclick="this.classList.toggle('on');document.getElementById('cfg-ann-active').checked=this.classList.contains('on');"
          style="width:40px;height:22px;background:${cfg.announcement?.active?"var(--accent-primary)":"var(--border-color)"};border-radius:99px;position:relative;cursor:pointer;transition:.2s;${cfg.announcement?.active?"":""}">
          <div style="width:18px;height:18px;background:#fff;border-radius:50%;position:absolute;top:2px;transition:.2s;left:${cfg.announcement?.active?"20px":"2px"};"></div>
        </div>
        <input type="checkbox" id="cfg-ann-active" ${cfg.announcement?.active?"checked":""} style="display:none;" />
      </label>
    </div>
    <div class="form-group">
      <input type="text" id="cfg-ann-text" class="form-control" value="${esc(cfg.announcement?.text||"")}" placeholder="Duyuru mesajı…" />
    </div>
    <div style="display:flex;gap:var(--space-3);margin-bottom:var(--space-5);">
      <div>
        <label class="form-label" style="font-size:var(--text-xs);">Arka Plan</label>
        <input type="color" id="cfg-ann-bg" value="${cfg.announcement?.bgColor||"#f97316"}" style="width:48px;height:32px;border:none;cursor:pointer;border-radius:4px;" />
      </div>
      <div>
        <label class="form-label" style="font-size:var(--text-xs);">Yazı Rengi</label>
        <input type="color" id="cfg-ann-fg" value="${cfg.announcement?.textColor||"#ffffff"}" style="width:48px;height:32px;border:none;cursor:pointer;border-radius:4px;" />
      </div>
    </div>
    <hr style="border-color:var(--border-subtle);margin:var(--space-4) 0;" />
    <!-- Bakım Modu -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
      <span style="font-weight:var(--font-semibold);font-size:var(--text-sm);color:var(--accent-danger);">🔧 Bakım Modu</span>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <span style="font-size:var(--text-xs);color:var(--text-muted);">Aktif</span>
        <div onclick="this.classList.toggle('on');document.getElementById('cfg-maint-active').checked=this.classList.contains('on');"
          style="width:40px;height:22px;background:${cfg.maintenance?.active?"var(--accent-danger)":"var(--border-color)"};border-radius:99px;position:relative;cursor:pointer;transition:.2s;">
          <div style="width:18px;height:18px;background:#fff;border-radius:50%;position:absolute;top:2px;transition:.2s;left:${cfg.maintenance?.active?"20px":"2px"};"></div>
        </div>
        <input type="checkbox" id="cfg-maint-active" ${cfg.maintenance?.active?"checked":""} style="display:none;" />
      </label>
    </div>
    <div class="form-group">
      <textarea id="cfg-maint-msg" class="form-control" rows="3"
        placeholder="Bakım mesajı…">${esc(cfg.maintenance?.message||"Site bakım çalışması yapılmaktadır. Kısa süre içinde geri döneceğiz.")}</textarea>
    </div>
    <button class="btn btn-primary" style="width:100%;margin-top:var(--space-2);" onclick="saveExtras()">💾 Kaydet</button>`;
}

window.saveExtras = async function() {
  const ok = await saveSection({
    announcement: {
      active:    document.getElementById("cfg-ann-active").checked,
      text:      document.getElementById("cfg-ann-text").value.trim(),
      bgColor:   document.getElementById("cfg-ann-bg").value,
      textColor: document.getElementById("cfg-ann-fg").value,
    },
    maintenance: {
      active:  document.getElementById("cfg-maint-active").checked,
      message: document.getElementById("cfg-maint-msg").value.trim(),
    },
  });
  if (ok) { await loadConfig(); renderExtras(); }
};

// ══════════════════════════════════════════════
// 2. GÖRÜNÜM
// ══════════════════════════════════════════════
function renderGorunum() {
  const el = document.getElementById("site-gorunum-form");
  if (!el) return;
  const color = cfg.theme?.primaryColor || "#2563eb";
  el.innerHTML = `
    <div class="form-group">
      <label class="form-label">Ana Renk (Primary Color)</label>
      <div style="display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap;">
        <input type="color" id="cfg-primaryColor" value="${color}"
          style="width:56px;height:44px;border:none;cursor:pointer;border-radius:var(--border-radius);"
          oninput="document.getElementById('cfg-primaryHex').value=this.value;document.documentElement.style.setProperty('--accent-primary',this.value);" />
        <input type="text" id="cfg-primaryHex" class="form-control" value="${color}"
          placeholder="#2563eb" style="max-width:120px;font-family:monospace;"
          oninput="if(this.value.match(/^#[0-9a-f]{6}$/i)){document.getElementById('cfg-primaryColor').value=this.value;document.documentElement.style.setProperty('--accent-primary',this.value);}" />
        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;">
          ${["#2563eb","#7c3aed","#dc2626","#16a34a","#0891b2","#d97706","#db2777","#1e293b"]
            .map(c=>`<div onclick="document.getElementById('cfg-primaryColor').value='${c}';document.getElementById('cfg-primaryHex').value='${c}';document.documentElement.style.setProperty('--accent-primary','${c}');"
              style="width:28px;height:28px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${c===color?"#000":"transparent"};transition:.15s;" title="${c}"></div>`).join("")}
        </div>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Varsayılan Tema</label>
      <div style="display:flex;gap:var(--space-4);">
        <label style="display:flex;align-items:center;gap:var(--space-2);cursor:pointer;">
          <input type="radio" name="cfg-theme-mode" value="light" ${(cfg.theme?.defaultMode||"light")==="light"?"checked":""} style="accent-color:var(--accent-primary);" />
          ☀️ Açık
        </label>
        <label style="display:flex;align-items:center;gap:var(--space-2);cursor:pointer;">
          <input type="radio" name="cfg-theme-mode" value="dark" ${cfg.theme?.defaultMode==="dark"?"checked":""} style="accent-color:var(--accent-primary);" />
          🌙 Koyu
        </label>
      </div>
    </div>
    <div class="form-group" style="margin-top:var(--space-5);">
      <label class="form-label">Sayfa Başlıkları Gradyanı <span style="font-size:var(--text-xs);color:var(--text-muted);">(header arka planı)</span></label>
      <div style="display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap;">
        <div>
          <label class="form-label" style="font-size:var(--text-xs);">Başlangıç</label>
          <input type="color" id="cfg-headerFrom" value="${cfg.theme?.headerGradientFrom||"#0f172a"}"
            style="width:48px;height:36px;border:none;cursor:pointer;border-radius:4px;"
            oninput="document.getElementById('cfg-header-preview').style.background='linear-gradient(135deg,'+this.value+','+document.getElementById('cfg-headerTo').value+')';" />
        </div>
        <div>
          <label class="form-label" style="font-size:var(--text-xs);">Bitiş</label>
          <input type="color" id="cfg-headerTo" value="${cfg.theme?.headerGradientTo||"#1e3a5f"}"
            style="width:48px;height:36px;border:none;cursor:pointer;border-radius:4px;"
            oninput="document.getElementById('cfg-header-preview').style.background='linear-gradient(135deg,'+document.getElementById('cfg-headerFrom').value+','+this.value+')';" />
        </div>
        <div id="cfg-header-preview"
          style="flex:1;min-width:120px;height:36px;border-radius:var(--border-radius);background:linear-gradient(135deg,${cfg.theme?.headerGradientFrom||"#0f172a"},${cfg.theme?.headerGradientTo||"#1e3a5f"});display:flex;align-items:center;padding:0 12px;">
          <span style="color:#fff;font-size:var(--text-xs);font-weight:600;">Başlık Önizleme</span>
        </div>
      </div>
    </div>
    <!-- Dark/Light mode ayrı renk ayarları -->
    <hr style="border-color:var(--border-subtle);margin:var(--space-5) 0;" />
    <div style="margin-bottom:var(--space-3);">
      <label class="form-label" style="font-size:var(--text-sm);">🌗 Mod Bazlı Renk Ayarları</label>
      <p style="font-size:var(--text-xs);color:var(--text-muted);margin-top:2px;">Light ve Dark modda farklı ana renk ve başlık gradyanı kullanabilirsin.</p>
    </div>
    <!-- Mod seçici sekmeler -->
    <div style="display:flex;gap:4px;margin-bottom:var(--space-4);border-bottom:2px solid var(--border-color);">
      <button id="mode-tab-light" onclick="switchModeTab('light')"
        style="padding:6px 16px;border:none;border-bottom:2px solid var(--accent-primary);background:none;cursor:pointer;font-weight:600;color:var(--accent-primary);margin-bottom:-2px;font-size:var(--text-sm);">☀️ Light</button>
      <button id="mode-tab-dark" onclick="switchModeTab('dark')"
        style="padding:6px 16px;border:none;border-bottom:2px solid transparent;background:none;cursor:pointer;font-weight:600;color:var(--text-muted);margin-bottom:-2px;font-size:var(--text-sm);">🌙 Dark</button>
    </div>

    <!-- Light mode ayarları -->
    <div id="mode-panel-light">
      <div style="display:flex;gap:var(--space-4);align-items:flex-end;flex-wrap:wrap;margin-bottom:var(--space-4);">
        <div class="form-group" style="margin:0;">
          <label class="form-label" style="font-size:var(--text-xs);">Ana Renk (Light)</label>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="color" id="cfg-light-primary" value="${cfg.theme?.light?.primaryColor||cfg.theme?.primaryColor||"#2563eb"}"
              style="width:44px;height:36px;border:none;cursor:pointer;border-radius:4px;"
              oninput="document.getElementById('cfg-light-primary-hex').value=this.value;" />
            <input type="text" id="cfg-light-primary-hex" class="form-control" style="width:90px;font-family:monospace;font-size:var(--text-xs);"
              value="${cfg.theme?.light?.primaryColor||cfg.theme?.primaryColor||"#2563eb"}"
              oninput="if(this.value.match(/^#[0-9a-f]{6}$/i))document.getElementById('cfg-light-primary').value=this.value;" />
          </div>
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label" style="font-size:var(--text-xs);">Başlık Başlangıç</label>
          <input type="color" id="cfg-light-header-from" value="${cfg.theme?.light?.headerFrom||cfg.theme?.headerGradientFrom||"#0f172a"}"
            style="width:44px;height:36px;border:none;cursor:pointer;border-radius:4px;" />
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label" style="font-size:var(--text-xs);">Başlık Bitiş</label>
          <input type="color" id="cfg-light-header-to" value="${cfg.theme?.light?.headerTo||cfg.theme?.headerGradientTo||"#1e3a5f"}"
            style="width:44px;height:36px;border:none;cursor:pointer;border-radius:4px;" />
        </div>
      </div>
    </div>

    <!-- Dark mode ayarları -->
    <div id="mode-panel-dark" style="display:none;">
      <div style="display:flex;gap:var(--space-4);align-items:flex-end;flex-wrap:wrap;margin-bottom:var(--space-4);">
        <div class="form-group" style="margin:0;">
          <label class="form-label" style="font-size:var(--text-xs);">Ana Renk (Dark)</label>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="color" id="cfg-dark-primary" value="${cfg.theme?.dark?.primaryColor||"#3b82f6"}"
              style="width:44px;height:36px;border:none;cursor:pointer;border-radius:4px;"
              oninput="document.getElementById('cfg-dark-primary-hex').value=this.value;" />
            <input type="text" id="cfg-dark-primary-hex" class="form-control" style="width:90px;font-family:monospace;font-size:var(--text-xs);"
              value="${cfg.theme?.dark?.primaryColor||"#3b82f6"}"
              oninput="if(this.value.match(/^#[0-9a-f]{6}$/i))document.getElementById('cfg-dark-primary').value=this.value;" />
          </div>
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label" style="font-size:var(--text-xs);">Başlık Başlangıç</label>
          <input type="color" id="cfg-dark-header-from" value="${cfg.theme?.dark?.headerFrom||"#0f172a"}"
            style="width:44px;height:36px;border:none;cursor:pointer;border-radius:4px;" />
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label" style="font-size:var(--text-xs);">Başlık Bitiş</label>
          <input type="color" id="cfg-dark-header-to" value="${cfg.theme?.dark?.headerTo||"#1e3a5f"}"
            style="width:44px;height:36px;border:none;cursor:pointer;border-radius:4px;" />
        </div>
      </div>
    </div>

    <button class="btn btn-primary" style="width:100%;" onclick="saveGorunum()">💾 Görünümü Kaydet</button>`;
}

window.switchModeTab = function(mode) {
  document.getElementById("mode-panel-light").style.display = mode === "light" ? "" : "none";
  document.getElementById("mode-panel-dark").style.display  = mode === "dark"  ? "" : "none";
  const lightBtn = document.getElementById("mode-tab-light");
  const darkBtn  = document.getElementById("mode-tab-dark");
  if (lightBtn) {
    lightBtn.style.borderBottomColor = mode === "light" ? "var(--accent-primary)" : "transparent";
    lightBtn.style.color             = mode === "light" ? "var(--accent-primary)" : "var(--text-muted)";
    lightBtn.style.fontWeight        = mode === "light" ? "600" : "400";
  }
  if (darkBtn) {
    darkBtn.style.borderBottomColor  = mode === "dark"  ? "var(--accent-primary)" : "transparent";
    darkBtn.style.color              = mode === "dark"  ? "var(--accent-primary)" : "var(--text-muted)";
    darkBtn.style.fontWeight         = mode === "dark"  ? "600" : "400";
  }
};

window.saveGorunum = async function() {
  const ok = await saveSection({
    theme: {
      primaryColor:        document.getElementById("cfg-primaryColor").value,
      defaultMode:         document.querySelector('input[name="cfg-theme-mode"]:checked')?.value || "light",
      headerGradientFrom:  document.getElementById("cfg-headerFrom").value,
      headerGradientTo:    document.getElementById("cfg-headerTo").value,
      light: {
        primaryColor: document.getElementById("cfg-light-primary")?.value      || null,
        headerFrom:   document.getElementById("cfg-light-header-from")?.value  || null,
        headerTo:     document.getElementById("cfg-light-header-to")?.value    || null,
      },
      dark: {
        primaryColor: document.getElementById("cfg-dark-primary")?.value       || null,
        headerFrom:   document.getElementById("cfg-dark-header-from")?.value   || null,
        headerTo:     document.getElementById("cfg-dark-header-to")?.value     || null,
      },
    }
  });
  if (ok) { await loadConfig(); renderGorunum(); }
};

// ══════════════════════════════════════════════
// 2b. HERO İÇERİĞİ
// ══════════════════════════════════════════════
function renderHeroContent() {
  const el = document.getElementById("site-hero-form");
  if (!el) return;
  const h = cfg.hero || {};
  el.innerHTML = `
    <p style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-4);">
      Ana sayfanın üst bölümündeki (hero) yazıları buradan düzenleyin. Boş bırakılan alanlar varsayılan metni kullanır.
    </p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);">

      <div class="form-group" style="grid-column:1/-1;">
        <label class="form-label">Üst Etiket Metni <span style="font-size:var(--text-xs);color:var(--text-muted);">(🛡️ İSG Uzmanı · …)</span></label>
        <input type="text" id="cfg-hero-eyebrow" class="form-control"
          value="${esc(h.eyebrow||"")}" placeholder="İSG Uzmanı · RPA Geliştiricisi · İçerik Üreticisi" />
      </div>

      <div class="form-group">
        <label class="form-label">Başlık 1. Satır <span style="font-size:var(--text-xs);color:var(--text-muted);">("Merhaba, Ben")</span></label>
        <input type="text" id="cfg-hero-title" class="form-control"
          value="${esc(h.titleLine1||"")}" placeholder="Merhaba, Ben" />
      </div>

      <div class="form-group">
        <label class="form-label">İsim / 2. Satır <span style="font-size:var(--text-xs);color:var(--text-muted);">(gradyan renk)</span></label>
        <input type="text" id="cfg-hero-name" class="form-control"
          value="${esc(h.name||"")}" placeholder="Oğuzhan Çetin" />
      </div>

      <div class="form-group" style="grid-column:1/-1;">
        <label class="form-label">Alt Başlık (Açıklama)</label>
        <textarea id="cfg-hero-subtitle" class="form-control" rows="2"
          placeholder="İş güvenliği uzmanlığını teknoloji ile harmanlıyor…">${esc(h.subtitle||"")}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Buton 1 Metni</label>
        <input type="text" id="cfg-hero-btn1-text" class="form-control"
          value="${esc(h.btn1Text||"")}" placeholder="Blog'u Oku →" />
      </div>
      <div class="form-group">
        <label class="form-label">Buton 1 Linki</label>
        <input type="text" id="cfg-hero-btn1-url" class="form-control"
          value="${esc(h.btn1Url||"")}" placeholder="blog.html" />
      </div>

      <div class="form-group">
        <label class="form-label">Buton 2 Metni</label>
        <input type="text" id="cfg-hero-btn2-text" class="form-control"
          value="${esc(h.btn2Text||"")}" placeholder="🛠️ Araçları Keşfet" />
      </div>
      <div class="form-group">
        <label class="form-label">Buton 2 Linki</label>
        <input type="text" id="cfg-hero-btn2-url" class="form-control"
          value="${esc(h.btn2Url||"")}" placeholder="dashboard.html" />
      </div>

      <div class="form-group">
        <label class="form-label">Başlık Rengi</label>
        <div style="display:flex;gap:var(--space-2);align-items:center;">
          <input type="color" id="cfg-hero-title-color-picker" value="${h.titleColor||"#ffffff"}"
            style="width:44px;height:36px;border:none;cursor:pointer;border-radius:4px;"
            oninput="document.getElementById('cfg-hero-title-color').value=this.value;" />
          <input type="text" id="cfg-hero-title-color" class="form-control" value="${esc(h.titleColor||"")}"
            placeholder="#ffffff (boş = beyaz)" style="font-family:monospace;"
            oninput="if(this.value.match(/^#[0-9a-f]{6}$/i))document.getElementById('cfg-hero-title-color-picker').value=this.value;" />
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('cfg-hero-title-color').value='';document.getElementById('cfg-hero-title-color-picker').value='#ffffff';">✕</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Alt Başlık Rengi</label>
        <div style="display:flex;gap:var(--space-2);align-items:center;">
          <input type="color" id="cfg-hero-subtitle-color-picker" value="${h.subtitleColor||"#e2e8f0"}"
            style="width:44px;height:36px;border:none;cursor:pointer;border-radius:4px;"
            oninput="document.getElementById('cfg-hero-subtitle-color').value=this.value;" />
          <input type="text" id="cfg-hero-subtitle-color" class="form-control" value="${esc(h.subtitleColor||"")}"
            placeholder="#e2e8f0 (boş = varsayılan)" style="font-family:monospace;"
            oninput="if(this.value.match(/^#[0-9a-f]{6}$/i))document.getElementById('cfg-hero-subtitle-color-picker').value=this.value;" />
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('cfg-hero-subtitle-color').value='';document.getElementById('cfg-hero-subtitle-color-picker').value='#e2e8f0';">✕</button>
        </div>
      </div>

    </div>

    <!-- Canlı Önizleme -->
    <div style="margin-top:var(--space-4);border-radius:var(--border-radius);overflow:hidden;border:1px solid var(--border-color);">
      <div style="padding:var(--space-2) var(--space-3);background:var(--bg-surface-2);font-size:var(--text-xs);color:var(--text-muted);font-weight:600;">👁 Önizleme</div>
      <div id="hero-preview" style="background:linear-gradient(135deg,#0a1628,#112952);padding:var(--space-8) var(--space-6);">
        <p style="font-size:0.7rem;font-weight:700;color:#6b9de8;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:var(--space-3);">
          🛡️ <span id="prev-eyebrow">${esc(h.eyebrow||"İSG Uzmanı · RPA Geliştiricisi · İçerik Üreticisi")}</span>
        </p>
        <h2 style="font-size:1.5rem;font-weight:800;margin-bottom:var(--space-2);color:${h.titleColor||"#fff"};">
          <span id="prev-title">${esc(h.titleLine1||"Merhaba, Ben")}</span><br>
          <span id="prev-name" style="background:linear-gradient(135deg,#6b9de8,#38bdf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">${esc(h.name||"Oğuzhan Çetin")}</span>
        </h2>
        <p style="color:${h.subtitleColor||"rgba(255,255,255,0.9)"};font-size:0.85rem;margin-bottom:var(--space-3);" id="prev-subtitle">
          ${esc(h.subtitle||"İş güvenliği uzmanlığını teknoloji ile harmanlıyor, süreçleri otomatikleştiriyor ve öğrendiklerimi burada paylaşıyorum.")}
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <span style="background:#2563eb;color:#fff;padding:6px 16px;border-radius:6px;font-size:0.8rem;font-weight:600;" id="prev-btn1">${esc(h.btn1Text||"Blog'u Oku →")}</span>
          <span style="border:1px solid rgba(255,255,255,0.4);color:#fff;padding:6px 16px;border-radius:6px;font-size:0.8rem;font-weight:600;" id="prev-btn2">${esc(h.btn2Text||"🛠️ Araçları Keşfet")}</span>
        </div>
      </div>
    </div>

    <button class="btn btn-primary" style="width:100%;margin-top:var(--space-4);" onclick="saveHeroContent()">💾 Hero İçeriğini Kaydet</button>`;

  // Canlı önizleme bağla
  ["cfg-hero-eyebrow","cfg-hero-title","cfg-hero-name","cfg-hero-subtitle","cfg-hero-btn1-text","cfg-hero-btn2-text"].forEach(id => {
    const map = {
      "cfg-hero-eyebrow":"prev-eyebrow","cfg-hero-title":"prev-title",
      "cfg-hero-name":"prev-name","cfg-hero-subtitle":"prev-subtitle",
      "cfg-hero-btn1-text":"prev-btn1","cfg-hero-btn2-text":"prev-btn2"
    };
    const input = document.getElementById(id);
    const preview = document.getElementById(map[id]);
    if (input && preview) input.oninput = () => { preview.textContent = input.value || preview.dataset.default || ""; };
    if (preview) preview.dataset.default = preview.textContent;
  });
  document.getElementById("cfg-hero-title-color")?.addEventListener("input", e => {
    const h2 = document.querySelector("#hero-preview h2");
    if (h2 && e.target.value.match(/^#[0-9a-f]{6}$/i)) h2.style.color = e.target.value;
  });
}

window.saveHeroContent = async function() {
  const ok = await saveSection({
    hero: {
      eyebrow:       document.getElementById("cfg-hero-eyebrow").value.trim()       || null,
      titleLine1:    document.getElementById("cfg-hero-title").value.trim()          || null,
      name:          document.getElementById("cfg-hero-name").value.trim()           || null,
      subtitle:      document.getElementById("cfg-hero-subtitle").value.trim()       || null,
      btn1Text:      document.getElementById("cfg-hero-btn1-text").value.trim()      || null,
      btn1Url:       document.getElementById("cfg-hero-btn1-url").value.trim()       || null,
      btn2Text:      document.getElementById("cfg-hero-btn2-text").value.trim()      || null,
      btn2Url:       document.getElementById("cfg-hero-btn2-url").value.trim()       || null,
      titleColor:    document.getElementById("cfg-hero-title-color").value.trim()    || null,
      subtitleColor: document.getElementById("cfg-hero-subtitle-color").value.trim() || null,
    }
  });
  if (ok) { await loadConfig(); renderHeroContent(); }
};

// ══════════════════════════════════════════════
// 3. ANA MENÜ
// ══════════════════════════════════════════════
let menuItems = [];

function renderMenu() {
  menuItems = cfg.menu?.length ? [...cfg.menu] : [...DEFAULT_MENU];
  menuItems.sort((a,b) => (a.order??99) - (b.order??99));
  _renderMenuList();
}

function _renderMenuList() {
  const el = document.getElementById("site-menu-list");
  if (!el) return;

  el.innerHTML = menuItems.map((item, idx) => {
    const children = item.children || [];
    return `
    <div style="border:1px solid var(--border-color);border-radius:var(--border-radius);overflow:hidden;margin-bottom:2px;" data-menu-idx="${idx}">
      <!-- Ana satır -->
      <div class="site-row" style="background:var(--bg-surface-2);opacity:${item.visible===false?"0.5":"1"};">
        <div style="display:flex;gap:2px;flex-direction:column;flex-shrink:0;">
          <button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:10px;" onclick="moveMenu(${idx},-1)" ${idx===0?"disabled":""}>▲</button>
          <button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:10px;" onclick="moveMenu(${idx},1)" ${idx===menuItems.length-1?"disabled":""}>▼</button>
        </div>
        <input type="text" class="form-control menu-icon" style="width:44px;text-align:center;font-size:1.1rem;padding:4px;" value="${esc(item.icon||"")}" placeholder="🔗" />
        <input type="text" class="form-control menu-label" style="flex:1;min-width:80px;" value="${esc(item.label)}" placeholder="Menü adı" />
        <input type="text" class="form-control menu-url" style="flex:1;min-width:80px;font-size:var(--text-xs);" value="${esc(item.url)}" placeholder="sayfa.html" />
        <label style="display:flex;align-items:center;gap:3px;cursor:pointer;white-space:nowrap;font-size:var(--text-xs);">
          <input type="checkbox" class="menu-visible" ${item.visible!==false?"checked":""} style="accent-color:var(--accent-primary);"
            onchange="this.closest('.site-row').parentElement.style.opacity=this.checked?'1':'0.5';" />
          Göster
        </label>
        <button class="btn btn-ghost btn-sm" style="font-size:10px;white-space:nowrap;flex-shrink:0;" title="Alt menü ekle"
          onclick="addChildItem(${idx})">+ Alt</button>
        ${item.custom ? `<button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);flex-shrink:0;padding:4px 6px;" onclick="deleteMenu(${idx})">🗑️</button>` : `<div style="width:28px;flex-shrink:0;"></div>`}
      </div>

      <!-- Alt menü öğeleri -->
      ${children.length > 0 ? `
        <div style="border-top:1px dashed var(--border-color);background:var(--bg-page);">
          ${children.map((child, ci) => `
            <div style="display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--border-subtle);"
              data-child-parent="${idx}" data-child-idx="${ci}">
              <span style="color:var(--text-muted);font-size:12px;flex-shrink:0;">└</span>
              <input type="text" class="form-control child-label" style="flex:1;font-size:var(--text-xs);height:30px;"
                value="${esc(child.label||"")}" placeholder="Alt öğe adı" />
              <input type="text" class="form-control child-url" style="flex:1;font-size:var(--text-xs);height:30px;"
                value="${esc(child.url||"")}" placeholder="sayfa.html" />
              <label style="display:flex;align-items:center;gap:3px;cursor:pointer;white-space:nowrap;font-size:var(--text-xs);">
                <input type="checkbox" class="child-visible" ${child.visible!==false?"checked":""}
                  style="accent-color:var(--accent-primary);" />
                Göster
              </label>
              <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);padding:2px 6px;flex-shrink:0;"
                onclick="deleteChildItem(${idx},${ci})">✕</button>
            </div>`).join("")}
        </div>` : ""}
    </div>`;
  }).join("");
}

function syncMenuFromDOM() {
  document.querySelectorAll("[data-menu-idx]").forEach((wrapper) => {
    const idx = parseInt(wrapper.dataset.menuIdx);
    if (!menuItems[idx]) return;
    const row = wrapper.querySelector(".site-row");
    if (row) {
      menuItems[idx].icon    = row.querySelector(".menu-icon")?.value.trim()    ?? menuItems[idx].icon;
      menuItems[idx].label   = row.querySelector(".menu-label")?.value.trim()   ?? menuItems[idx].label;
      menuItems[idx].url     = row.querySelector(".menu-url")?.value.trim()     ?? menuItems[idx].url;
      menuItems[idx].visible = row.querySelector(".menu-visible")?.checked      ?? menuItems[idx].visible;
    }
    // Alt öğeleri oku
    const children = [];
    wrapper.querySelectorAll("[data-child-idx]").forEach(childRow => {
      children.push({
        label:   childRow.querySelector(".child-label")?.value.trim()  || "",
        url:     childRow.querySelector(".child-url")?.value.trim()    || "",
        visible: childRow.querySelector(".child-visible")?.checked     ?? true,
      });
    });
    menuItems[idx].children = children;
  });
}

function syncToolsFromDOM() {
  document.querySelectorAll("#site-tools-list .site-row").forEach((row, idx) => {
    if (!toolItems[idx]) return;
    toolItems[idx].icon    = row.querySelector(".tool-icon-input")?.value.trim()  ?? toolItems[idx].icon;
    toolItems[idx].label   = row.querySelector(".tool-label-input")?.value.trim() ?? toolItems[idx].label;
    toolItems[idx].visible = row.querySelector(".tool-visible")?.checked          ?? toolItems[idx].visible;
  });
}

window.moveMenu = function(idx, dir) {
  syncMenuFromDOM();
  const target = idx + dir;
  if (target < 0 || target >= menuItems.length) return;
  [menuItems[idx], menuItems[target]] = [menuItems[target], menuItems[idx]];
  menuItems.forEach((m, i) => m.order = i);
  _renderMenuList();
};

window.deleteMenu = function(idx) {
  syncMenuFromDOM();
  menuItems.splice(idx, 1);
  menuItems.forEach((m, i) => m.order = i);
  _renderMenuList();
};

window.addMenuItem = function() {
  syncMenuFromDOM();
  menuItems.push({ id: "custom_" + Date.now(), label: "Yeni Sayfa", url: "#", icon: "🔗", visible: true, order: menuItems.length, custom: true, children: [] });
  _renderMenuList();
  setTimeout(() => document.getElementById("site-menu-list")?.scrollTo(0, 99999), 50);
};

window.addChildItem = function(parentIdx) {
  syncMenuFromDOM();
  if (!menuItems[parentIdx].children) menuItems[parentIdx].children = [];
  // Üst URL'i "#" yap (dropdown parent)
  if (menuItems[parentIdx].url && menuItems[parentIdx].url !== "#") {
    menuItems[parentIdx].url = "#";
  }
  menuItems[parentIdx].children.push({ label: "Alt Öğe", url: "#", visible: true });
  _renderMenuList();
};

window.deleteChildItem = function(parentIdx, childIdx) {
  syncMenuFromDOM();
  if (!menuItems[parentIdx].children) return;
  menuItems[parentIdx].children.splice(childIdx, 1);
  _renderMenuList();
};

window.saveMenu = async function() {
  syncMenuFromDOM();
  menuItems.forEach((m, i) => m.order = i);
  const ok = await saveSection({ menu: menuItems });
  if (ok) { await loadConfig(); renderMenu(); }
};

// ══════════════════════════════════════════════
// 4. HAKKIMDA
// ══════════════════════════════════════════════
function renderHakkimda() {
  const el = document.getElementById("site-hakkimda-form");
  if (!el) return;
  const a = cfg.about || {};
  el.innerHTML = `
    <div class="form-group">
      <label class="form-label">Profil Görseli URL'i</label>
      <input type="url" id="cfg-photo" class="form-control" value="${esc(a.photoUrl||"")}" placeholder="https://…" oninput="previewAboutPhoto()" />
      <div id="about-photo-preview" style="margin-top:var(--space-2);${a.photoUrl?"":"display:none;"}">
        <img id="about-photo-img" src="${esc(a.photoUrl||"")}" alt="Profil"
          style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid var(--border-color);" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Biyografi / Tanıtım Metni</label>
      <textarea id="cfg-bio" class="form-control" rows="4" placeholder="Kendinizi tanıtın…">${esc(a.bio||"")}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Yetkinlikler / Beceriler <span style="font-size:var(--text-xs);color:var(--text-muted);">(virgülle ayır)</span></label>
      <input type="text" id="cfg-skills" class="form-control" value="${esc((a.skills||[]).join(", "))}" placeholder="İSG, RPA, Python…" />
    </div>
    <div class="form-group">
      <label class="form-label">Sosyal Medya</label>
      <div style="display:flex;flex-direction:column;gap:var(--space-2);">
        <div style="display:flex;align-items:center;gap:var(--space-2);">
          <span style="width:90px;font-size:var(--text-sm);">🔗 LinkedIn</span>
          <input type="url" id="cfg-linkedin" class="form-control" value="${esc(a.social?.linkedin||"")}" placeholder="https://linkedin.com/in/…" />
        </div>
        <div style="display:flex;align-items:center;gap:var(--space-2);">
          <span style="width:90px;font-size:var(--text-sm);">🐙 GitHub</span>
          <input type="url" id="cfg-github" class="form-control" value="${esc(a.social?.github||"")}" placeholder="https://github.com/…" />
        </div>
        <div style="display:flex;align-items:center;gap:var(--space-2);">
          <span style="width:90px;font-size:var(--text-sm);">🐦 Twitter/X</span>
          <input type="url" id="cfg-twitter" class="form-control" value="${esc(a.social?.twitter||"")}" placeholder="https://twitter.com/…" />
        </div>
        <div style="display:flex;align-items:center;gap:var(--space-2);">
          <span style="width:90px;font-size:var(--text-sm);">📸 Instagram</span>
          <input type="url" id="cfg-instagram" class="form-control" value="${esc(a.social?.instagram||"")}" placeholder="https://instagram.com/…" />
        </div>
        <div style="display:flex;align-items:center;gap:var(--space-2);">
          <span style="width:90px;font-size:var(--text-sm);">▶ YouTube</span>
          <input type="url" id="cfg-youtube" class="form-control" value="${esc(a.social?.youtube||"")}" placeholder="https://youtube.com/@…" />
        </div>
      </div>
    </div>
    <div class="form-group">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-2);">
        <label class="form-label" style="margin-bottom:0;">Özel Sosyal Hesaplar</label>
        <button class="btn btn-ghost btn-sm" onclick="addCustomSocial()">➕ Ekle</button>
      </div>
      <div id="custom-social-list" style="display:flex;flex-direction:column;gap:var(--space-2);">
        ${(a.social?.custom||[]).map((c,i) => `
          <div class="site-row" data-cs-idx="${i}" style="gap:var(--space-2);">
            <input type="text" class="form-control cs-icon" style="width:52px;text-align:center;font-size:1.1rem;padding:4px;" value="${esc(c.icon||"🔗")}" placeholder="🔗" title="İkon (emoji)" />
            <input type="text" class="form-control cs-label" style="flex:1;" value="${esc(c.label||"")}" placeholder="Platform adı" />
            <input type="url" class="form-control cs-url" style="flex:2;" value="${esc(c.url||"")}" placeholder="https://…" />
            <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);flex-shrink:0;" onclick="this.closest('[data-cs-idx]').remove()">🗑️</button>
          </div>`).join("")}
      </div>
      <p style="font-size:var(--text-xs);color:var(--text-muted);margin-top:var(--space-1);">Örn: TikTok, Telegram, ResearchGate, kişisel web sitesi…</p>
    </div>
    <button class="btn btn-primary" style="width:100%;" onclick="saveHakkimda()">💾 Hakkımda Kaydet</button>`;
}

window.addCustomSocial = function() {
  const list = document.getElementById("custom-social-list");
  if (!list) return;
  const idx = list.querySelectorAll("[data-cs-idx]").length;
  const row = document.createElement("div");
  row.className = "site-row";
  row.dataset.csIdx = idx;
  row.style.gap = "var(--space-2)";
  row.innerHTML = `
    <input type="text" class="form-control cs-icon" style="width:52px;text-align:center;font-size:1.1rem;padding:4px;" value="🔗" placeholder="🔗" title="İkon (emoji)" />
    <input type="text" class="form-control cs-label" style="flex:1;" value="" placeholder="Platform adı" />
    <input type="url" class="form-control cs-url" style="flex:2;" value="" placeholder="https://…" />
    <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);flex-shrink:0;" onclick="this.closest('[data-cs-idx]').remove()">🗑️</button>`;
  list.appendChild(row);
};

window.previewAboutPhoto = function() {
  const url = document.getElementById("cfg-photo")?.value.trim();
  const wrap = document.getElementById("about-photo-preview");
  const img  = document.getElementById("about-photo-img");
  if (wrap && img) {
    if (url) { img.src = url; wrap.style.display = "block"; img.onerror = () => { wrap.style.display = "none"; }; }
    else wrap.style.display = "none";
  }
};

window.saveHakkimda = async function() {
  const customList = [...document.querySelectorAll("#custom-social-list [data-cs-idx]")]
    .map(row => ({
      icon:  row.querySelector(".cs-icon")?.value.trim()  || "🔗",
      label: row.querySelector(".cs-label")?.value.trim() || "",
      url:   row.querySelector(".cs-url")?.value.trim()   || "",
    }))
    .filter(c => c.label && c.url);

  const ok = await saveSection({
    about: {
      photoUrl: document.getElementById("cfg-photo").value.trim() || null,
      bio:      document.getElementById("cfg-bio").value.trim(),
      skills:   document.getElementById("cfg-skills").value.split(",").map(s=>s.trim()).filter(Boolean),
      social: {
        linkedin:  document.getElementById("cfg-linkedin").value.trim()  || null,
        github:    document.getElementById("cfg-github").value.trim()    || null,
        twitter:   document.getElementById("cfg-twitter").value.trim()   || null,
        instagram: document.getElementById("cfg-instagram").value.trim() || null,
        youtube:   document.getElementById("cfg-youtube").value.trim()   || null,
        custom:    customList,
      }
    }
  });
  if (ok) { await loadConfig(); renderHakkimda(); }
};

// ══════════════════════════════════════════════
// 5. ARAÇLAR YÖNETİMİ
// ══════════════════════════════════════════════
let toolItems = [];

function renderTools() {
  toolItems = cfg.tools?.length ? [...cfg.tools] : [...DEFAULT_TOOLS];
  toolItems.sort((a,b) => (a.order??99) - (b.order??99));
  _renderToolList();
}

window.moveTool = function(idx, dir) {
  syncToolsFromDOM();
  const target = idx + dir;
  if (target < 0 || target >= toolItems.length) return;
  [toolItems[idx], toolItems[target]] = [toolItems[target], toolItems[idx]];
  toolItems.forEach((t, i) => t.order = i);
  _renderToolList();
};

window.saveTools = async function() {
  syncToolsFromDOM();
  toolItems.forEach((t, i) => t.order = i);
  const ok = await saveSection({ tools: toolItems });
  if (ok) { await loadConfig(); renderTools(); }
};

// ══════════════════════════════════════════════
// 6. VARSAYILAN AYARLAR
// ══════════════════════════════════════════════
function renderDefaults() {
  const el = document.getElementById("site-defaults-form");
  if (!el) return;
  const d = cfg.registration || {};
  el.innerHTML = `
    <div class="form-group">
      <label class="form-label">Kayıt Tipi</label>
      <div style="display:flex;flex-direction:column;gap:var(--space-3);margin-top:var(--space-2);">
        <label style="display:flex;align-items:flex-start;gap:var(--space-3);cursor:pointer;padding:var(--space-3);border:1px solid var(--border-color);border-radius:var(--border-radius);">
          <input type="radio" name="cfg-reg-mode" value="open" ${(d.mode||"open")==="open"?"checked":""} style="accent-color:var(--accent-primary);margin-top:2px;" />
          <div>
            <div style="font-weight:var(--font-semibold);">Açık Kayıt</div>
            <div style="font-size:var(--text-xs);color:var(--text-muted);">Herkes kaydolabilir. Hesap "onay bekliyor" durumunda açılır.</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:var(--space-3);cursor:pointer;padding:var(--space-3);border:1px solid var(--border-color);border-radius:var(--border-radius);">
          <input type="radio" name="cfg-reg-mode" value="invite_only" ${d.mode==="invite_only"?"checked":""} style="accent-color:var(--accent-primary);margin-top:2px;" />
          <div>
            <div style="font-weight:var(--font-semibold);">Sadece Davetli</div>
            <div style="font-size:var(--text-xs);color:var(--text-muted);">Davet linki olmadan kayıt engellenecek.</div>
          </div>
        </label>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Yeni Kullanıcı Varsayılan Rolü</label>
      <select id="cfg-default-role" class="form-control">
        <option value="user"   ${(d.defaultRole||"user")==="user"?"selected":""}>👤 Kullanıcı</option>
        <option value="editor" ${d.defaultRole==="editor"?"selected":""}>✍️ Editör</option>
      </select>
    </div>
    <button class="btn btn-primary" style="width:100%;" onclick="saveDefaults()">💾 Varsayılanları Kaydet</button>`;
}

window.saveDefaults = async function() {
  const ok = await saveSection({
    registration: {
      mode:        document.querySelector('input[name="cfg-reg-mode"]:checked')?.value || "open",
      defaultRole: document.getElementById("cfg-default-role").value,
    }
  });
  if (ok) { await loadConfig(); renderDefaults(); }
};

// ══════════════════════════════════════════════
// 7. FOOTER & SEO
// ══════════════════════════════════════════════
function renderFooter() {
  const el = document.getElementById("site-footer-form");
  if (!el) return;
  const f = cfg.footer || {};
  el.innerHTML = `
    <div class="form-group">
      <label class="form-label">Copyright Metni</label>
      <input type="text" id="cfg-copyright" class="form-control" value="${esc(f.copyright||"© 2025 Oğuzhan Çetin")}" placeholder="© 2025 …" />
    </div>
    <div class="form-group">
      <label class="form-label">Footer Açıklaması <span style="font-size:var(--text-xs);color:var(--text-muted);">(copyright altı kısa metin)</span></label>
      <textarea id="cfg-f-desc" class="form-control" rows="2" placeholder="İSG uzmanı, RPA geliştiricisi…">${esc(f.description||"")}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Sosyal Medya (Footer)</label>
      <div style="display:flex;flex-direction:column;gap:var(--space-2);">
        <div style="display:flex;align-items:center;gap:var(--space-2);">
          <span style="width:90px;font-size:var(--text-sm);">🔗 LinkedIn</span>
          <input type="url" id="cfg-f-linkedin" class="form-control" value="${esc(f.social?.linkedin||"")}" placeholder="https://linkedin.com/in/…" />
        </div>
        <div style="display:flex;align-items:center;gap:var(--space-2);">
          <span style="width:90px;font-size:var(--text-sm);">🐙 GitHub</span>
          <input type="url" id="cfg-f-github" class="form-control" value="${esc(f.social?.github||"")}" placeholder="https://github.com/…" />
        </div>
        <div style="display:flex;align-items:center;gap:var(--space-2);">
          <span style="width:90px;font-size:var(--text-sm);">🐦 Twitter/X</span>
          <input type="url" id="cfg-f-twitter" class="form-control" value="${esc(f.social?.twitter||"")}" placeholder="https://twitter.com/…" />
        </div>
        <div style="display:flex;align-items:center;gap:var(--space-2);">
          <span style="width:90px;font-size:var(--text-sm);">📸 Instagram</span>
          <input type="url" id="cfg-f-instagram" class="form-control" value="${esc(f.social?.instagram||"")}" placeholder="https://instagram.com/…" />
        </div>
        <div style="display:flex;align-items:center;gap:var(--space-2);">
          <span style="width:90px;font-size:var(--text-sm);">▶ YouTube</span>
          <input type="url" id="cfg-f-youtube" class="form-control" value="${esc(f.social?.youtube||"")}" placeholder="https://youtube.com/@…" />
        </div>
      </div>
    </div>
    <div class="form-group">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-2);">
        <label class="form-label" style="margin-bottom:0;">Özel Footer Linkleri</label>
        <button class="btn btn-ghost btn-sm" onclick="addFooterLink()">➕ Ekle</button>
      </div>
      <div id="footer-links-list" style="display:flex;flex-direction:column;gap:var(--space-2);">
        ${(f.customLinks||[]).map((l,i) => `
          <div class="site-row" data-fl-idx="${i}" style="gap:var(--space-2);">
            <input type="text" class="form-control fl-label" style="flex:1;" value="${esc(l.label||"")}" placeholder="Link metni" />
            <input type="url" class="form-control fl-url" style="flex:2;" value="${esc(l.url||"")}" placeholder="https://…" />
            <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);flex-shrink:0;" onclick="this.closest('[data-fl-idx]').remove()">🗑️</button>
          </div>`).join("")}
      </div>
      <p style="font-size:var(--text-xs);color:var(--text-muted);margin-top:var(--space-1);">Gizlilik politikası, iletişim, SSS gibi ek linkler.</p>
    </div>
    <div class="form-group">
      <label class="form-label">OG Image URL <span style="font-size:var(--text-xs);color:var(--text-muted);">(sosyal medya paylaşım görseli)</span></label>
      <input type="url" id="cfg-og-image" class="form-control" value="${esc(f.ogImage||"")}" placeholder="https://…" />
    </div>
    <button class="btn btn-primary" style="width:100%;" onclick="saveFooter()">💾 Footer Kaydet</button>`;
}

window.addFooterLink = function() {
  const list = document.getElementById("footer-links-list");
  if (!list) return;
  const idx = list.querySelectorAll("[data-fl-idx]").length;
  const row = document.createElement("div");
  row.className = "site-row";
  row.dataset.flIdx = idx;
  row.style.gap = "var(--space-2)";
  row.innerHTML = `
    <input type="text" class="form-control fl-label" style="flex:1;" value="" placeholder="Link metni" />
    <input type="url" class="form-control fl-url" style="flex:2;" value="" placeholder="https://…" />
    <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);flex-shrink:0;" onclick="this.closest('[data-fl-idx]').remove()">🗑️</button>`;
  list.appendChild(row);
};

window.saveFooter = async function() {
  const customLinks = [...document.querySelectorAll("#footer-links-list [data-fl-idx]")]
    .map(row => ({
      label: row.querySelector(".fl-label")?.value.trim() || "",
      url:   row.querySelector(".fl-url")?.value.trim()   || "",
    }))
    .filter(l => l.label && l.url);

  const ok = await saveSection({
    footer: {
      copyright:   document.getElementById("cfg-copyright").value.trim(),
      description: document.getElementById("cfg-f-desc").value.trim() || null,
      social: {
        linkedin:  document.getElementById("cfg-f-linkedin").value.trim()  || null,
        github:    document.getElementById("cfg-f-github").value.trim()    || null,
        twitter:   document.getElementById("cfg-f-twitter").value.trim()   || null,
        instagram: document.getElementById("cfg-f-instagram").value.trim() || null,
        youtube:   document.getElementById("cfg-f-youtube").value.trim()   || null,
      },
      customLinks,
      ogImage: document.getElementById("cfg-og-image").value.trim() || null,
    }
  });
  if (ok) { await loadConfig(); renderFooter(); }
};

// ══════════════════════════════════════════════
// 8. SAYFA TASARIMI (Per-page design)
// ══════════════════════════════════════════════
const PAGE_LIST = [
  { id: "index",        label: "Ana Sayfa",       file: "index.html" },
  { id: "blog",         label: "Blog",             file: "blog.html" },
  { id: "kutuphane",    label: "Kütüphane",        file: "kutuphane.html" },
  { id: "rpa",          label: "RPA Köşesi",       file: "rpa.html" },
  { id: "linkedin-tool",label: "LinkedIn Aracı",   file: "linkedin-tool.html" },
  { id: "dashboard",    label: "Araçlarım",        file: "dashboard.html" },
  { id: "admin",        label: "Admin Paneli",     file: "admin.html" },
];

const FONT_OPTIONS = [
  { value: "",              label: "Varsayılan (Inter)" },
  { value: "Inter",         label: "Inter" },
  { value: "Roboto",        label: "Roboto" },
  { value: "Open Sans",     label: "Open Sans" },
  { value: "Poppins",       label: "Poppins" },
  { value: "Montserrat",    label: "Montserrat" },
  { value: "Lato",          label: "Lato" },
  { value: "Nunito",        label: "Nunito" },
  { value: "Raleway",       label: "Raleway" },
];

function renderPageDesign() {
  const el = document.getElementById("site-pagedesign-form");
  if (!el) return;
  const pages      = cfg.pageDesign   || {};
  const customPages = cfg.customPages || [];

  // Tüm sayfalar: sabit + özel
  const allPages = [
    ...PAGE_LIST.map(p => ({ ...p, custom: false })),
    ...customPages.map(p => ({ ...p, custom: true })),
  ];

  const pageRow = (p) => {
    const pd = pages[p.id] || {};
    return `
      <details style="border:1px solid var(--border-color);border-radius:var(--border-radius);overflow:hidden;" ${pd.disabled ? "" : ""}>
        <summary style="padding:var(--space-3) var(--space-4);background:var(--bg-surface-2);cursor:pointer;font-size:var(--text-sm);display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);">
          <span style="font-weight:var(--font-semibold);flex:1;">${esc(p.label)}</span>
          <span style="font-size:var(--text-xs);color:var(--text-muted);font-weight:normal;">${esc(p.file)}</span>
          ${pd.disabled ? `<span style="background:var(--accent-danger);color:#fff;padding:1px 7px;border-radius:99px;font-size:10px;margin-left:4px;">Kapalı</span>` : ""}
          ${p.custom ? `<button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);padding:2px 6px;font-size:11px;margin-left:4px;"
            onclick="event.stopPropagation();deleteCustomPage('${p.id}','${esc(p.label)}')">🗑️</button>` : ""}
        </summary>
        <div style="padding:var(--space-4);display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);" data-page="${p.id}">
          <div class="form-group" style="margin:0;">
            <label class="form-label" style="font-size:var(--text-xs);">Ana Renk <span style="color:var(--text-muted);">(primary override)</span></label>
            <div style="display:flex;gap:var(--space-2);align-items:center;">
              <input type="color" class="pd-primary" value="${pd.primaryColor||"#2563eb"}"
                style="width:40px;height:32px;border:none;cursor:pointer;border-radius:4px;" />
              <input type="text" class="form-control pd-primary-hex" value="${pd.primaryColor||""}"
                placeholder="Boş = global" style="font-family:monospace;font-size:var(--text-xs);"
                oninput="if(this.value.match(/^#[0-9a-f]{6}$/i))this.previousElementSibling.value=this.value;" />
            </div>
          </div>
          <div class="form-group" style="margin:0;">
            <label class="form-label" style="font-size:var(--text-xs);">Yazı Tipi</label>
            <select class="form-control pd-font">
              ${FONT_OPTIONS.map(f => `<option value="${f.value}" ${pd.fontFamily===f.value?"selected":""}>${f.label}</option>`).join("")}
            </select>
          </div>
          <div class="form-group" style="margin:0;">
            <label class="form-label" style="font-size:var(--text-xs);">Yazı Boyutu <span style="color:var(--text-muted);">(ölçek %)</span></label>
            <div style="display:flex;gap:var(--space-2);align-items:center;">
              <input type="range" class="pd-font-scale" min="80" max="130" step="5" value="${pd.fontScale||100}"
                style="flex:1;" oninput="this.nextElementSibling.textContent=this.value+'%'" />
              <span style="min-width:40px;font-size:var(--text-xs);font-weight:600;">${pd.fontScale||100}%</span>
            </div>
          </div>
          <div class="form-group" style="margin:0;">
            <label class="form-label" style="font-size:var(--text-xs);">Header Rengi 1</label>
            <input type="color" class="pd-header-from" value="${pd.headerFrom||"#0f172a"}"
              style="width:100%;height:32px;border:none;cursor:pointer;border-radius:4px;" />
          </div>
          <div class="form-group" style="margin:0;">
            <label class="form-label" style="font-size:var(--text-xs);">Header Rengi 2</label>
            <input type="color" class="pd-header-to" value="${pd.headerTo||"#1e3a5f"}"
              style="width:100%;height:32px;border:none;cursor:pointer;border-radius:4px;" />
          </div>
          <div class="form-group" style="margin:0;grid-column:1/-1;display:flex;align-items:center;gap:var(--space-2);">
            <input type="checkbox" class="pd-visible" ${pd.disabled?"":"checked"} style="accent-color:var(--accent-primary);width:16px;height:16px;" />
            <label style="font-size:var(--text-sm);cursor:pointer;">Sayfa Aktif
              <span style="color:var(--text-muted);font-size:var(--text-xs);">(devre dışı → "Bu sayfa kullanılamıyor" mesajı gösterir)</span>
            </label>
          </div>
        </div>
      </details>`;
  };

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-3);margin-bottom:var(--space-4);">
      <p style="font-size:var(--text-sm);color:var(--text-muted);margin:0;">
        Her sayfa için bağımsız renk ve yazı tipi. Sayfayı kapat → "kullanılamıyor" ekranı gösterir.
      </p>
      <button class="btn btn-ghost btn-sm" onclick="openAddPageModal()">➕ Sayfa Ekle</button>
    </div>

    <div style="display:flex;flex-direction:column;gap:var(--space-3);">
      <div style="font-size:var(--text-xs);font-weight:600;color:var(--text-muted);padding:0 var(--space-2);margin-top:var(--space-2);">SİSTEM SAYFALARI</div>
      ${PAGE_LIST.map(p => pageRow({ ...p, custom: false })).join("")}

      ${customPages.length ? `
        <div style="font-size:var(--text-xs);font-weight:600;color:var(--text-muted);padding:0 var(--space-2);margin-top:var(--space-3);">ÖZEL SAYFALAR</div>
        ${customPages.map(p => pageRow({ ...p, custom: true })).join("")}
      ` : ""}
    </div>

    <div style="display:flex;gap:var(--space-3);margin-top:var(--space-5);">
      <button class="btn btn-primary" style="flex:1;" onclick="savePageDesign()">💾 Tasarım Ayarlarını Kaydet</button>
    </div>

    <!-- Sayfa Ekle Modalı -->
    <div id="add-page-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9500;align-items:center;justify-content:center;">
      <div style="background:var(--bg-surface,#fff);border-radius:12px;padding:var(--space-6);width:400px;max-width:95vw;box-shadow:0 20px 60px rgba(0,0,0,.3);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-5);">
          <h3 style="font-weight:700;">➕ Özel Sayfa Ekle</h3>
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('add-page-modal').style.display='none'">✕</button>
        </div>
        <div class="form-group">
          <label class="form-label">Sayfa Adı</label>
          <input type="text" id="new-page-label" class="form-control" placeholder="Örn: İletişim" />
        </div>
        <div class="form-group">
          <label class="form-label">HTML Dosyası <span style="font-size:var(--text-xs);color:var(--text-muted);">(cPanel'de var olmalı)</span></label>
          <input type="text" id="new-page-file" class="form-control" placeholder="iletisim.html" style="font-family:monospace;" />
        </div>
        <div style="background:var(--bg-surface-2);border-radius:var(--border-radius);padding:var(--space-3);margin-bottom:var(--space-4);font-size:var(--text-xs);color:var(--text-muted);">
          💡 Dosyayı önce cPanel File Manager'dan <code>public_html/</code> içine yükleyin, ardından buradan ekleyin.
        </div>
        <div style="display:flex;gap:var(--space-3);">
          <button class="btn btn-ghost" style="flex:1;" onclick="document.getElementById('add-page-modal').style.display='none'">İptal</button>
          <button class="btn btn-primary" style="flex:2;" onclick="addCustomPage()">Ekle</button>
        </div>
      </div>
    </div>`;
}

window.openAddPageModal = function() {
  document.getElementById("add-page-modal").style.display = "flex";
  document.getElementById("new-page-label").value = "";
  document.getElementById("new-page-file").value  = "";
};

window.addCustomPage = async function() {
  const label = document.getElementById("new-page-label")?.value.trim();
  const file  = document.getElementById("new-page-file")?.value.trim().replace(/^\/+/,"");
  if (!label || !file) { showToast("Ad ve dosya zorunlu.", "warning"); return; }
  if (!file.endsWith(".html")) { showToast("Dosya adı .html ile bitmeli.", "warning"); return; }

  const id = file.replace(".html","").replace(/[^a-z0-9-_]/gi,"_");
  const customPages = [...(cfg.customPages || [])];
  if (customPages.find(p => p.id === id)) { showToast("Bu sayfa zaten kayıtlı.", "warning"); return; }

  customPages.push({ id, label, file });
  const ok = await saveSection({ customPages });
  if (ok) {
    document.getElementById("add-page-modal").style.display = "none";
    await loadConfig();
    renderPageDesign();
    showToast(`"${label}" sayfası eklendi.`, "success");
  }
};

window.deleteCustomPage = async function(id, label) {
  if (!confirm(`"${label}" sayfasını listeden kaldırmak istiyor musunuz?\n(Fiziksel dosya cPanel'de kalır, sadece bu kayıt silinir.)`)) return;
  const customPages = (cfg.customPages || []).filter(p => p.id !== id);

  // pageDesign'dan da kaldır
  const pageDesign = { ...(cfg.pageDesign || {}) };
  delete pageDesign[id];

  const ok = await saveSection({ customPages, pageDesign });
  if (ok) { await loadConfig(); renderPageDesign(); }
};

window.savePageDesign = async function() {
  const pageDesign = {};
  document.querySelectorAll("[data-page]").forEach(section => {
    const pageId   = section.dataset.page;
    const primary  = section.querySelector(".pd-primary-hex")?.value.trim() || null;
    const font     = section.querySelector(".pd-font")?.value || "";
    const scale    = parseInt(section.querySelector(".pd-font-scale")?.value) || 100;
    const hFrom    = section.querySelector(".pd-header-from")?.value || null;
    const hTo      = section.querySelector(".pd-header-to")?.value   || null;
    const disabled = !(section.querySelector(".pd-visible")?.checked ?? true);
    pageDesign[pageId] = {
      primaryColor: primary || null,
      fontFamily:   font || null,
      fontScale:    scale === 100 ? null : scale,
      headerFrom:   hFrom,
      headerTo:     hTo,
      disabled,
    };
  });
  const ok = await saveSection({ pageDesign });
  if (ok) { await loadConfig(); renderPageDesign(); }
};

// ══════════════════════════════════════════════
// 9. ARAÇ YÖNETİMİ — silme özelliği
// ══════════════════════════════════════════════
function _renderToolList() {
  const el = document.getElementById("site-tools-list");
  if (!el) return;

  el.innerHTML = toolItems.map((tool, idx) => `
    <div class="site-row" data-idx="${idx}" style="opacity:${tool.visible===false?"0.5":"1"};">
      <div style="display:flex;gap:var(--space-2);flex-direction:column;flex-shrink:0;">
        <button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:10px;" onclick="moveTool(${idx},-1)" ${idx===0?"disabled":""}>▲</button>
        <button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:10px;" onclick="moveTool(${idx},1)" ${idx===toolItems.length-1?"disabled":""}>▼</button>
      </div>
      <input type="text" class="form-control tool-icon-input" style="width:52px;text-align:center;font-size:1.3rem;padding:4px;" value="${esc(tool.icon||"")}" placeholder="🛠️" />
      <input type="text" class="form-control tool-label-input" style="flex:1;" value="${esc(tool.label)}" placeholder="Araç adı" />
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;font-size:var(--text-xs);">
        <input type="checkbox" class="tool-visible" ${tool.visible!==false?"checked":""} style="accent-color:var(--accent-primary);"
          onchange="this.closest('.site-row').style.opacity=this.checked?'1':'0.5';" />
        Göster
      </label>
      <button class="btn btn-ghost btn-sm" style="color:var(--accent-danger);flex-shrink:0;" title="Araç kartını kaldır"
        onclick="deleteTool(${idx})">🗑️</button>
    </div>`).join("") + `
    <button class="btn btn-ghost btn-sm" style="margin-top:var(--space-2);border:1px dashed var(--border-color);width:100%;justify-content:center;" onclick="addCustomTool()">➕ Özel Araç Ekle</button>`;
}

window.deleteTool = function(idx) {
  syncToolsFromDOM();
  if (!confirm("Bu araç kartını listeden kaldırmak istiyor musunuz?")) return;
  toolItems.splice(idx, 1);
  toolItems.forEach((t, i) => t.order = i);
  _renderToolList();
};

window.addCustomTool = function() {
  syncToolsFromDOM();
  toolItems.push({
    id:      "tool-custom-" + Date.now(),
    label:   "Yeni Araç",
    icon:    "🛠️",
    url:     "#",
    visible: true,
    order:   toolItems.length,
    custom:  true,
  });
  _renderToolList();
  setTimeout(() => document.getElementById("site-tools-list")?.scrollTo(0, 99999), 50);
};

// ══════════════════════════════════════════════
// 10. ANA SAYFA BÖLÜMLERİ
// ══════════════════════════════════════════════
const HOME_SECTIONS = [
  { id: "section-hero",  label: "Hero Bölümü",       icon: "🏠" },
  { id: "section-posts", label: "Son Blog Yazıları",  icon: "✍️" },
  { id: "section-books", label: "Kütüphane",          icon: "📚" },
  { id: "section-tools", label: "Araçlar Vitrini",    icon: "🛠️" },
  { id: "section-about", label: "Hakkımda Teaser",    icon: "👤" },
];

let homeSectionItems = [];

function renderHomeSections() {
  const el = document.getElementById("site-home-sections-form");
  if (!el) return;
  const hs = cfg.homeSections || {};

  homeSectionItems = HOME_SECTIONS.map((s, i) => ({
    ...s,
    visible: hs[s.id]?.visible !== false,
    order:   hs[s.id]?.order ?? i,
    title:   hs[s.id]?.title || "",
    subtitle:hs[s.id]?.subtitle || "",
    bgColor: hs[s.id]?.bgColor || "",
  }));
  homeSectionItems.sort((a, b) => a.order - b.order);

  _renderHomeSectionList();
}

function _renderHomeSectionList() {
  const el = document.getElementById("site-home-sections-form");
  if (!el) return;

  el.innerHTML = `
    <p style="font-size:var(--text-sm);color:var(--text-muted);margin-bottom:var(--space-4);">
      Sırayı değiştirin, bölümleri gizleyin veya başlık/renk özelleştirin.
    </p>
    <div id="hs-list" style="display:flex;flex-direction:column;gap:var(--space-3);">
      ${homeSectionItems.map((s, idx) => `
        <details style="border:1px solid var(--border-color);border-radius:var(--border-radius);overflow:hidden;opacity:${s.visible?"1":"0.5"};">
          <summary style="padding:var(--space-3) var(--space-4);background:var(--bg-surface-2);cursor:pointer;display:flex;align-items:center;gap:var(--space-3);">
            <div style="display:flex;gap:4px;flex-direction:column;flex-shrink:0;">
              <button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:10px;" onclick="event.preventDefault();moveHSection(${idx},-1)" ${idx===0?"disabled":""}>▲</button>
              <button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:10px;" onclick="event.preventDefault();moveHSection(${idx},1)" ${idx===homeSectionItems.length-1?"disabled":""}>▼</button>
            </div>
            <span style="font-size:1.1rem;">${s.icon}</span>
            <span style="font-weight:var(--font-semibold);font-size:var(--text-sm);flex:1;">${s.label}</span>
            <label onclick="event.stopPropagation();" style="display:flex;align-items:center;gap:6px;font-size:var(--text-xs);cursor:pointer;">
              <input type="checkbox" class="hs-visible" ${s.visible?"checked":""} style="accent-color:var(--accent-primary);"
                onchange="this.closest('details').style.opacity=this.checked?'1':'0.5';" />
              Göster
            </label>
          </summary>
          <div style="padding:var(--space-4);display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);" data-hs-idx="${idx}">
            <div class="form-group" style="margin:0;">
              <label class="form-label" style="font-size:var(--text-xs);">Bölüm Başlığı <span style="color:var(--text-muted);">(boş = varsayılan)</span></label>
              <input type="text" class="form-control hs-title" value="${esc(s.title)}" placeholder="Örn: Son Yazılarım" />
            </div>
            <div class="form-group" style="margin:0;">
              <label class="form-label" style="font-size:var(--text-xs);">Alt Başlık</label>
              <input type="text" class="form-control hs-subtitle" value="${esc(s.subtitle)}" placeholder="Kısa açıklama…" />
            </div>
            <div class="form-group" style="margin:0;">
              <label class="form-label" style="font-size:var(--text-xs);">Arka Plan Rengi <span style="color:var(--text-muted);">(boş = varsayılan)</span></label>
              <div style="display:flex;gap:var(--space-2);align-items:center;">
                <input type="color" class="hs-bg-color-picker" value="${s.bgColor||"#ffffff"}"
                  style="width:40px;height:32px;border:none;cursor:pointer;border-radius:4px;"
                  oninput="this.nextElementSibling.value=this.value" />
                <input type="text" class="form-control hs-bg-color" value="${esc(s.bgColor)}" placeholder="Boş = varsayılan"
                  style="font-family:monospace;font-size:var(--text-xs);"
                  oninput="if(this.value.match(/^#[0-9a-f]{6}$/i))this.previousElementSibling.value=this.value;" />
                <button class="btn btn-ghost btn-sm" style="flex-shrink:0;font-size:var(--text-xs);"
                  onclick="this.previousElementSibling.value='';this.previousElementSibling.previousElementSibling.previousElementSibling.value='#ffffff';">✕</button>
              </div>
            </div>
          </div>
        </details>`).join("")}
    </div>
    <button class="btn btn-primary" style="width:100%;margin-top:var(--space-4);" onclick="saveHomeSections()">💾 Ana Sayfa Bölümlerini Kaydet</button>`;
}

function syncHomeSectionsFromDOM() {
  document.querySelectorAll("[data-hs-idx]").forEach((section, idx) => {
    if (!homeSectionItems[idx]) return;
    homeSectionItems[idx].visible  = section.closest("details").querySelector(".hs-visible")?.checked ?? true;
    homeSectionItems[idx].title    = section.querySelector(".hs-title")?.value.trim()    || "";
    homeSectionItems[idx].subtitle = section.querySelector(".hs-subtitle")?.value.trim() || "";
    homeSectionItems[idx].bgColor  = section.querySelector(".hs-bg-color")?.value.trim() || "";
  });
}

window.moveHSection = function(idx, dir) {
  syncHomeSectionsFromDOM();
  const target = idx + dir;
  if (target < 0 || target >= homeSectionItems.length) return;
  [homeSectionItems[idx], homeSectionItems[target]] = [homeSectionItems[target], homeSectionItems[idx]];
  homeSectionItems.forEach((s, i) => s.order = i);
  _renderHomeSectionList();
};

window.saveHomeSections = async function() {
  syncHomeSectionsFromDOM();
  homeSectionItems.forEach((s, i) => s.order = i);
  const homeSections = {};
  homeSectionItems.forEach(s => {
    homeSections[s.id] = {
      visible:  s.visible,
      order:    s.order,
      title:    s.title || null,
      subtitle: s.subtitle || null,
      bgColor:  s.bgColor || null,
    };
  });
  const ok = await saveSection({ homeSections });
  if (ok) { await loadConfig(); renderHomeSections(); }
};

// ══════════════════════════════════════════════
// 11. SEO & ANALİTİK
// ══════════════════════════════════════════════
function renderSeo() {
  const el = document.getElementById("site-seo-form");
  if (!el) return;
  const s = cfg.seo || {};
  el.innerHTML = `
    <p style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-4);">
      Arama motorları ve sosyal medya paylaşımları için temel SEO ayarları.
      Boş bırakılan alanlar sayfa başlığını kullanır.
    </p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);">

      <div class="form-group">
        <label class="form-label">Varsayılan Site Başlığı</label>
        <input type="text" id="cfg-seo-title" class="form-control"
          value="${esc(s.defaultTitle||"")}" placeholder="ozisg.com" />
      </div>

      <div class="form-group">
        <label class="form-label">Başlık Ayırıcı <span style="font-size:var(--text-xs);color:var(--text-muted);">(Sayfa | Site)</span></label>
        <input type="text" id="cfg-seo-separator" class="form-control"
          value="${esc(s.titleSeparator||"")}" placeholder=" | " style="max-width:80px;" />
      </div>

      <div class="form-group" style="grid-column:1/-1;">
        <label class="form-label">Meta Açıklama</label>
        <textarea id="cfg-seo-description" class="form-control" rows="2"
          placeholder="İSG uzmanları için dijital araçlar ve otomasyon içerikleri.">${esc(s.defaultDescription||"")}</textarea>
        <span id="seo-desc-count" style="font-size:10px;color:var(--text-muted);">0 / 160 karakter</span>
      </div>

      <div class="form-group" style="grid-column:1/-1;">
        <label class="form-label">Anahtar Kelimeler <span style="font-size:var(--text-xs);color:var(--text-muted);">(virgülle ayır)</span></label>
        <input type="text" id="cfg-seo-keywords" class="form-control"
          value="${esc(s.keywords||"")}" placeholder="isg, iş güvenliği, risk analizi, rpa" />
      </div>

      <div class="form-group" style="grid-column:1/-1;">
        <label class="form-label">OG Görsel URL <span style="font-size:var(--text-xs);color:var(--text-muted);">(sosyal medya paylaşım görseli)</span></label>
        <input type="url" id="cfg-seo-ogimage" class="form-control"
          value="${esc(s.ogImage||"")}" placeholder="https://ozisg.com/img/og-image.jpg" />
      </div>

      <div class="form-group">
        <label class="form-label">Google Analytics ID</label>
        <input type="text" id="cfg-seo-ga" class="form-control"
          value="${esc(s.googleAnalyticsId||"")}" placeholder="G-XXXXXXXXXX" style="font-family:monospace;" />
      </div>

      <div class="form-group">
        <label class="form-label">Google Tag Manager ID</label>
        <input type="text" id="cfg-seo-gtm" class="form-control"
          value="${esc(s.googleTagManagerId||"")}" placeholder="GTM-XXXXXXX" style="font-family:monospace;" />
      </div>

    </div>
    <button class="btn btn-primary" style="width:100%;margin-top:var(--space-4);" onclick="saveSeo()">💾 SEO Ayarlarını Kaydet</button>`;

  // Açıklama karakter sayacı
  const desc = document.getElementById("cfg-seo-description");
  const count = document.getElementById("seo-desc-count");
  if (desc && count) {
    const update = () => {
      const len = desc.value.length;
      count.textContent = `${len} / 160 karakter`;
      count.style.color = len > 160 ? "var(--accent-danger)" : len > 120 ? "var(--accent-warning)" : "var(--text-muted)";
    };
    update();
    desc.addEventListener("input", update);
  }
}

window.saveSeo = async function() {
  const ok = await saveSection({
    seo: {
      defaultTitle:      document.getElementById("cfg-seo-title").value.trim()       || null,
      titleSeparator:    document.getElementById("cfg-seo-separator").value           || " | ",
      defaultDescription:document.getElementById("cfg-seo-description").value.trim() || null,
      keywords:          document.getElementById("cfg-seo-keywords").value.trim()     || null,
      ogImage:           document.getElementById("cfg-seo-ogimage").value.trim()      || null,
      googleAnalyticsId: document.getElementById("cfg-seo-ga").value.trim()          || null,
      googleTagManagerId:document.getElementById("cfg-seo-gtm").value.trim()         || null,
    }
  });
  if (ok) { await loadConfig(); renderSeo(); }
};

// ══════════════════════════════════════════════
// 12. ÖZEL CSS
// ══════════════════════════════════════════════
function renderCustomCode() {
  const el = document.getElementById("site-customcode-form");
  if (!el) return;
  const c = cfg.customCode || {};
  el.innerHTML = `
    <p style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--space-3);">
      Siteye özel CSS kuralları ekleyin. Tüm sayfalarda uygulanır.
      <strong style="color:var(--accent-warning);">Sadece CSS yazın</strong> — script, event ve URL import'ları güvenlik nedeniyle engellenir.
    </p>

    <div class="form-group">
      <label class="form-label">
        Özel CSS
        <span id="css-validation-msg" style="margin-left:8px;font-size:10px;font-weight:400;"></span>
      </label>
      <div style="position:relative;">
        <textarea id="cfg-custom-css" class="form-control" rows="14"
          style="font-family:'Courier New',monospace;font-size:0.8rem;line-height:1.6;resize:vertical;"
          placeholder="/* Örnek: buton renklerini değiştir */\n.btn-primary {\n  background: #7c3aed;\n  border-color: #7c3aed;\n}"
          oninput="validateCustomCss(this)">${esc(c.headCSS||"")}</textarea>
        <div style="position:absolute;bottom:8px;right:10px;font-size:10px;color:var(--text-muted);" id="css-char-count">
          ${(c.headCSS||"").length} karakter
        </div>
      </div>
    </div>

    <div style="background:var(--bg-surface-2);border-radius:var(--border-radius);padding:var(--space-3);margin-bottom:var(--space-4);font-size:var(--text-xs);color:var(--text-muted);">
      <strong>💡 Örnekler:</strong><br>
      <code style="display:block;margin-top:4px;">:root { --accent-primary: #7c3aed; }</code> — Ana rengi değiştir<br>
      <code style="display:block;margin-top:2px;">.hero { background: linear-gradient(135deg, #1e1b4b, #3730a3); }</code> — Hero arka planı<br>
      <code style="display:block;margin-top:2px;">.card { border-radius: 16px; }</code> — Kart köşelerini yuvarlat
    </div>

    <div style="display:flex;gap:var(--space-3);">
      <button class="btn btn-primary" style="flex:1;" onclick="saveCustomCode()">💾 CSS Kaydet</button>
      <button class="btn btn-ghost btn-sm" onclick="if(confirm('Özel CSS silinsin mi?')){document.getElementById('cfg-custom-css').value='';saveCustomCode();}">🗑️ Temizle</button>
    </div>`;
}

window.validateCustomCss = function(textarea) {
  const msg   = document.getElementById("css-validation-msg");
  const count = document.getElementById("css-char-count");
  const val   = textarea.value;
  if (count) count.textContent = val.length + " karakter";

  // Tehlikeli pattern'ler
  const dangers = [
    { re: /<script/i,            label: "script etiketi" },
    { re: /javascript\s*:/i,     label: "javascript: protokolü" },
    { re: /expression\s*\(/i,    label: "CSS expression()" },
    { re: /url\s*\(\s*data:/i,   label: "data: URL" },
    { re: /@import/i,            label: "@import kuralı" },
    { re: /behavior\s*:/i,       label: "behavior özelliği" },
  ];
  const found = dangers.find(d => d.re.test(val));
  if (msg) {
    if (found) {
      msg.textContent = `⛔ Engellendi: ${found.label}`;
      msg.style.color = "var(--accent-danger)";
      textarea.style.borderColor = "var(--accent-danger)";
    } else {
      msg.textContent = val.length > 0 ? "✅ Geçerli" : "";
      msg.style.color = "var(--accent-success)";
      textarea.style.borderColor = "";
    }
  }
};

window.saveCustomCode = async function() {
  const cssVal = document.getElementById("cfg-custom-css")?.value || "";

  // Güvenlik kontrolü — tehlikeli içerik varsa kaydetme
  const dangers = [/<script/i, /javascript\s*:/i, /expression\s*\(/i, /url\s*\(\s*data:/i, /@import/i, /behavior\s*:/i];
  if (dangers.some(re => re.test(cssVal))) {
    showToast("Güvenli olmayan CSS engellendi. Lütfen düzeltin.", "error");
    return;
  }

  const ok = await saveSection({ customCode: { headCSS: cssVal.trim() || null } });
  if (ok) { await loadConfig(); renderCustomCode(); }
};

// ══════════════════════════════════════════════
// YARDIMCI
// ══════════════════════════════════════════════
function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
