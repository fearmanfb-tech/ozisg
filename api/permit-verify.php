<?php
/**
 * api/permit-verify.php
 * ─────────────────────────────────────────────────────────────────────
 * PUBLİK (kimlik doğrulaması gerektirmeyen) salt-okunur iş izni doğrulama
 * uç noktası. Sahaya QR kod olarak basılan bir iznin, telefonla okutulduğunda
 * hâlâ geçerli olup olmadığının kontrol edilebilmesi için vardır — dünyadaki
 * Permit-to-Work sistemlerinin standart bir parçasıdır (saha denetçisi QR'ı
 * okutur, izin canlı durumunu görür).
 *
 * GET ?no=IP-YYYYMMDD-XXXX  →  { status, found, permit: {...} }
 *
 * GÜVENLİK: Bilinçli olarak sadece MİNİMAL, hassas olmayan alanlar
 * döndürülür (userId, görsel URL'i, proje/blok/kat/alan/depo detayları,
 * kapanış notu DÖNDÜRÜLMEZ). firestore-admin.php üzerinden servis hesabıyla
 * okunur — Security Rules bu uç nokta için hiç devrede değildir, bu yüzden
 * IP bazlı hız sınırlama uygulanmıştır (diğer public/proxy uç noktalarıyla
 * tutarlı bir desen).
 * ─────────────────────────────────────────────────────────────────────
 */

header('Content-Type: application/json; charset=utf-8');
error_reporting(0);

require_once __DIR__ . '/../firestore-admin.php';

const PERMIT_VERIFY_PROJECT_ID = 'ozisg-62bc0';
const PERMIT_VERIFY_COLLECTION = 'tool_work_permits';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    http_response_code(405);
    echo json_encode(['status' => 'error', 'message' => 'Yalnızca GET istekleri kabul edilir.']);
    exit;
}

// ── GÜVENLİK: IP Bazlı Rate Limiting (1 dakikada maks 30 sorgu) ──────────
$ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
$cacheFile = sys_get_temp_dir() . '/rate_limit_permitverify_' . md5($ip) . '.json';
$now = time();
$limit = 30;
$window = 60;

if (file_exists($cacheFile)) {
    $rateData = json_decode(@file_get_contents($cacheFile), true);
    if (is_array($rateData) && isset($rateData['start_time'], $rateData['count']) && ($now - $rateData['start_time']) < $window) {
        if ($rateData['count'] >= $limit) {
            http_response_code(429);
            header('Retry-After: ' . ($window - ($now - $rateData['start_time'])));
            echo json_encode(['status' => 'error', 'message' => 'Çok fazla istek. Lütfen biraz bekleyin.']);
            exit;
        }
        $rateData['count']++;
    } else {
        $rateData = ['count' => 1, 'start_time' => $now];
    }
} else {
    $rateData = ['count' => 1, 'start_time' => $now];
}
@file_put_contents($cacheFile, json_encode($rateData));

$permitNo = isset($_GET['no']) ? trim((string)$_GET['no']) : '';
if ($permitNo === '' || !preg_match('/^[A-Za-z0-9\-]{1,40}$/', $permitNo)) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'Geçersiz izin numarası.']);
    exit;
}

try {
    $all = firestoreAdminListDocuments(PERMIT_VERIFY_PROJECT_ID, PERMIT_VERIFY_COLLECTION);
} catch (Throwable $e) {
    error_log('[permit-verify] ' . $e->getMessage());
    http_response_code(502);
    echo json_encode(['status' => 'error', 'message' => 'Doğrulama servisi şu anda erişilemiyor.']);
    exit;
}

$match = null;
foreach ($all as $doc) {
    if (($doc['permitNo'] ?? null) === $permitNo) { $match = $doc; break; }
}

if (!$match) {
    echo json_encode(['status' => 'ok', 'found' => false]);
    exit;
}

$checklist = is_array($match['checklist'] ?? null) ? $match['checklist'] : [];
$checklistDone = 0;
foreach ($checklist as $c) { if (!empty($c['checked'])) $checklistDone++; }

echo json_encode([
    'status' => 'ok',
    'found'  => true,
    'permit' => [
        'permitNo'            => $match['permitNo']           ?? '',
        'durum'               => $match['durum']              ?? '',
        'tarih'               => $match['tarih']              ?? '',
        'izinTuru'            => $match['izinTuru']            ?? '',
        'firma'               => $match['firma']              ?? '',
        'sorumlu'             => $match['sorumlu']             ?? '',
        'gecerlilikBaslangic' => $match['gecerlilikBaslangic'] ?? null,
        'gecerlilikBitis'     => $match['gecerlilikBitis']     ?? null,
        'izniVerenAd'         => $match['izniVerenAd']         ?? '',
        'izniVerenOnay'       => !empty($match['izniVerenOnay']),
        'izniAlanAd'          => $match['izniAlanAd']          ?? '',
        'izinAlanOnay'        => !empty($match['izinAlanOnay']),
        'checklistTotal'      => count($checklist),
        'checklistDone'       => $checklistDone,
    ],
], JSON_UNESCAPED_UNICODE);
