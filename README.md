# Catatan Lapangan

Aplikasi web untuk survey lapangan: ambil foto, koordinat GPS tercetak kecil di pojok foto,
tulis catatan per foto, lalu ekspor semuanya ke Google Earth (.kmz).

**Buka di HP:** https://ncukahkudai.github.io/

- Foto dan catatan hanya tersimpan di HP (browser) yang dipakai, tidak dikirim ke server mana pun.
- Bisa dipakai tanpa sinyal setelah dibuka sekali dengan internet.
- Bisa dipasang ke layar utama: Chrome → menu ⋮ → *Install aplikasi* / *Tambahkan ke layar utama*.

## Isi repository

- File di folder utama (`index.html`, `app.js`, `app.css`, …) adalah aplikasi yang tampil di GitHub Pages.
- `sumber/app.html` adalah sumbernya. Jalankan `python3 sumber/build.py`, lalu salin isi `sumber/pwa/`
  (kecuali `_headers`) ke folder utama.
- `sumber/android/` berisi pembungkus APK Android (lihat `build-apk.sh`).
