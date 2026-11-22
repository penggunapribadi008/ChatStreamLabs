# Cangkang Tauri (pengganti Electron)

Tujuan: menghilangkan Electron/Chromium bawaan, tanpa menulis ulang UI. Dashboard, pengaturan, gaya overlay, laporan,
server, dan konektor TETAP kode lama. Yang diganti hanya `src/main.js` (urusan jendela) menjadi `src-tauri/src/main.rs`.

```
Tauri (Rust)  ──jendela, tray, hotkey──►  WebView2 bawaan Windows  ──►  http://localhost:PORT  (halaman lama)
     │  stdin/stdout (JSON per baris, lihat src/sidecar.js)
     ▼
node.exe + sidecar.js  =  server.js lama + konektor YouTube/TikTok/Twitch/Kick
```
Folder data SAMA dengan versi Electron (`%APPDATA%\ChatStream Labs`), jadi pengaturan lama langsung terbawa.

## Status tahap 1
| | |
|---|---|
| Splash lama, Dashboard, tray, satu instance, keluar dengan konfirmasi | ada |
| Jendela chat (transparan, selalu di atas, pin = klik tembus, geser/resize), posisi diingat | ada |
| Hotkey global (bawaan + yang diubah di pengaturan), sembunyikan dari OBS/tangkapan layar | ada |
| Jendela laporan/gaya/pratinjau, tombol min/max/tutup Dashboard, hemat RAM Dashboard | ada |
| Server + 4 konektor + overlay OBS + ekstensi Chrome (folder tetap) | ada (kode lama) |
| Installer "next-next" (NSIS, per pengguna) | ada |
| Jendela tombol (mata, pin, pindah, tutup) di luar jendela chat, posisinya mengikuti pengaturan "Posisi tombol" | ada (tahap 2a) |
| Browser Dock (banyak dock, buka/tutup/muat ulang, pin, geser, ubah ukuran, skala otomatis, posisi diingat, tray + hotkey) | ada (tahap 2a) |
| Alert hadiah TikTok (jendela di samping chat, dibuat saat dibutuhkan, dilepas 45 dtk setelah selesai) | ada (tahap 2b) |
| Klik di dalam jendela ter-pin (bulatan chat/filter, kolom ketik) | ada (tahap 2b) |
| Auto-update dari GitHub Releases (SHA-256 wajib cocok, dialog Update Now / Later, progres di splash, tombol Cek Update) | ada (tahap 2b), repo harus PUBLIC |
| Simpan CSS (.css) | ada (tahap 2b) |
| Browser Dock "Ukuran otomatis" (isi widget memenuhi jendela; halaman mengukur isi, hasil dibaca dari alamat halaman) | ada |
| Geser tanpa snap layar penuh + resize dari sudut (buatan sendiri) | ada |
| **Belum:** tombol Bisu Browser Dock, muat-ulang otomatis dock yang gagal | |
| **Belum:** kunci scroll chat saat ter-pin (lockScroll, perlu hook mouse global) | |
| **Belum:** cadangan Kick lewat jaringan Chromium (netFetch) | |
| **Belum:** opsi "Abaikan versi ini" pada dialog update | |

## Build
Push tag `v<versi>` (mis. `git tag v1.1.8 && git push origin v1.1.8`) -> Actions > "Build Tauri" -> otomatis jadi Release **pra-rilis** "ChatStream Labs v<versi>" berisi installer `.exe` saja (sejak v1.1.8; tidak ada artifact).
Lokal (butuh Rust, Node 22): `node scripts/build-tauri.js`, taruh `node.exe` di
`src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`, lalu `cd shell && npx @tauri-apps/cli@2 build`.

## Kalau build merah
Kode ini ditulis tanpa compiler Rust. Titik yang paling mungkin perlu disesuaikan dengan versi Tauri terbaru:
`event.state()` pada hotkey, `show_menu_on_left_click`, bentuk `resources` di `tauri.conf.json`, nama-nama kecil di API dialog.
Kirim log error-nya, biasanya perbaikannya satu baris.


Catatan lengkap proyek untuk melanjutkan di chat baru: lihat `HANDOFF.md` di akar repo.
