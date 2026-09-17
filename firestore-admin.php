<?php
/**
 * firestore-admin.php
 * ─────────────────────────────────────────────────────────────────────
 * Firestore'a SUNUCU YETKİSİYLE (Firebase Admin servis hesabı) okuma/yazma
 * yapmak için paylaşılan yardımcı fonksiyonlar.
 *
 * NEDEN GEREKLİ: Client SDK (tarayıcı) her zaman Firestore Security
 * Rules'a tabidir. Ödeme onayı gibi "sadece sunucu doğrulayabilir" işlemler
 * için (iyzico_callback.php'nin sipariş durumunu SUCCESS sonrası
 * güncellemesi gibi) Security Rules'ı BYPASS EDEN, gerçek bir admin
 * kimlik doğrulaması gerekir. Bu dosya, scripts/service-account.json'daki
 * Firebase Admin servis hesabıyla RS256 imzalı bir JWT üretip Google'ın
 * OAuth2 sunucusundan (token_uri) bir access_token alır, ardından bu
 * token'ı Firestore v1 REST API'sine Bearer olarak gönderir.
 *
 * GÜVENLİK: service-account.json'a doğrudan HTTP erişimi scripts/.htaccess
 * ile engellenmiştir — bu dosyanın KENDİSİ sadece include edilmek üzere
 * tasarlanmıştır, doğrudan çağrılmaz (aşağıdaki guard bunu zorunlu kılar).
 * ─────────────────────────────────────────────────────────────────────
 */

if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === basename(__FILE__)) {
    http_response_code(403);
    exit('Bu dosya doğrudan çağrılamaz.');
}

define('FIRESTORE_SERVICE_ACCOUNT_PATH', __DIR__ . '/scripts/service-account.json');

/**
 * Servis hesabı JSON'unu okur ve OAuth2 access_token üretir.
 * Aynı PHP isteği içinde tekrar tekrar çağrılırsa (birden fazla Firestore
 * işlemi gerektiğinde) statik önbellek sayesinde tek bir token/imza
 * üretilir.
 *
 * @throws Exception servis hesabı okunamazsa veya token alınamazsa
 */
function firestoreGetAccessToken(): string
{
    static $cachedToken = null;
    static $cachedExpiry = 0;

    if ($cachedToken !== null && time() < $cachedExpiry - 30) {
        return $cachedToken;
    }

    if (!is_readable(FIRESTORE_SERVICE_ACCOUNT_PATH)) {
        throw new Exception('Servis hesabı dosyası okunamadı: ' . FIRESTORE_SERVICE_ACCOUNT_PATH);
    }
    $sa = json_decode(file_get_contents(FIRESTORE_SERVICE_ACCOUNT_PATH), true);
    if (!$sa || empty($sa['client_email']) || empty($sa['private_key']) || empty($sa['token_uri'])) {
        throw new Exception('Servis hesabı JSON\'u geçersiz veya eksik alanlar içeriyor.');
    }

    $b64url = function ($data) {
        $json = is_string($data) ? $data : json_encode($data, JSON_UNESCAPED_SLASHES);
        return rtrim(strtr(base64_encode($json), '+/', '-_'), '=');
    };

    $now = time();
    $header = ['alg' => 'RS256', 'typ' => 'JWT'];
    $claims = [
        'iss'   => $sa['client_email'],
        'scope' => 'https://www.googleapis.com/auth/datastore',
        'aud'   => $sa['token_uri'],
        'iat'   => $now,
        'exp'   => $now + 3600,
    ];
    $unsigned = $b64url($header) . '.' . $b64url($claims);

    $privateKey = openssl_pkey_get_private($sa['private_key']);
    if ($privateKey === false) {
        throw new Exception('Servis hesabı özel anahtarı okunamadı (openssl_pkey_get_private başarısız).');
    }
    $signOk = openssl_sign($unsigned, $signature, $privateKey, 'sha256WithRSAEncryption');
    if (!$signOk) {
        throw new Exception('JWT imzalanamadı (openssl_sign başarısız).');
    }
    $jwt = $unsigned . '.' . $b64url($signature);

    $ch = curl_init($sa['token_uri']);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => http_build_query([
            'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'assertion'  => $jwt,
        ]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);

    if ($err || $code !== 200) {
        throw new Exception('OAuth2 token alınamadı: ' . ($err ?: "HTTP $code: $resp"));
    }
    $data = json_decode($resp, true);
    if (empty($data['access_token'])) {
        throw new Exception('OAuth2 yanıtında access_token yok: ' . $resp);
    }

    $cachedToken  = $data['access_token'];
    $cachedExpiry = $now + (int)($data['expires_in'] ?? 3600);
    return $cachedToken;
}

