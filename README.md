# Tebak Gambar — game gambar multiplayer online

Game ala Skribbl: satu pemain menggambar di kanvas, pemain lain menebak lewat chat.
**3 ronde**, 2–10 pemain, realtime lewat Socket.IO, tanpa database dan tanpa API key.

## Menjalankan

Butuh **Node.js 18+**.

```bash
cd drawing-game
npm install
npm start
```

Buka <http://localhost:3000>. Pemain lain di jaringan yang sama membuka
`http://<IP-komputer>:3000` lalu memasukkan kode room 4 karakter.

Port lain:

```bash
PORT=8080 npm start          # Linux/macOS
set PORT=8080 && npm start   # Windows cmd
```

## Cara main

1. Pemain pertama isi nama → **Buat room baru**, lalu bagikan **kode room**.
2. Pemain lain isi nama + kode → **Gabung**. Pemain pertama menjadi **host**.
3. Host memilih **tema kata** lalu klik **Mulai game** (minimal 2 pemain).
4. Tiap giliran: penggambar memilih 1 dari 3 kata, menggambar di kanvas
   (75 detik), yang lain menebak lewat chat.
5. Total **3 ronde**; di setiap ronde semua pemain dapat giliran menggambar.
6. Setelah selesai, host bisa **Main lagi** (kembali ke lobby, skor direset).

### Skor

| Kejadian | Poin |
| --- | --- |
| Menebak benar | `100 + sisa detik × 2` (maks 250) |
| Penggambar, ada yang menebak benar | +50 jika semua menebak, +25 jika sebagian |
| Penggambar, tidak ada yang benar | +10 |

Petunjuk huruf terbuka otomatis saat sisa waktu 60%, 40%, dan 20%.

### Fitur

- Kanvas realtime (pointer/mouse/touch), 8 warna, 3 ukuran kuas, penghapus, hapus semua.
- Kata rahasia hanya dikirim ke penggambar; penebak melihat kata tersamar.
- Penggambar tidak bisa menebak, penebak tidak bisa menggambar/memilih kata (dicek di server).
- Chat lobby + chat tebakan, jawaban benar diumumkan dengan poin.
- Tema kata: **11 tema, 406 kata** (Hewan, Makanan, Benda, Olahraga, Profesi,
  Transportasi, Alam, Teknologi, Hiburan, Sekolah, Pakaian) + mode **Campuran**.
- Reconnect: pemain yang terputus boleh masuk lagi dengan nama yang sama dalam
  **20 detik**; skor dan goresan kanvas dipulihkan. Jika tidak kembali, permainan
  dihentikan dengan anggun.
- Kode room, validasi input, rate limit chat/gambar, dan auto-hapus room kosong.

## Struktur

```
drawing-game/
├── server/
│   ├── server.js   # Express + Socket.IO: event, validasi, relay gambar
│   ├── game.js     # logika room: ronde, giliran, timer, skor, reconnect
│   └── words.js    # dataset kata bertema
├── public/
│   ├── index.html  # 3 layar: join, lobby, game
│   ├── styles.css
│   └── app.js      # kanvas, chat, HUD, render state
├── test/
│   ├── simulate.js # uji logika permainan (tanpa socket)
│   ├── e2e.js      # uji server + beberapa klien Socket.IO
│   └── ui.js       # uji UI di Chrome headless (2 pemain)
└── package.json
```

## Menambah kata / tema

Semua di `server/words.js`:

```js
const CATEGORIES = {
  hewan: { label: "Hewan", words: ["kucing", "gajah", "..."] },
  // tema baru:
  dapur: { label: "Dapur", words: ["panci", "wajan", "..."] },
};
```

Tema otomatis muncul di dropdown. Test memastikan kata unik secara global,
minimal 20 kata per tema, dan setiap kata minimal 3 karakter.

## Pengujian

```bash
npm test          # simulasi logika + uji end-to-end Socket.IO (cepat)
npm run test:e2e  # hanya end-to-end
npm run test:ui   # UI Chrome headless; butuh Chrome/Chromium
```

Uji UI memakai `puppeteer-core` dan mencari Chrome di lokasi standar;
set `CHROME_PATH` bila Chrome ada di tempat lain, atau `SKIP_UI=1` untuk melewatinya.

Hasil yang sudah dijalankan pada proyek ini:

- `test/simulate.js` — 3 ronde penuh, 3 pemain, 9 giliran, validasi skor dan fase,
  dataset 11 tema/406 kata unik, aturan lobby, host pindah, reconnect, penggambar keluar.
- `test/e2e.js` — server sungguhan + 3 klien: join, kode salah, chat, siap, host-only,
  3 ronde, relay goresan, penebak tidak bisa menggambar, skor, main lagi, reconnect
  dengan snapshot kanvas.
- `test/ui.js` — 2 tab Chrome: buat room, gabung, pilih tema, mulai, 6 giliran penuh
  (pilih kata, gambar, tebakan salah/benar, pengumuman jawaban), skor akhir, main lagi,
  dan **nol error konsol**.

## Variabel lingkungan

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `PORT` | `3000` | Port server |
| `CHOOSE_MS` | `15000` | Batas memilih kata (uji memakai 3000–4000) |
| `TURN_END_MS` | `3500` | Jeda pengumuman jawaban |
| `ROUND_END_MS` | `5000` | Jeda antar ronde |
| `TICK_MS` | `1000` | Interval timer detik |

## Batasan yang diketahui

- Room disimpan di memori proses: restart server menghapus semua room, dan game
  belum bisa dijalankan di beberapa instance tanpa sticky session/penyimpanan bersama.
- Kanvas menyimpan riwayat goresan di memori untuk pemain yang reconnect; tidak ada undo.
- Belum ada moderasi kata/kata terlarang dan belum ada akun pengguna.
