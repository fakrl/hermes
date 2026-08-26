# CLAUDE.md

Panduan untuk Claude Code saat kerja di repo ini.

## Apa ini

**Hermes** — bot WhatsApp AI personal milik Fakhrul Mukhlisin (Fakrul). Bertindak sebagai
"gatekeeper" / asisten yang bales chat masuk atas nama Fakrul: pertanyaan soal skill,
availability, freelance, portfolio. Single-file Node.js app, no framework, no build step.

Repo: `github.com/fakrl/hermes` (branch `master`)

## Menjalankan

```bash
npm install
cp .env.example .env        # isi API key + ADMIN_NUMBER
cp SOUL.example.md SOUL.md  # persona; gitignored
npm start                   # = node bot.js
npm run check               # node --check bot.js
npm run smoke               # smoke test logika, tanpa konek WA
```

Pertama kali jalan → scan QR di terminal. Session disimpan di `.wwebjs_auth/` (LocalAuth),
jadi restart berikutnya nggak perlu scan ulang.

Butuh Chromium (via puppeteer, di-bundle whatsapp-web.js). Flag `--no-sandbox` sudah dipasang.

## Arsitektur (bot.js, ~691 baris, semuanya di sini)

Alur satu pesan masuk:

```
onMessage()  [terdaftar di startWhatsApp()]
  → isAdmin? (msg.fromMe || chatId === ADMIN)  → handleAdmin()  [bypass semua filter]
  → filter: group / paused / prefix "/"        → drop
  → isActiveHour()     di luar ACTIVE_HOURS    → drop
  → checkRateLimit()   10 msg / 5 menit, cooldown 10 menit
  → handleBurst()      debounce 2 detik, gabung pesan beruntun jadi satu prompt
  → processMessage()
       ├ deteksi kontak baru        → notifyAdmin()
       ├ simpan notifyName          → names.json
       ├ PROFANITY check            → balas template + alert admin, STOP
       ├ FRUSTRATED check           → inject instruksi empati ke system prompt
       ├ push ke history[chatId]    → history.json (trimHistory, cap 50)
       ├ logQuestion()              → questions_log.md
       ├ sendSeen + sendStateTyping
       ├ callAI()                   → fallback antar provider + retry (lihat bawah)
       ├ PORTFOLIO keyword          → append link portfolio
       ├ typingDelay()              → delay proporsional panjang reply (max 6s)
       └ updateMemory()             fire-and-forget, tiap MEMORY_EVERY pesan → memory.md

Gagal semua provider → user dibales pesan gangguan + admin dapat alert (bukan diem).
```

### Multi-provider AI rotation

`PROVIDERS[]` = Groq → Cerebras → Together → OpenRouter → 9router, semua lewat SDK `openai`
(OpenAI-compatible endpoint). Provider tanpa API key atau tanpa model otomatis di-skip saat
boot; kalau nol provider → `process.exit(1)`.

**9router** (opsional) — proxy lokal (`localhost:20128`) yang di-router ke banyak provider
sekaligus (OpenRouter/Gemini/NVIDIA/Ollama/Kiro, dst), dikonfigurasi lewat dashboard-nya
sendiri, bukan lewat bot.js. Koneksi "claude" sengaja dihapus dari database 9router-nya
Fakrul — subscription pribadi/kerjaan, jangan kepakai buat balas chat WA orang lain. Kosong
`ROUTER9_API_KEY`/`MODEL_9ROUTER` di `.env` = otomatis di-skip, bot tetap jalan pakai 4
provider lain.

`callAI(messages, { retries })`:

- Rotasi starting-index tiap `ROTATE_EVERY` (default 20) panggilan, nyebar beban free-tier.
- **Semua** error (429, 5xx, 401, timeout) lanjut ke provider berikutnya. Bukan cuma 429.
- Provider yang gagal masuk `providerCooldown` 60 detik, di-skip di putaran pertama.
- Habis semua provider → backoff, ulang sebanyak `retries` (default 2), baru throw.
- Timeout per call `AI_TIMEOUT_MS` (default 30s), `maxRetries: 0` di level SDK.

Retry/fallback **cuma** di `callAI()`. Jangan tambah loop retry di caller.

### System prompt

`loadSystemPrompt()` = SOUL + `fakrul_public.json` (dirender) + `memory.md`.

SOUL dicari berurutan: `process.env.SOUL_PATH` → `./SOUL.md` → `~/.hermes/SOUL.md`.
Kalau nggak ada satu pun → `SOUL_FALLBACK` inline (bot tetap jalan, warn sekali di log).

`loadProfile()` merender `fakrul_public.json` jadi teks (identity, skills, experience,
certs, availability, FAQ, `do_not_share`), di-cache pakai mtime. **Fakta taruh di JSON,
gaya bicara taruh di SOUL.md** — jangan duplikasi.

Admin punya prompt terpisah (inline di `handleAdmin`), owner-mode, tanpa gatekeeper.

## File & data