/** PHP değerini Firestore'un "Value" wire formatına çevirir. */
function firestoreEncodeValue($v)
{
    if ($v === null) return ['nullValue' => null];
    if (is_bool($v)) return ['booleanValue' => $v];
    if (is_int($v)) return ['integerValue' => (string)$v];
    if (is_float($v)) return ['doubleValue' => $v];
    if (is_array($v)) {
        $isList = array_keys($v) === range(0, count($v) - 1);
        if ($isList) {
            return ['arrayValue' => ['values' => array_map('firestoreEncodeValue', $v)]];
        }
        $fields = [];
        foreach ($v as $k => $vv) $fields[$k] = firestoreEncodeValue($vv);
        return ['mapValue' => ['fields' => $fields]];
    }
    return ['stringValue' => (string)$v];
}

/** Firestore "Value" wire formatını PHP değerine çevirir. */
function firestoreDecodeValue(array $v)
{
    if (array_key_exists('stringValue', $v)) return $v['stringValue'];
    if (array_key_exists('integerValue', $v)) return (int)$v['integerValue'];
    if (array_key_exists('doubleValue', $v)) return (float)$v['doubleValue'];
    if (array_key_exists('booleanValue', $v)) return $v['booleanValue'];
    if (array_key_exists('timestampValue', $v)) return $v['timestampValue'];
    if (array_key_exists('nullValue', $v)) return null;
    if (isset($v['arrayValue'])) {
        return array_map('firestoreDecodeValue', $v['arrayValue']['values'] ?? []);
    }
    if (isset($v['mapValue'])) {
        return firestoreDecodeFields($v['mapValue']['fields'] ?? []);
    }
    return null;
}

/** Firestore doküman "fields" haritasını düz bir PHP assoc dizisine çevirir. */
function firestoreDecodeFields(array $fields): array
{
    $out = [];
    foreach ($fields as $k => $v) $out[$k] = firestoreDecodeValue($v);
    return $out;
}

/**
 * Tek bir dokümanı ADMIN yetkisiyle okur (Security Rules bypass edilir).
 * @return array|null Doküman yoksa null, varsa decode edilmiş alan haritası
 */
function firestoreAdminGetDocument(string $projectId, string $collection, string $docId): ?array
{
    $token = firestoreGetAccessToken();
    $url = "https://firestore.googleapis.com/v1/projects/{$projectId}/databases/(default)/documents/"
         . rawurlencode($collection) . '/' . rawurlencode($docId);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $token],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
    ]);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code === 404) return null;
    if ($code !== 200) throw new Exception("Firestore okuma hatası ($code): $resp");

    $doc = json_decode($resp, true);
    return firestoreDecodeFields($doc['fields'] ?? []);
}

/**
 * Bir dokümanın SADECE verilen alanlarını ADMIN yetkisiyle günceller
 * (updateMask ile kısmi güncelleme — diğer alanlara dokunmaz). Doküman
 * yoksa OLUŞTURULUR (Firestore PATCH'in varsayılan davranışı).
 */
