<?php
/**
 * cron_equipment_reminders.php
 * ─────────────────────────────────────────────────────────────────────
 * Ekipman bakım / kalibrasyon hatırlatma görevi. /ekipmanlar dokümanlarındaki
 * bakimPeriyoduGun + sonBakimTarihi (sonraki bakım = son + periyot) ve
 * kalibrasyonBitis alanlarına bakar; bitişine 7 gün veya daha az kalan (ya da
 * geçmiş) kalemleri TEK bir özet e-postada settings_ekipman/config.mailAlicilari
 * listesine gönderir.
 *
 * TEKRAR GÖNDERİMİ ÖNLEME: Mail başarıyla gittikten sonra ilgili ekipman
 * dokümanına hatirlatmaBakim / hatirlatmaKalibrasyon alanına O VADE TARİHİ
 * yazılır. Aynı vade için tekrar mail atılmaz; bakım işlenip vade değişince
 * (sonBakimTarihi ilerler) yeni vade için otomatik yeniden hatırlatılır.
 *
 * KURULUM (cPanel → Cron Jobs) — günde bir kez yeterli (ör. her sabah 08:00):
 *   CLI:  php /home/KULLANICI/public_html/cron_equipment_reminders.php
 *   URL:  wget -q -O /dev/null "https://ozisg.com/cron_equipment_reminders.php?token=CONFIG_CRON_SECRET"
 * (CLI'de token gerekmez; URL'de config.php'deki CRON_SECRET zorunludur.)
 * SMTP ayarları config.php'dedir (bkz. lib/send_mail.php).
 * ─────────────────────────────────────────────────────────────────────
 */

$isCli = (php_sapi_name() === 'cli');
if (!$isCli) header('Content-Type: application/json; charset=utf-8');
error_reporting(0);

require_once __DIR__ . '/firestore-admin.php';
require_once __DIR__ . '/lib/send_mail.php';

const EKP_PROJECT_ID   = 'ozisg-62bc0';
const EKP_ESIK_GUN     = 7;

date_default_timezone_set('Europe/Istanbul');

function ekpRespond(bool $isCli, array $data): void
{
    if ($isCli) {
        echo ($data['ok'] ? '[OK] ' : '[HATA] ') . ($data['message'] ?? '') . PHP_EOL;
        if (isset($data['sent'])) echo "Hatırlatılan kalem: {$data['sent']}" . PHP_EOL;
    } else {
        echo json_encode($data, JSON_UNESCAPED_UNICODE);
    }
    exit;
}

if (!$isCli) {
    $appConfig = require __DIR__ . '/config.php';
    $expected = $appConfig['CRON_SECRET'] ?? '';
    if ($expected === '' || !hash_equals($expected, (string)($_GET['token'] ?? ''))) {
        http_response_code(403);
        ekpRespond($isCli, ['ok' => false, 'message' => 'Yetkisiz erişim.']);
    }
}

function ekpDue(?string $ymd, int $plusDays = 0): ?DateTime
{
    if (!$ymd || !preg_match('/^\d{4}-\d{2}-\d{2}/', $ymd)) return null;
    $d = DateTime::createFromFormat('Y-m-d', substr($ymd, 0, 10));
    if (!$d) return null;
    $d->setTime(0, 0, 0);
    if ($plusDays) $d->modify("+{$plusDays} days");
    return $d;
}

try {
    $cfg = firestoreAdminGetDocument(EKP_PROJECT_ID, 'settings_ekipman', 'config') ?? [];
    $alicilar = is_array($cfg['mailAlicilari'] ?? null) ? $cfg['mailAlicilari'] : [];
    if (empty($alicilar)) {
        ekpRespond($isCli, ['ok' => true, 'message' => 'Mail alıcısı tanımlı değil (Ayarlar › Bakım & Atama).', 'sent' => 0]);
    }
    $ekipmanlar = firestoreAdminListDocuments(EKP_PROJECT_ID, 'ekipmanlar');
} catch (Throwable $e) {
    error_log('[cron_equipment_reminders] ' . $e->getMessage());
    ekpRespond($isCli, ['ok' => false, 'message' => 'Firestore okunamadı: ' . $e->getMessage()]);
}

$bugun = new DateTime('today');
$esik  = (clone $bugun)->modify('+' . EKP_ESIK_GUN . ' days');
$bekleyen = []; // ['ekipman'=>..., 'tip'=>'bakim'|'kalibrasyon', 'vade'=>DateTime, 'alan'=>flag alanı]

foreach ($ekipmanlar as $e) {
    $periyot = (int)($e['bakimPeriyoduGun'] ?? 0);
    $adaylar = [];
    if ($periyot > 0) {
        $vade = ekpDue($e['sonBakimTarihi'] ?? null, $periyot);
        if ($vade) $adaylar[] = ['bakim', $vade, 'hatirlatmaBakim'];
    }
    $kal = ekpDue($e['kalibrasyonBitis'] ?? null);
    if ($kal) $adaylar[] = ['kalibrasyon', $kal, 'hatirlatmaKalibrasyon'];

    foreach ($adaylar as [$tip, $vade, $alan]) {
        if ($vade > $esik) continue;
        if (($e[$alan] ?? '') === $vade->format('Y-m-d')) continue; // bu vade için zaten hatırlatıldı
        $bekleyen[] = ['ekipman' => $e, 'tip' => $tip, 'vade' => $vade, 'alan' => $alan];
    }
}