| File | Isi | Git |
|---|---|---|
| `bot.js` | seluruh aplikasi | tracked |
| `smoke.js` | smoke test logika murni, no WA/no AI | tracked |
| `SOUL.example.md` | template persona | tracked |
| `.env.example` | template config | tracked |
| `SOUL.md` | persona asli | ignored |
| `memory.md` | fakta hasil ekstraksi LLM, auto-compress ke 20 poin kalau >40 baris | ignored |
| `history.json` | riwayat chat per chatId | ignored |
| `names.json` | chatId → notifyName | ignored |
| `questions_log.md` | log semua pesan masuk | ignored |
| `fakrul_public.json` | profil terstruktur (CV, FAQ, persona) | tracked — dibaca `loadProfile()` |
| `fakrul_private.json` | data sensitif, referensi manusia saja | ignored |
| `.env` | API keys + config | ignored |

### chatId

WhatsApp sekarang banyak pakai **`@lid`** (linked ID), bukan `@c.us`. Semua data di
`history.json` saat ini pakai `@lid`.

Selalu pakai helper, jangan hardcode suffix:

- `shortId(chatId)` — buang `@c.us` / `@lid` / `@g.us` / `@broadcast`
- `resolveChatId(input)` — nomor polos / `+62…` / chatId lengkap / **nama kontak** → chatId asli, atau `null`

`/clear` `/chat` `/send` semuanya lewat `resolveChatId()`.

## Admin commands

`/status` `/log` `/who` `/memory` `/add <teks>` `/forget <kata>` `/soul <teks>` `/pause`
`/resume` `/clear <nomor|nama>` `/chat <nomor|nama>` `/send <nomor|nama> <pesan>` `/help`

`/status` juga nunjukin kesehatan provider (🟢/🔴 cooldown), jam aktif, dan apakah SOUL
kebaca atau lagi pakai fallback.

Pesan admin non-command → owner-mode chat, bot tahu daftar kontak yang pernah chat.

## Config (.env)

`GROQ_API_KEY` `CEREBRAS_API_KEY` `TOGETHER_API_KEY` `OPENROUTER_API_KEY`
`MODEL_GROQ` `MODEL_CEREBRAS` `MODEL_TOGETHER` `MODEL_OPENROUTER`
`ROUTER9_API_KEY` `ROUTER9_BASE_URL` (default `http://localhost:20128/v1`) `MODEL_9ROUTER` (opsional)
`ROTATE_EVERY` `ADMIN_NUMBER` (full chatId, termasuk `@c.us`/`@lid`)
`AI_TIMEOUT_MS` (default 30000) `MEMORY_EVERY` (default 5) `SOUL_PATH` (opsional)
`ACTIVE_HOURS` — format `"H-H"` jam lokal, half-open (`8-22` = 08.00–21.59).
Rentang lintas tengah malam didukung (`22-6`). `0-24` = selalu aktif.

Lihat `.env.example` untuk daftar lengkap.

## Konvensi

- CommonJS (`require`), bukan ESM.
- Bahasa Indonesia santai untuk komentar, log, dan semua string yang dilihat user.
- Komentar bertanda `// ponytail:` menandai patch/tweak spesifik — pertahankan kalau edit sekitarnya.
- Nggak ada linter atau build. Test cuma `smoke.js` (logika murni); verifikasi akhir tetap jalanin dan chat beneran.
- Persistensi = `fs.writeFileSync` sinkron ke JSON/MD. Nggak ada database.

## Struktur module

`whatsapp-web.js` di-require **lazy** di dalam `startWhatsApp()`, bukan di top-level —
modul itu narik puppeteer + Chromium saat di-load. `client.initialize()` cuma jalan kalau
`require.main === module`, jadi `bot.js` bisa di-`require()` buat testing tanpa buka browser.
`client` mulai sebagai `null`; `notifyAdmin()` dan `shutdown()` sudah jaga-jaga.

Kalau nambah helper murni, export-nya di `module.exports` paling bawah dan tambahin
assertion di `smoke.js`.

## Yang masih perlu diperhatikan

- `updateMemory()` di-throttle `MEMORY_EVERY` pesan per kontak (admin tetap tiap pesan).
  Ekstraksi punya aturan eksplisit: cerita pribadi/curhat kontak → SKIP, jangan disimpan.
- `client.on('message')` tidak fire untuk `msg.fromMe` (butuh `message_create`), jadi cek
  admin praktis bergantung pada `ADMIN_NUMBER` cocok persis dengan chatId.
- `fakrul_public.json` ke-track di git dan berisi nomor WA + email. Repo public.
- `memory.md` masih ada di commit history lama (`git rm --cached` cuma stop tracking ke depan).
- Rate limiter & burst buffer in-memory → reset tiap restart.
- Belum ada auto-reconnect. `disconnected` cuma nge-log; butuh restart manual atau pm2.
- **Model gratis/free-tier provider itu VOLATILE** — sering deprecated, dipindah ke tier
  enterprise-only, atau expire tanpa banyak warning. 26 Agu 2026: `llama-3.3-70b-versatile`
  (Groq) ternyata udah Enterprise-only, `llama-3.3-70b` hilang total dari Cerebras public
  endpoint (cuma sisa `gpt-oss-120b`/`gemma-4-31b`), Together nggak punya tier gratis buat
  chat model apa pun (`Prism-ML/Ternary-Bonsai-27B` satu-satunya $0.00), dan model gratis
  OpenRouter yang dipakai (`dots-studio/dots-3-note-preview:free`) **expire 30 Sep 2026** —
  cek ulang sebelum tanggal itu. Kalau provider mendadak selalu gagal, curigai model ID
  basi duluan sebelum debug kode.
