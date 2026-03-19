/**
 * seo-injector.js — Dinamik SEO Meta Etiketi & Schema.org Enjeksiyonu
 * Firestore'dan site_config/main okur, <head>'e yazar.
 *
 * KULLANIM (her HTML sayfasında):
 *   import { injectSEO } from "./js/seo-injector.js";
 *   injectSEO({ title: "Sayfa Başlığı", description: "Açıklama" });
 *
 * GOOGLEBOT NOTU:
 *   Googlebot JS'i render eder ama 2-7 gün sonra indexler.
 *   Bu yüzden her HTML dosyasında statik fallback meta tagları bırakıyoruz.
 *   Bu fonksiyon onları override eder — hem bot hem kullanıcı için en optimize yol budur.
 */

import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const SITE_URL  = "https://ozisg.com";
const CACHE_KEY = "ozisg_seo_cfg";
const CACHE_TTL = 5 * 60 * 1000; // 5 dakika

// ── Yardımcı: meta etiketi yaz ─────────────────────────────
function setMeta(attr, attrVal, content) {
  if (!content) return;
  let el = document.querySelector(`meta[${attr}="${attrVal}"]`);
  if (!el) { el = document.createElement("meta"); el.setAttribute(attr, attrVal); document.head.appendChild(el); }
  el.setAttribute("content", content);
}

// ── Yardımcı: link etiketi yaz ─────────────────────────────
function setLink(rel, href) {
  if (!href) return;
  let el = document.querySelector(`link[rel="${rel}"]`);
  if (!el) { el = document.createElement("link"); el.setAttribute("rel", rel); document.head.appendChild(el); }
  el.setAttribute("href", href);
}

// ── Yardımcı: JSON-LD script enjekte et ────────────────────
function injectJsonLd(schema) {
  const old = document.getElementById("ozisg-schema");
  if (old) old.remove();
  const s = document.createElement("script");
  s.id   = "ozisg-schema";
  s.type = "application/ld+json";
  s.textContent = JSON.stringify(schema, null, 2);
  document.head.appendChild(s);
}

// ── Config yükle (localStorage cache ile) ──────────────────
async function loadSeoConfig() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  } catch (_) {}

  try {
    const snap = await getDoc(doc(db, "site_config", "main"));
    const data = snap.exists() ? snap.data() : {};
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
    return data;
  } catch (err) {
    console.warn("[seo-injector] Config yüklenemedi:", err.message);
    return {};
  }
}

// ══════════════════════════════════════════════════════════════
// ANA FONKSİYON — her sayfadan çağrılır
// ══════════════════════════════════════════════════════════════
export async function injectSEO(pageConfig = {}) {
  const cfg      = await loadSeoConfig();
  const seo      = cfg.seo      || {};
  const footer   = cfg.footer   || {};
  const siteName = cfg.siteName || "ozisg.com";
  const pathname = window.location.pathname;
  const isHome   = pathname === "/" || pathname.endsWith("index.html") || pathname.endsWith("/");

  // ── Sayfa Başlığı ──────────────────────────────────────────
  const pageTitle = pageConfig.title
    ? `${pageConfig.title} — ${siteName}`
    : (seo.defaultTitle || `${siteName} — İSG Araçları & Dijital Çözümler`);
  document.title = pageTitle;

  // ── Temel Meta ─────────────────────────────────────────────
  const desc = pageConfig.description || seo.defaultDescription || "";
  setMeta("name", "description",        desc);
  setMeta("name", "author",             seo.author   || "Oğuzhan Çetin");
  setMeta("name", "keywords",           seo.keywords || "ISG, iş güvenliği, RPA, dijital araçlar");
  setMeta("name", "robots",             "index, follow");
  setMeta("name", "theme-color",        cfg.theme?.primaryColor || "#2563eb");

  // ── Favicon ────────────────────────────────────────────────
  if (cfg.faviconUrl) setLink("icon", cfg.faviconUrl);

  // ── Canonical URL ──────────────────────────────────────────
  const canonical = SITE_URL + (isHome ? "/" : pathname);
  setLink("canonical", canonical);

  // ── Open Graph ─────────────────────────────────────────────
  const ogImage = pageConfig.ogImage || seo.defaultOgImage || `${SITE_URL}/og-image.png`;
  setMeta("property", "og:type",        pageConfig.ogType || "website");
  setMeta("property", "og:title",       pageTitle);
  setMeta("property", "og:description", desc);
  setMeta("property", "og:image",       ogImage);
  setMeta("property", "og:url",         canonical);
  setMeta("property", "og:site_name",   siteName);
  setMeta("property", "og:locale",      "tr_TR");

  // ── Twitter Card ───────────────────────────────────────────
  setMeta("name", "twitter:card",        "summary_large_image");
  setMeta("name", "twitter:title",       pageTitle);
  setMeta("name", "twitter:description", desc);
  setMeta("name", "twitter:image",       ogImage);
  if (seo.twitterHandle) setMeta("name", "twitter:site", seo.twitterHandle);

  // ── Google Analytics ───────────────────────────────────────
  if (seo.googleAnalyticsId && !document.getElementById("ga-script")) {
    const s = document.createElement("script");
    s.id    = "ga-script"; s.async = true;
    s.src   = `https://www.googletagmanager.com/gtag/js?id=${seo.googleAnalyticsId}`;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function() { window.dataLayer.push(arguments); };
    gtag("js", new Date()); gtag("config", seo.googleAnalyticsId);
  }

  // ── GTM ────────────────────────────────────────────────────
  if (seo.gtmId && !document.getElementById("gtm-script")) {
    const s = document.createElement("script"); s.id = "gtm-script";
    s.textContent = `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${seo.gtmId}');`;
    document.head.appendChild(s);
  }

  // ── JSON-LD Schema ─────────────────────────────────────────
  const schema = isHome
    ? buildHomeSchema(cfg, seo, footer, siteName)
    : buildPageSchema(pageTitle, desc, ogImage, canonical);
  injectJsonLd(schema);
}