if (empty($bekleyen)) {
    ekpRespond($isCli, ['ok' => true, 'message' => 'Hatırlatılacak kalem yok.', 'sent' => 0]);
}

usort($bekleyen, function ($a, $b) { return $a['vade'] <=> $b['vade']; });

$esc = function ($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); };
$satirlar = '';
foreach ($bekleyen as $b) {
    $kalan = (int)$bugun->diff($b['vade'])->format('%r%a');
    $durum = $kalan < 0 ? '<span style="color:#b91c1c;font-weight:bold;">' . abs($kalan) . ' gün gecikti</span>'
           : ($kalan === 0 ? '<span style="color:#b45309;font-weight:bold;">Bugün</span>'
                           : '<span style="color:#b45309;">' . $kalan . ' gün kaldı</span>');
    $satirlar .= '<tr>'
        . '<td style="padding:8px;border:1px solid #e2e8f0;font-family:monospace;font-weight:bold;">' . $esc($b['ekipman']['id']) . '</td>'
        . '<td style="padding:8px;border:1px solid #e2e8f0;">' . $esc($b['ekipman']['adi'] ?? '') . '</td>'
        . '<td style="padding:8px;border:1px solid #e2e8f0;">' . ($b['tip'] === 'bakim' ? 'Periyodik bakım' : 'Kalibrasyon / muayene') . '</td>'
        . '<td style="padding:8px;border:1px solid #e2e8f0;">' . $b['vade']->format('d.m.Y') . '</td>'
        . '<td style="padding:8px;border:1px solid #e2e8f0;">' . $durum . '</td>'
        . '</tr>';
}

$html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#1e293b;max-width:800px;">'
    . '<div style="background:#234383;padding:20px 24px;color:#fff;font-size:18px;font-weight:bold;">🔧 Ekipman Bakım / Kalibrasyon Hatırlatma</div>'
    . '<div style="height:4px;background:#ea580c;"></div>'
    . '<div style="padding:24px;">'
    . '<p>Aşağıdaki ekipmanların bakım veya kalibrasyon vadesi ' . EKP_ESIK_GUN . ' gün içinde doluyor ya da geçmiş durumda:</p>'
    . '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:10pt;">'
    . '<thead><tr style="background:#f1f5f9;">'
    . '<th align="left" style="padding:8px;border:1px solid #e2e8f0;">ID</th><th align="left" style="padding:8px;border:1px solid #e2e8f0;">Ekipman</th>'
    . '<th align="left" style="padding:8px;border:1px solid #e2e8f0;">Kalem</th><th align="left" style="padding:8px;border:1px solid #e2e8f0;">Vade</th>'
    . '<th align="left" style="padding:8px;border:1px solid #e2e8f0;">Durum</th></tr></thead>'
    . '<tbody>' . $satirlar . '</tbody></table>'
    . '<p style="margin-top:20px;color:#64748b;font-size:10pt;">Bakım yapıldığında Ekipmanlar sayfasından "Bakım Yapıldı" ile işleyin; bir sonraki vade otomatik hesaplanır.</p>'
    . '</div>'
    . '<div style="background:#234383;padding:12px;text-align:center;font-size:10px;color:#cbd5e1;">Bu otomatik hatırlatma ozisg.com Ekipman Takip Sistemi tarafından gönderilmiştir.</div>'
    . '</div>';

$sonuc = sendAppMail($alicilar, 'Ekipman Bakım/Kalibrasyon Hatırlatma — ' . count($bekleyen) . ' kalem', $html);
if (!$sonuc['ok']) {
    error_log('[cron_equipment_reminders] mail: ' . $sonuc['error']);
    ekpRespond($isCli, ['ok' => false, 'message' => 'Mail gönderilemedi: ' . $sonuc['error'], 'sent' => 0]);
}

$hatalar = [];
foreach ($bekleyen as $b) {
    try {
        firestoreAdminUpdateDocument(EKP_PROJECT_ID, 'ekipmanlar', $b['ekipman']['id'], [
            $b['alan'] => $b['vade']->format('Y-m-d'),
        ]);
    } catch (Throwable $e) {
        $hatalar[] = $b['ekipman']['id'] . ': ' . $e->getMessage();
    }
}

ekpRespond($isCli, [
    'ok'      => empty($hatalar),
    'message' => empty($hatalar) ? 'Tamamlandı.' : 'Mail gitti ama bayrak yazılamadı (tekrar mail gidebilir): ' . implode(' | ', $hatalar),
    'sent'    => count($bekleyen),
]);
