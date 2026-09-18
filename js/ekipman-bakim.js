/**
 * ekipman-bakim.js — Ekipman sistemi ortak bakım/kalibrasyon hesaplayıcısı.
 * ekipman-ayarlar / ekipman-takip / ekipman-detay sayfaları aynı mantığı
 * paylaşsın diye tek yerde tutulur (window.EkipmanBakim).
 *
 * Ekipman dokümanı alanları (Firestore /ekipmanlar/{id}):
 *   bakimPeriyoduGun : number  — 0/boş = periyodik bakım yok
 *   sonBakimTarihi   : "YYYY-MM-DD"
 *   kalibrasyonBitis : "YYYY-MM-DD" — kalibrasyon/periyodik muayene geçerlilik sonu
 */
(function () {
  const GUN_MS = 86400000;

  function parse(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function bugun() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }
  function ymd(d) {
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function trTarih(s) {
    const d = parse(s);
    return d ? d.toLocaleDateString("tr-TR") : "—";
  }
  function siniflandir(kalan, esik) {
    if (kalan < 0) return "gecikti";
    if (kalan <= esik) return "yaklasiyor";
    return "ok";
  }

  function bakim(c, esik) {
    const periyot = Number(c && c.bakimPeriyoduGun) || 0;
    if (!periyot) return { tip: "bakim", durum: "yok" };
    const son = parse(c.sonBakimTarihi);
    if (!son) return { tip: "bakim", durum: "tarihsiz" };
    const due = new Date(son.getFullYear(), son.getMonth(), son.getDate() + periyot);
    const kalan = Math.round((due - bugun()) / GUN_MS);
    return { tip: "bakim", durum: siniflandir(kalan, esik == null ? 14 : esik), tarih: ymd(due), kalan };
  }

  function kalibrasyon(c, esik) {
    const due = parse(c && c.kalibrasyonBitis);
    if (!due) return { tip: "kalibrasyon", durum: "yok" };
    const kalan = Math.round((due - bugun()) / GUN_MS);
    return { tip: "kalibrasyon", durum: siniflandir(kalan, esik == null ? 30 : esik), tarih: ymd(due), kalan };
  }

  const ONCELIK = { gecikti: 3, yaklasiyor: 2, tarihsiz: 1, ok: 0, yok: -1 };

  function ozet(c) {
    const b = bakim(c);
    const k = kalibrasyon(c);
    const enKotu = ONCELIK[b.durum] >= ONCELIK[k.durum] ? b.durum : k.durum;
    return { bakim: b, kalibrasyon: k, enKotu };
  }

  function etiket(x) {
    const ad = x.tip === "bakim" ? "Bakım" : "Kalibrasyon";
    if (x.durum === "yok") return "—";
    if (x.durum === "tarihsiz") return "Son bakım tarihi girilmeli";
    if (x.durum === "gecikti") return `${ad} ${Math.abs(x.kalan)} gün gecikti (${trTarih(x.tarih)})`;
    if (x.durum === "yaklasiyor") return `${ad} ${x.kalan === 0 ? "bugün" : x.kalan + " gün sonra"} (${trTarih(x.tarih)})`;
    return `${trTarih(x.tarih)} (${x.kalan} gün)`;
  }

  const RENK = {
    gecikti:    { bg: "#fef2f2", fg: "#b91c1c", border: "#fecaca" },
    yaklasiyor: { bg: "#fffbeb", fg: "#b45309", border: "#fde68a" },
    tarihsiz:   { bg: "#f1f5f9", fg: "#475569", border: "#e2e8f0" },
    ok:         { bg: "#f0fdf4", fg: "#15803d", border: "#bbf7d0" },
    yok:        { bg: "#f8fafc", fg: "#94a3b8", border: "#e2e8f0" },
  };

  window.EkipmanBakim = { bakim, kalibrasyon, ozet, etiket, trTarih, bugunYmd: () => ymd(bugun()), RENK };
})();