// ══════════════════════════════════════════════════════════════
// SCHEMA BUILDER — Ana Sayfa (WebSite + Organization + SoftwareApp)
// ══════════════════════════════════════════════════════════════
function buildHomeSchema(cfg, seo, footer, siteName) {
  const sameAs = [
    seo.linkedinUrl, seo.twitterUrl, seo.githubUrl, seo.instagramUrl
  ].filter(Boolean);

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        "url": SITE_URL,
        "name": siteName,
        "description": seo.defaultDescription || "",
        "inLanguage": "tr",
        "publisher": { "@id": `${SITE_URL}/#organization` },
        "potentialAction": {
          "@type": "SearchAction",
          "target": { "@type": "EntryPoint", "urlTemplate": `${SITE_URL}/blog.html?q={search_term_string}` },
          "query-input": "required name=search_term_string"
        }
      },
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        "name": siteName,
        "url": SITE_URL,
        "logo": {
          "@type": "ImageObject",
          "url": cfg.logoImageUrl || `${SITE_URL}/og-image.png`,
          "width": 200, "height": 60
        },
        "founder": {
          "@type": "Person",
          "name": seo.author || "Oğuzhan Çetin",
          "jobTitle": "İSG Uzmanı & Yazılım Geliştirici"
        },
        ...(sameAs.length ? { "sameAs": sameAs } : {}),
        ...(footer.email ? { "email": footer.email } : {})
      },
      {
        "@type": "SoftwareApplication",
        "name": `İSG Araçları Platformu — ${siteName}`,
        "applicationCategory": "BusinessApplication",
        "operatingSystem": "Web Browser",
        "url": SITE_URL,
        "inLanguage": "tr",
        "description": seo.defaultDescription || "",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "TRY" },
        "author": { "@id": `${SITE_URL}/#organization` }
      }
    ]
  };
}

// ══════════════════════════════════════════════════════════════
// SCHEMA BUILDER — İç Sayfalar (WebPage)
// ══════════════════════════════════════════════════════════════
function buildPageSchema(title, description, image, url) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "url": url,
    "name": title,
    "description": description,
    "image": image,
    "inLanguage": "tr",
    "isPartOf": { "@id": `${SITE_URL}/#website` },
    "publisher": { "@id": `${SITE_URL}/#organization` }
  };
}

// ══════════════════════════════════════════════════════════════
// Blog Yazısı için özel schema (blog-post.html'den çağrılır)
// ══════════════════════════════════════════════════════════════
export function injectArticleSchema({ title, description, image, url, datePublished, dateModified, authorName }) {
  injectJsonLd({
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": title,
    "description": description,
    "image": image || `${SITE_URL}/og-image.png`,
    "url": url || window.location.href,
    "datePublished": datePublished || "",
    "dateModified":  dateModified  || datePublished || "",
    "inLanguage": "tr",
    "author": {
      "@type": "Person",
      "name": authorName || "Oğuzhan Çetin",
      "url": SITE_URL
    },
    "publisher": { "@id": `${SITE_URL}/#organization` },
    "isPartOf": { "@id": `${SITE_URL}/#website` }
  });
}
