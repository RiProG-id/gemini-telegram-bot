# Gemini Telegram Bot

Bot Telegram yang menggunakan Google Gemini API untuk menjawab pertanyaan dan membuat/mengedit gambar langsung dari Telegram.

## Instalasi dan Penggunaan

### Instalasi di Local/VPS

#### Langkah 1: Clone Repository

```bash
git clone https://github.com/RiProG-id/gemini-telegram-bot
cd gemini-telegram-bot
```

#### Langkah 2: Konfigurasi `.env`

1. Salin file contoh environment:

```bash
cp .env.example .env
```

2. Edit file `.env`:

```bash
nano .env
```

Isi dengan token dan API key Anda:

```
TELEGRAM_BOT_TOKEN=ISI_TOKEN_BOT_ANDA
GOOGLE_API_KEY=ISI_API_KEY_GEMINI_ANDA
```

#### Langkah 3: Instal Dependensi

```bash
npm install
```

#### Langkah 4: Jalankan Bot

```bash
node bot.js
```

> **Catatan:** Anda dapat mengedit file `persona.txt` untuk menyesuaikan karakter bot (opsional).

## Cara Penggunaan

Setelah bot aktif, Anda dapat menggunakan perintah berikut di Telegram:

- `/tanya [pertanyaan]` — untuk mengajukan pertanyaan.
- `/gambar [deskripsi gambar]` — untuk membuat gambar dari deskripsi.
- Balas gambar + teks — untuk mengedit gambar.

## More Information

**Author:** [RiProG](https://github.com/RiProG-id)

### Visit:

- [Support ME](https://t.me/RiOpSo/2848)
- [Telegram Channel](https://t.me/RiOpSo)
- [Telegram Group](https://t.me/RiOpSoDisc)