function firestoreAdminUpdateDocument(string $projectId, string $collection, string $docId, array $fields): array
{
    $token = firestoreGetAccessToken();
    $url = "https://firestore.googleapis.com/v1/projects/{$projectId}/databases/(default)/documents/"
         . rawurlencode($collection) . '/' . rawurlencode($docId);

    $maskQuery = [];
    foreach (array_keys($fields) as $f) $maskQuery[] = 'updateMask.fieldPaths=' . rawurlencode($f);
    $url .= '?' . implode('&', $maskQuery);

    $body = ['fields' => []];
    foreach ($fields as $k => $v) $body['fields'][$k] = firestoreEncodeValue($v);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => 'PATCH',
        CURLOPT_POSTFIELDS     => json_encode($body, JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Authorization: Bearer ' . $token],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
    ]);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code < 200 || $code >= 300) {
        throw new Exception("Firestore güncelleme hatası ($code): $resp");
    }
    return json_decode($resp, true);
}

/**
 * Tek bir dokümanı ADMIN yetkisiyle SİLER (Security Rules bypass edilir).
 */
function firestoreAdminDeleteDocument(string $projectId, string $collection, string $docId): void
{
    $token = firestoreGetAccessToken();
    $url = "https://firestore.googleapis.com/v1/projects/{$projectId}/databases/(default)/documents/"
         . rawurlencode($collection) . '/' . rawurlencode($docId);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => 'DELETE',
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $token],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
    ]);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code < 200 || $code >= 300) {
        throw new Exception("Firestore silme hatası ($code): $resp");
    }
}

/**
 * Bir koleksiyondaki TÜM dokümanları ADMIN yetkisiyle okur (sayfalama
 * otomatik yönetilir). Küçük/orta ölçekli koleksiyonlar için tasarlanmıştır
 * (bu projedeki iş izni gibi) — Firestore composite index gerektiren
 * sorgular yerine BİLİNÇLİ olarak "tümünü çek, PHP tarafında filtrele"
 * yaklaşımı tercih edildi: kullanıcının Firebase Console'da elle index
 * oluşturmasını gerektirmez, küçük veri hacminde performans sorunu yaratmaz.
 *
 * @return array<int, array> her biri ['id' => docId, ...alanlar] şeklinde
 */
function firestoreAdminListDocuments(string $projectId, string $collection): array
{
    $token = firestoreGetAccessToken();
    $base = "https://firestore.googleapis.com/v1/projects/{$projectId}/databases/(default)/documents/"
          . rawurlencode($collection);

    $out = [];
    $pageToken = null;
    do {
        $url = $base . '?pageSize=300';
        if ($pageToken) $url .= '&pageToken=' . rawurlencode($pageToken);

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $token],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 20,
        ]);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($code !== 200) throw new Exception("Firestore liste okuma hatası ($code): $resp");
        $data = json_decode($resp, true);

        foreach (($data['documents'] ?? []) as $doc) {
            $parts = explode('/', $doc['name']);
            $id = end($parts);
            $out[] = ['id' => $id] + firestoreDecodeFields($doc['fields'] ?? []);
        }
        $pageToken = $data['nextPageToken'] ?? null;
    } while ($pageToken);

    return $out;
}

/**
 * Servis hesabı → JWT → OAuth2 token → gerçek bir Firestore API çağrısı
 * zincirinin BAŞTAN SONA çalıştığını doğrular. Hiçbir veri YAZMAZ; var
 * olması imkansız bir doküman path'ini OKUMAYA çalışır — beklenen sonuç
 * "doküman yok" (404) yanıtıdır, bu da kimlik doğrulamanın ve Firestore
 * API erişiminin GERÇEKTEN çalıştığını kanıtlar (401/403 değil, 404
 * dönmesi başarı göstergesidir).
 *
 * Her aşamayı ayrı ayrı dener ki hata mesajı NEREDE koptuğunu net söylesin
 * (dosya okunamadı mı, JWT imzalanamadı mı, OAuth2 reddetti mi, yoksa
 * Firestore API'sine erişim mi yok) — "canlıya almadan önce" tek bakışta
 * teşhis edilebilsin diye.
 *
 * @return array ['ok' => bool, 'stage' => string, 'message' => string, 'details' => array]
 */
