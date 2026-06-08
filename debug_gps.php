<?php
// ============================================================
// public/debug_gps.php
// Script Diagnostik GPS & Database Live HubunganKita
// Jalankan di hosting: https://ruangkita.infinityfreeapp.com/public/debug_gps.php
// (Hapus file ini setelah selesai debugging!)
// ============================================================

define('ROOT_PATH', dirname(__DIR__));
define('APP_PATH', ROOT_PATH . '/app');
require_once ROOT_PATH . '/config/app.php';
require_once ROOT_PATH . '/config/database.php';
require_once APP_PATH . '/core/Session.php';

Session::init();

header('Content-Type: text/plain; charset=utf-8');

if (!Session::get('user_id')) {
    die("ERROR: Anda harus login terlebih dahulu. Silakan buka dashboard utama lalu buka halaman ini kembali.");
}

$userId = Session::get('user_id');
$coupleKey = Session::get('couple_key');

echo "=== DIAGNOSTIK GPS & DATABASE LIVE ===\n\n";
echo "Waktu PHP  : " . date('Y-m-d H:i:s') . " (" . date_default_timezone_get() . ")\n";

try {
    $db = Database::getInstance()->getConnection();
    
    // 1. Cek Waktu & Timezone MySQL
    $timeQuery = $db->query("SELECT NOW() as mysql_now, @@global.time_zone as global_tz, @@session.time_zone as session_tz")->fetch();
    echo "Waktu MySQL: {$timeQuery->mysql_now}\n";
    echo "TZ Global  : {$timeQuery->global_tz}\n";
    echo "TZ Sesi    : {$timeQuery->session_tz}\n\n";

    // 2. Cek Struktur Tabel user_locations
    echo "=== Struktur Tabel user_locations ===\n";
    try {
        $cols = $db->query("SHOW COLUMNS FROM `user_locations`")->fetchAll(PDO::FETCH_ASSOC);
        foreach ($cols as $col) {
            echo "  - {$col['Field']} ({$col['Type']}) " . ($col['Null'] === 'NO' ? 'NOT NULL' : 'NULL') . " (Key: {$col['Key']})\n";
        }
    } catch (Exception $e) {
        echo "  Error membaca struktur: " . $e->getMessage() . "\n";
    }
    echo "\n";

    // 3. Ambil data pasangan
    require_once APP_PATH . '/models/User.php';
    $userModel = new User();
    $partner = $userModel->findPartner($userId, $coupleKey);
    
    if (!$partner) {
        die("ERROR: Pasangan tidak ditemukan atau Anda belum terhubung.");
    }
    
    echo "User ID Anda: {$userId}\n";
    echo "User ID Pasangan (B): {$partner->id} ({$partner->username})\n\n";

    // 4. Cek data di user_locations untuk Anda
    echo "=== Data Lokasi Anda (A) di DB ===\n";
    $myLocs = $db->prepare("SELECT * FROM `user_locations` WHERE `user_id` = :user_id");
    $myLocs->execute([':user_id' => $userId]);
    $myLocRows = $myLocs->fetchAll();
    echo "Jumlah baris ditemukan: " . count($myLocRows) . "\n";
    foreach ($myLocRows as $row) {
        $batteryStr = isset($row->battery) ? "Baterai: {$row->battery}%" : "Baterai: N/A";
        $sessStr = isset($row->session_id) ? "Sess: {$row->session_id}" : "Sess: N/A";
        echo "  - Lat: {$row->latitude}, Lon: {$row->longitude}, {$batteryStr}, {$sessStr}, Updated: {$row->updated_at}\n";
    }
    echo "\n";

    // 5. Cek data di user_locations untuk Pasangan
    echo "=== Data Lokasi Pasangan (B) di DB ===\n";
    $partnerLocs = $db->prepare("SELECT * FROM `user_locations` WHERE `user_id` = :partner_id");
    $partnerLocs->execute([':partner_id' => $partner->id]);
    $partnerLocRows = $partnerLocs->fetchAll();
    echo "Jumlah baris ditemukan: " . count($partnerLocRows) . "\n";
    foreach ($partnerLocRows as $row) {
        $batteryStr = isset($row->battery) ? "Baterai: {$row->battery}%" : "Baterai: N/A";
        $sessStr = isset($row->session_id) ? "Sess: {$row->session_id}" : "Sess: N/A";
        echo "  - Lat: {$row->latitude}, Lon: {$row->longitude}, {$batteryStr}, {$sessStr}, Updated: {$row->updated_at}\n";
    }
    echo "\n";

    // 6. Jalankan Query Pencarian Lokasi Pasangan yang digunakan Controller
    echo "=== Jalankan Query Lokasi Pasangan (LDR Guard Filter 3 Jam) ===\n";
    $partnerSql = "SELECT `latitude`, `longitude`, `battery`, `updated_at` 
                   FROM `user_locations` 
                   WHERE `user_id` = :partner_id 
                     AND `updated_at` > DATE_SUB(NOW(), INTERVAL 3 HOUR) 
                   LIMIT 1";
    $partnerStmt = $db->prepare($partnerSql);
    $partnerStmt->execute([':partner_id' => $partner->id]);
    $partnerLoc = $partnerStmt->fetch();
    
    if ($partnerLoc) {
        echo "✅ BERHASIL Menemukan Lokasi Pasangan!\n";
        echo "  - Lat: {$partnerLoc->latitude}\n";
        echo "  - Lon: {$partnerLoc->longitude}\n";
        echo "  - Updated At: {$partnerLoc->updated_at}\n";
    } else {
        echo "❌ GAGAL Menemukan Lokasi Pasangan (Kadaluwarsa > 3 Jam atau data kosong)!\n";
        // Cek selisih waktu terakhir pasangan dengan MySQL NOW()
        if (count($partnerLocRows) > 0) {
            $lastUpdate = $partnerLocRows[0]->updated_at;
            $diffQuery = $db->prepare("SELECT TIMEDIFF(NOW(), :last_update) as selisih, TIMESTAMPDIFF(HOUR, :last_update2, NOW()) as jam_selisih");
            $diffQuery->execute([':last_update' => $lastUpdate, ':last_update2' => $lastUpdate]);
            $diffResult = $diffQuery->fetch();
            echo "  - Terakhir update pasangan: {$lastUpdate}\n";
            echo "  - Selisih waktu dengan NOW(): {$diffResult->selisih} ({$diffResult->jam_selisih} jam)\n";
            echo "  * Petunjuk: Jika selisih jam sangat besar padahal baru di-update, berarti ada ketidakcocokan Zona Waktu (Timezone) antara PHP dan database server hosting.\n";
        } else {
            echo "  - Pasangan sama sekali belum pernah mengirim koordinat GPS.\n";
        }
    }

} catch (Exception $e) {
    echo "ERROR DATABASE: " . $e->getMessage() . "\n";
}
