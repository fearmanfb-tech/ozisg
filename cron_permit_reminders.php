<?php
/**
 * cron_permit_reminders.php
 * ─────────────────────────────────────────────────────────────────────
 * İş İzni (Permit-to-Work) süresi yaklaşan/dolan "Aktif" izinler için
 * otomatik hatırlatma e-postası gönderen PERİYODİK görev. Dünyadaki PTW
 * sistemlerinde standart olan "izin süresi dolmadan uyar" davranışının
 * bu projedeki karşılığıdır — İş İzni aracının kendisi bir arka plan
 * süreci ÇALIŞTIRAMAZ (statik bir web sayfasıdır), bu yüzden bu script
 * cPanel'de bir CRON JOB olarak PERİYODİK (ör. her 30 dakikada bir)
 * çalıştırılmalıdır.
 *
 * KURULUM (cPanel → Cron Jobs) — "Her 30 dakikada bir" sıklığını seçip:
 *   Tercih 1 (CLI, önerilen):
 *     php /home/KULLANICI/public_html/cron_permit_reminders.php
 *   Tercih 2 (URL bazlı, host CLI cron desteklemiyorsa):
 *     wget -q -O /dev/null "https://ozisg.com/cron_permit_reminders.php?token=CONFIG_CRON_SECRET"
 *   (CLI çalıştırmada token gerekmez — php_sapi_name() 'cli' ise otomatik
 *   izin verilir. URL bazlı çalıştırmada config.php'deki CRON_SECRET
 *   ZORUNLUDUR, aksi halde bu uç nokta herkes tarafından tetiklenebilir.)
 *
 * MANTIK: Her izin dokümanının 'reminderSent' alanı, o izin için hatırlatma
 * gönderilip gönderilmediğini işaretler. is-izni.js'deki saveEntry() /
 * saveWeeklyStatus() HER kayıt işleminde bu bayrağı false'a sıfırlar
 * (kullanıcı izni yeniden gözden geçirdi sayılır) — böylece süre uzatılırsa
 * veya not eklenirse hatırlatma tekrar gönderilebilir hale gelir.
 * ─────────────────────────────────────────────────────────────────────
 */

// URL üzerinden çalıştırılırsa (CLI değilse) JSON döndür; CLI'de düz metin loglanır.
$isCli = (php_sapi_name() === 'cli');
if (!$isCli) header('Content-Type: application/json; charset=utf-8');
error_reporting(0);

require_once __DIR__ . '/firestore-admin.php';
require_once __DIR__ . '/lib/send_mail.php';

const PERMIT_PROJECT_ID    = 'ozisg-62bc0';
const PERMIT_COLLECTION    = 'tool_work_permits';
const PERMIT_SETTINGS_COL  = 'tool_work_permits_settings';
const REMINDER_HOURS_AHEAD = 24; // Bitişe bu kadar saat veya daha az kaldıysa (ya da zaten geçtiyse) hatırlat.

date_default_timezone_set('Europe/Istanbul'); // datetime-local alanları tarayıcıda yerel saat olarak girilir.

function respond($isCli, array $data): void
{
    if ($isCli) {
        echo ($data['ok'] ? '[OK] ' : '[HATA] ') . ($data['message'] ?? '') . PHP_EOL;
        if (isset($data['sent'])) echo "Gönderilen hatırlatma: {$data['sent']}" . PHP_EOL;
    } else {
        echo json_encode($data, JSON_UNESCAPED_UNICODE);
    }
    exit;
}

// ── Yetki kontrolü: CLI'den serbest, URL'den sadece doğru token ile ──────
if (!$isCli) {
    $appConfig = require __DIR__ . '/config.php';
    $expected = $appConfig['CRON_SECRET'] ?? '';
    $given = $_GET['token'] ?? '';
    if ($expected === '' || !hash_equals($expected, (string)$given)) {
        http_response_code(403);
        respond($isCli, ['ok' => false, 'message' => 'Yetkisiz erişim.']);
    }
}

try {
    $permits = firestoreAdminListDocuments(PERMIT_PROJECT_ID, PERMIT_COLLECTION);
} catch (Throwable $e) {
    error_log('[cron_permit_reminders] Firestore okunamadı: ' . $e->getMessage());
    respond($isCli, ['ok' => false, 'message' => 'Firestore okunamadı: ' . $e->getMessage()]);
}

$now = new DateTime();
$threshold = (clone $now)->modify('+' . REMINDER_HOURS_AHEAD . ' hours');
$settingsCache = []; // userId => settings (aynı kullanıcı için tekrar okumayı önler)
$sentCount = 0;
$errors = [];