function firestoreTestConnection(string $projectId): array
{
    $result = ['ok' => false, 'stage' => 'baslamadi', 'message' => '', 'details' => []];

    // ── Aşama 1: servis hesabı dosyası okunabilir ve geçerli mi? ──
    $result['stage'] = 'service_account_dosyasi';
    if (!is_readable(FIRESTORE_SERVICE_ACCOUNT_PATH)) {
        $result['message'] = 'Servis hesabı dosyası okunamıyor: ' . FIRESTORE_SERVICE_ACCOUNT_PATH
            . ' (dosya yok, yol yanlış veya dosya izinleri (chmod) sunucu kullanıcısına okuma hakkı vermiyor olabilir.)';
        error_log('[firestore-admin][test] ' . $result['message']);
        return $result;
    }
    $sa = json_decode(file_get_contents(FIRESTORE_SERVICE_ACCOUNT_PATH), true);
    if (!$sa || empty($sa['client_email']) || empty($sa['private_key']) || empty($sa['token_uri'])) {
        $result['message'] = 'Servis hesabı JSON\'u geçersiz veya eksik alanlar içeriyor (client_email/private_key/token_uri).';
        error_log('[firestore-admin][test] ' . $result['message']);
        return $result;
    }
    $result['details']['client_email'] = $sa['client_email'];

    // ── Aşama 2: JWT imzalanıp Google'dan gerçek bir access_token alınabiliyor mu? ──
    $result['stage'] = 'oauth2_token';
    try {
        $token = firestoreGetAccessToken();
    } catch (Throwable $e) {
        $result['message'] = 'OAuth2 access_token alınamadı: ' . $e->getMessage()
            . ' (olası nedenler: sunucuda openssl/curl PHP eklentileri kapalı olabilir; servis hesabı Google'
            . ' Cloud Console\'da devre dışı bırakılmış/silinmiş olabilir; ya da sunucu saati (date) yanlış'
            . ' olabilir — JWT\'nin iat/exp alanları saat kaymasına çok duyarlıdır.)';
        error_log('[firestore-admin][test] ' . $result['message']);
        return $result;
    }
    $result['details']['token_prefix'] = substr($token, 0, 12) . '…'; // tam token asla loglanmaz/dönmez

    // ── Aşama 3: bu token'la GERÇEK bir Firestore REST API çağrısı yapılabiliyor mu? ──
    $result['stage'] = 'firestore_api_erisimi';
    try {
        // Var olması imkansız bir path — 404 dönmesi (Exception FIRLATILMAMASI) başarı
        // demektir. NOT: Firestore, başında VE sonunda çift alt çizgi olan koleksiyon/
        // doküman adlarını ("__isim__") SİSTEM İÇİN AYRILMIŞ kabul edip 400 ile
        // reddeder — bu yüzden test path'i o desenle ÇAKIŞMAYACAK şekilde seçildi.
        firestoreAdminGetDocument($projectId, 'ozisg_connection_test', 'ping');
    } catch (Throwable $e) {
        $result['message'] = 'Firestore API çağrısı başarısız: ' . $e->getMessage()
            . ' (proje ID yanlış olabilir, ya da bu servis hesabının bu Firebase projesinde Cloud Firestore API izni/rolü olmayabilir — IAM\'de "Cloud Datastore User" veya "Firebase Admin SDK Administrator Service Agent" rolünü kontrol edin.)';
        error_log('[firestore-admin][test] ' . $result['message']);
        return $result;
    }

    $result['ok'] = true;
    $result['stage'] = 'tamamlandi';
    $result['message'] = 'Bağlantı başarılı: servis hesabı doğrulandı, OAuth2 token alındı, Firestore API\'sine gerçek bir istek başarıyla yapıldı.';
    return $result;
}
