<?php
// ============================================================
// Vercel Notification Bridge - send.php
// Mengirim Push Notification FCM menggunakan HTTP v1 API Google.
// ============================================================

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Headers: Content-Type");
header("Access-Control-Allow-Methods: POST, GET, OPTIONS");
header("Content-Type: application/json");

// Handle preflight CORS request
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

// Mengambil parameter input
$token = $_REQUEST['token'] ?? null;
$title = $_REQUEST['title'] ?? 'HubunganKita';
$body  = $_REQUEST['body'] ?? '';

if (!$token) {
    echo json_encode([
        'status' => 'error',
        'message' => 'Token FCM tujuan wajib diisi.'
    ]);
    exit;
}

// Membaca kredensial Firebase Service Account dari Environment Variable Vercel
$serviceAccountJson = $_ENV['FIREBASE_SERVICE_ACCOUNT'] ?? $_SERVER['FIREBASE_SERVICE_ACCOUNT'] ?? '';

if (empty($serviceAccountJson)) {
    echo json_encode([
        'status' => 'error',
        'message' => 'Konfigurasi FIREBASE_SERVICE_ACCOUNT tidak ditemukan di Environment Variables.'
    ]);
    exit;
}

// Fungsi untuk membuat Google OAuth2 Access Token menggunakan RS256 JWT
function getGoogleAccessToken($serviceAccountJson) {
    $data = json_decode($serviceAccountJson, true);
    if (!$data || !isset($data['private_key']) || !isset($data['client_email']) || !isset($data['project_id'])) {
        return ['error' => 'Format JSON Service Account tidak valid atau tidak lengkap.'];
    }

    $privateKey = $data['private_key'];
    $clientEmail = $data['client_email'];
    
    // Header JWT
    $header = json_encode(['alg' => 'RS256', 'typ' => 'JWT']);
    
    // Payload JWT (berlaku 1 jam)
    $now = time();
    $payload = json_encode([
        'iss' => $clientEmail,
        'scope' => 'https://www.googleapis.com/auth/firebase.messaging',
        'aud' => 'https://oauth2.googleapis.com/token',
        'exp' => $now + 3600,
        'iat' => $now
    ]);
    
    // Base64URL Encoding
    $base64UrlHeader = str_replace(['+', '/', '='], ['-', '_', ''], base64_encode($header));
    $base64UrlPayload = str_replace(['+', '/', '='], ['-', '_', ''], base64_encode($payload));
    
    // Tanda Tangan JWT menggunakan RS256 (SHA-256 dengan Kunci Privat)
    $signature = '';
    $success = openssl_sign($base64UrlHeader . "." . $base64UrlPayload, $signature, $privateKey, 'SHA256');
    if (!$success) {
        return ['error' => 'Gagal melakukan penandatanganan JWT OpenSSL. Periksa keaslian private key.'];
    }
    
    $base64UrlSignature = str_replace(['+', '/', '='], ['-', '_', ''], base64_encode($signature));
    $jwt = $base64UrlHeader . "." . $base64UrlPayload . "." . $base64UrlSignature;
    
    // Request Token ke Google OAuth2 Endpoint menggunakan cURL
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, 'https://oauth2.googleapis.com/token');
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query([
        'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion' => $jwt
    ]));
    
    $response = curl_exec($ch);
    if (curl_errno($ch)) {
        $error_msg = curl_error($ch);
        curl_close($ch);
        return ['error' => 'cURL Error saat meminta token: ' . $error_msg];
    }
    curl_close($ch);
    
    $resData = json_decode($response, true);
    if (!isset($resData['access_token'])) {
        return ['error' => 'Google OAuth2 Token Response Error: ' . ($resData['error_description'] ?? $response)];
    }
    
    return [
        'access_token' => $resData['access_token'],
        'project_id' => $data['project_id']
    ];
}

// Dapatkan Access Token & Project ID
$credentials = getGoogleAccessToken($serviceAccountJson);
if (isset($credentials['error'])) {
    echo json_encode([
        'status' => 'error',
        'message' => $credentials['error']
    ]);
    exit;
}

$accessToken = $credentials['access_token'];
$projectId   = $credentials['project_id'];

// Susun Payload FCM HTTP v1
$fcmUrl = "https://fcm.googleapis.com/v1/projects/{$projectId}/messages:send";
$fcmPayload = [
    'message' => [
        'token' => $token,
        'notification' => [
            'title' => $title,
            'body' => $body
        ],
        'android' => [
            'priority' => 'high',
            'notification' => [
                'sound' => 'default',
                'channel_id' => 'default'
            ]
        ]
    ]
];

// Kirim ke Firebase Cloud Messaging API
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $fcmUrl);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Authorization: Bearer ' . $accessToken,
    'Content-Type: application/json'
]);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($fcmPayload));

$fcmResponse = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

if (curl_errno($ch)) {
    $error_msg = curl_error($ch);
    curl_close($ch);
    echo json_encode([
        'status' => 'error',
        'message' => 'cURL Error saat mengirim notifikasi FCM: ' . $error_msg
    ]);
    exit;
}
curl_close($ch);

$fcmResData = json_decode($fcmResponse, true);

if ($httpCode === 200) {
    echo json_encode([
        'status' => 'success',
        'message' => 'Notifikasi berhasil dikirim via FCM!',
        'fcm_response' => $fcmResData
    ]);
} else {
    echo json_encode([
        'status' => 'error',
        'message' => 'Firebase API mengembalikan status error (HTTP Code ' . $httpCode . ')',
        'fcm_response' => $fcmResData
    ]);
}