foreach ($permits as $p) {
    $durum = $p['durum'] ?? '';
    $isAktif = ($durum === 'Aktif' || $durum === 'Devam Ediyor'); // eski kayıtlarla geriye dönük uyumluluk
    if (!$isAktif) continue;
    if (!empty($p['reminderSent'])) continue;
    if (empty($p['gecerlilikBitis'])) continue;

    try {
        $bitis = new DateTime($p['gecerlilikBitis']);
    } catch (Throwable $e) {
        continue; // Ayrıştırılamayan tarih — atla.
    }
    if ($bitis > $threshold) continue; // Henüz erken.

    $userId = $p['userId'] ?? null;
    if (!$userId) continue;

    if (!array_key_exists($userId, $settingsCache)) {
        try {
            $settingsCache[$userId] = firestoreAdminGetDocument(PERMIT_PROJECT_ID, PERMIT_SETTINGS_COL, $userId);
        } catch (Throwable $e) {
            $settingsCache[$userId] = null;
        }
    }
    $settings = $settingsCache[$userId];
    $recipients = is_array($settings['mailRecipients'] ?? null) ? $settings['mailRecipients'] : [];
    if (empty($recipients)) continue; // Bu kullanıcı mail dağıtım listesi tanımlamamış.

    $isExpired = $bitis < $now;
    $subject = ($isExpired ? '⚠️ Süresi Dolan İş İzni' : '⏰ Süresi Yaklaşan İş İzni') . ' — ' . ($p['permitNo'] ?? '');
    $html = buildReminderMailHtml($p, $isExpired, $settings);

    $result = sendAppMail($recipients, $subject, $html);
    if ($result['ok']) {
        $sentCount++;
        try {
            firestoreAdminUpdateDocument(PERMIT_PROJECT_ID, PERMIT_COLLECTION, $p['id'], [
                'reminderSent'   => true,
                'reminderSentAt' => (new DateTime())->format(DATE_ATOM),
            ]);
        } catch (Throwable $e) {
            $errors[] = "Bayrak güncellenemedi ({$p['id']}): " . $e->getMessage();
        }
    } else {
        $errors[] = "Mail gönderilemedi ({$p['permitNo']}): " . $result['error'];
    }
}

function buildReminderMailHtml(array $p, bool $isExpired, ?array $settings): string
{
    $esc = fn($s) => htmlspecialchars((string)($s ?? ''), ENT_QUOTES, 'UTF-8');
    $brandSubtitle = !empty($settings['companyName']) ? $esc($settings['companyName']) : 'İş İzni Takip Sistemi';
    $statusLine = $isExpired
        ? '<span style="color:#dc2626;font-weight:bold;">⚠️ Bu iznin geçerlilik süresi DOLDU ama hâlâ Aktif görünüyor — kapatın veya süresini uzatın.</span>'
        : '<span style="color:#d97706;font-weight:bold;">⏰ Bu iznin geçerlilik süresi ' . REMINDER_HOURS_AHEAD . ' saat içinde dolacak.</span>';

    return '
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#1e293b;max-width:800px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;width:100%;">
        <tbody>
          <tr>
            <td style="background:#234383;padding:24px 30px;">
              <div style="font-size:20px;font-weight:bold;color:#fff;">🔖 İŞ İZNİ HATIRLATMA — ' . $esc($p['permitNo'] ?? '') . '</div>
              <div style="font-size:13px;color:#cbd5e1;margin-top:6px;">' . $brandSubtitle . '</div>
            </td>
          </tr>
          <tr><td style="height:4px;background:#ea580c;line-height:4px;font-size:4px;">&nbsp;</td></tr>
          <tr>
            <td style="padding:30px;">
              <div style="margin-bottom:20px;">' . $statusLine . '</div>
              <table width="100%" cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#e2e8f0;">
                <tbody>
                  <tr style="background:#fff;">
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">Firma</td>
                    <td style="color:#1e293b;font-weight:bold;">' . $esc($p['firma'] ?? '—') . '</td>
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">Sorumlu</td>
                    <td style="color:#1e293b;">' . $esc($p['sorumlu'] ?? '—') . '</td>
                  </tr>
                  <tr style="background:#f8fafc;">
                    <td style="color:#64748b;font-size:10px;text-transform:uppercase;">Geçerlilik Bitişi</td>
                    <td colspan="3" style="color:#1e293b;font-weight:bold;">' . $esc(!empty($p['gecerlilikBitis']) ? (new DateTime($p['gecerlilikBitis']))->format('d.m.Y H:i') : '—') . '</td>
                  </tr>
                </tbody>
              </table>
              <p style="color:#334155;margin-top:20px;">Bu izni İş İzni panelinden açıp durumunu güncelleyin (kapatın, askıya alın veya geçerlilik süresini uzatın).</p>
            </td>
          </tr>
          <tr>
            <td style="background:#234383;padding:16px;text-align:center;font-size:10px;color:#cbd5e1;">
              Bu otomatik hatırlatma ozisg.com İş İzni Takip Sistemi tarafından gönderilmiştir.
            </td>
          </tr>
        </tbody>
      </table>
    </div>';
}

respond($isCli, [
    'ok'      => empty($errors),
    'message' => empty($errors) ? 'Tamamlandı.' : implode(' | ', $errors),
    'sent'    => $sentCount,
]);
