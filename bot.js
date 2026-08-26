require('dotenv').config()
const OpenAI = require('openai')
const fs = require('fs')
const os = require('os')
const path = require('path')

// whatsapp-web.js sengaja di-require LAZY di startWhatsApp().
// Modul itu narik puppeteer + Chromium saat di-load, jadi kalau di-require di sini
// file ini nggak bisa di-import buat testing tanpa nyalain browser.

// --- Config ---
const HISTORY_FILE = path.join(__dirname, 'history.json')
const NAMES_FILE = path.join(__dirname, 'names.json')
const QUESTIONS_LOG = path.join(__dirname, 'questions_log.md')
const MEMORY_FILE = path.join(__dirname, 'memory.md')
const PROFILE_FILE = path.join(__dirname, 'fakrul_public.json')
const ADMIN = process.env.ADMIN_NUMBER  // full chatId, e.g. 628xxx@c.us atau @lid
const startTime = Date.now()

// SOUL.md dicari berurutan: env SOUL_PATH → ./SOUL.md (dalam repo, gitignored) → ~/.hermes/SOUL.md (lokasi lama)
const SOUL_CANDIDATES = [
  process.env.SOUL_PATH,
  path.join(__dirname, 'SOUL.md'),
  path.join(os.homedir(), '.hermes', 'SOUL.md'),
].filter(Boolean)

const SOUL_FALLBACK = `Kamu adalah Hermes, asisten WhatsApp pribadi Fakhrul Mukhlisin (Fakrul), Full Stack Developer.
Kamu membalas chat masuk atas nama Fakrul. Bahasa Indonesia santai tapi sopan, jawaban pendek seperti chat biasa.
Jangan mengaku sebagai Fakrul. Kalau ada yang di luar pengetahuanmu, arahkan orangnya untuk menghubungi Fakrul langsung.`

// ACTIVE_HOURS format "H-H" (jam lokal), mis. "8-22". Default 0-24 = selalu aktif.
const ACTIVE_HOURS = (() => {
  const raw = (process.env.ACTIVE_HOURS || '0-24').trim()
  const m = raw.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/)
  if (!m) { console.warn(`ACTIVE_HOURS "${raw}" tidak valid, pakai 0-24`); return { from: 0, to: 24 } }
  return { from: parseInt(m[1]), to: parseInt(m[2]) }
})()

function isActiveHour(d = new Date()) {
  const { from, to } = ACTIVE_HOURS
  if (from === to || (from === 0 && to >= 24)) return true
  const h = d.getHours()
  return from < to ? (h >= from && h < to) : (h >= from || h < to)  // handle rentang lintas tengah malam
}

// Rate limit: max 10 pesan per 5 menit per user, cooldown 10 menit
const RATE_LIMIT = 10
const RATE_WINDOW = 5 * 60 * 1000
const RATE_COOLDOWN = 10 * 60 * 1000

// Timeout per panggilan AI — tanpa ini provider yang hang bikin bot diem selamanya
const AI_TIMEOUT = parseInt(process.env.AI_TIMEOUT_MS) || 30000

const PROFANITY = ['anjing', 'bangsat', 'babi', 'kontol', 'memek', 'jancok', 'fuck', 'shit', 'bastard', 'asshole']
const FRUSTRATED_KEYWORDS = ['kecewa', 'lambat', 'lama banget', 'nggak jelas', 'ga jelas', 'payah', 'jelek', 'buruk', 'ribet', 'susah banget', 'nggak bisa', 'gabisa', 'disappointed', 'slow', 'useless', 'zonk']
const PORTFOLIO_KEYWORDS = ['portfolio', 'portofolio', 'project', 'projek', 'github', 'contoh kerja', 'hasil kerja', 'pernah bikin', 'pernah buat', 'lihat hasil', 'lihat kerja']
const PORTFOLIO_LINKS = `\nPortfolio: fakrul.netlify.app\nGitHub: github.com/fakrl\nLinkedIn: linkedin.com/in/fakrl`

// --- State ---
let paused = false
const rateLimitMap = {}   // chatId -> [timestamps]
const cooldownMap = {}    // chatId -> cooldown end timestamp
const burstBuffer = {}    // chatId -> { timer, messages[] }
const nameMap = fs.existsSync(NAMES_FILE) ? JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')) : {}

const PROVIDERS = [
  { name: 'Groq',       baseURL: 'https://api.groq.com/openai/v1',      apiKey: process.env.GROQ_API_KEY,       model: process.env.MODEL_GROQ },
  { name: 'Cerebras',   baseURL: 'https://api.cerebras.ai/v1',           apiKey: process.env.CEREBRAS_API_KEY,   model: process.env.MODEL_CEREBRAS },
  { name: 'Together',   baseURL: 'https://api.together.xyz/v1',          apiKey: process.env.TOGETHER_API_KEY,   model: process.env.MODEL_TOGETHER },
  { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1',         apiKey: process.env.OPENROUTER_API_KEY, model: process.env.MODEL_OPENROUTER },
]
  .filter(p => {
    if (!p.apiKey) { console.warn(`⚠️  ${p.name} dilewati: API key kosong`); return false }
    if (!p.model)  { console.warn(`⚠️  ${p.name} dilewati: MODEL_${p.name.toUpperCase()} kosong`); return false }
    return true
  })
  .map(p => ({ ...p, client: new OpenAI({ baseURL: p.baseURL, apiKey: p.apiKey, timeout: AI_TIMEOUT, maxRetries: 0 }) }))

if (!PROVIDERS.length) {
  console.error('❌ Tidak ada provider AI yang terkonfigurasi. Isi minimal satu API key + model di .env')
  process.exit(1)
}

const ROTATE_EVERY = parseInt(process.env.ROTATE_EVERY) || 20
let callCount = 0

// Provider yang baru saja gagal ditandai "cooling" biar nggak dicoba duluan terus
const providerCooldown = {}   // name -> timestamp boleh dicoba lagi
const PROVIDER_COOLDOWN_MS = 60 * 1000

/**
 * Coba semua provider berurutan mulai dari index rotasi.
 * Beda dengan versi lama: SEMUA error (429, 500, 401, timeout) lanjut ke provider
 * berikutnya. Error terakhir baru dilempar kalau semua provider habis.
 */
async function callAI(messages, { retries = 2 } = {}) {
  const start = Math.floor(callCount / ROTATE_EVERY) % PROVIDERS.length
  callCount++
  let lastErr = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    for (let i = 0; i < PROVIDERS.length; i++) {
      const p = PROVIDERS[(start + i) % PROVIDERS.length]
      const now = Date.now()
      // Putaran pertama: hormati cooldown. Putaran terakhir: coba semua, mumpung darurat.
      if (attempt === 0 && providerCooldown[p.name] > now) continue

      try {
        const res = await p.client.chat.completions.create({ model: p.model, messages })
        const content = res?.choices?.[0]?.message?.content
        if (!content) throw new Error('respons kosong')
        delete providerCooldown[p.name]
        if (i > 0 || attempt > 0) console.log(`✔ Pakai ${p.name}`)
        return content
      } catch (err) {
        lastErr = err
        providerCooldown[p.name] = now + PROVIDER_COOLDOWN_MS
        const code = err.status || err.code || '?'
        console.warn(`✖ ${p.name} gagal (${code}): ${err.message} → provider berikutnya`)
      }
    }
    // Semua provider gagal di putaran ini — backoff sebelum coba lagi
    if (attempt < retries) {
      const wait = (attempt + 1) * 4000
      console.warn(`Semua provider gagal, tunggu ${wait / 1000}s lalu ulangi...`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw new Error(`Semua provider gagal. Terakhir: ${lastErr?.message || 'unknown'}`)
}

// --- History ---
const history = fs.existsSync(HISTORY_FILE)
  ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  : {}

const knownContacts = new Set(Object.keys(history))

function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history))
}

// --- System prompt ---
function resolveSoulPath() {
  return SOUL_CANDIDATES.find(p => fs.existsSync(p)) || null
}

let warnedNoSoul = false
function loadSoul() {
  const p = resolveSoulPath()
  if (!p) {
    if (!warnedNoSoul) {
      warnedNoSoul = true
      console.warn(`⚠️  SOUL.md nggak ketemu di: ${SOUL_CANDIDATES.join(', ')}\n   Pakai persona fallback bawaan. Copy SOUL.example.md jadi SOUL.md buat persona asli.`)
    }
    return SOUL_FALLBACK
  }
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (err) {
    console.warn(`⚠️  Gagal baca ${p}: ${err.message} — pakai persona fallback`)
    return SOUL_FALLBACK
  }
}

// Render fakrul_public.json jadi teks ringkas. Di-cache berdasarkan mtime.
let profileCache = { mtime: 0, text: '' }
function loadProfile() {
  if (!fs.existsSync(PROFILE_FILE)) return ''
  try {
    const mtime = fs.statSync(PROFILE_FILE).mtimeMs
    if (mtime === profileCache.mtime) return profileCache.text
    const p = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'))
    const L = []
    const id = p.identity || {}
    L.push(`Nama: ${id.name} (panggilan: ${id.nickname}) — ${id.role}`)
    if (id.current_position) L.push(`Posisi sekarang: ${id.current_position}`)
    if (id.education) L.push(`Pendidikan: ${id.education}`)
    if (id.domicile) L.push(`Domisili: ${id.domicile}`)
    if (id.portfolio) L.push(`Portfolio: ${id.portfolio} | GitHub: ${id.github} | LinkedIn: ${id.linkedin}`)

    if (p.skills) {
      L.push('')
      L.push('Skill:')
      for (const [k, v] of Object.entries(p.skills)) L.push(`- ${k}: ${[].concat(v).join(', ')}`)
    }
    if (p.experience_highlights?.length) {
      L.push('')
      L.push('Pengalaman:')
      for (const e of p.experience_highlights) {
        L.push(`- ${e.role} @ ${e.company} (${e.period})${e.project || e.highlight ? ' — ' + (e.project || e.highlight) : ''}`)
      }
    }
    if (p.certifications?.length) { L.push(''); L.push(`Sertifikasi: ${p.certifications.join('; ')}`) }
    if (p.achievements?.length)   { L.push(''); L.push(`Pencapaian: ${p.achievements.join('; ')}`) }
    if (p.availability) {
      const a = p.availability
      L.push('')
      L.push(`Ketersediaan: ${[].concat(a.open_to || []).join('/')} — mode ${[].concat(a.mode || []).join('/')}. Fokus: ${a.focus_stack || '-'}.${a.constraint ? ' Catatan: ' + a.constraint : ''}`)
    }
    if (p.faq?.length) {
      L.push('')
      L.push('FAQ (jawab sesuai ini, tapi parafrase pakai gaya bahasamu sendiri):')
      for (const f of p.faq) L.push(`- T: ${f.q}\n  J: ${f.a}`)
    }
    const dns = p.bot_persona?.do_not_share
    if (dns?.length) {
      L.push('')
      L.push(`JANGAN PERNAH dibocorkan: ${dns.join(', ')}. Kalau ditanya soal ini, tolak halus dan arahkan ngobrol langsung sama Fakrul.`)
    }
    if (p.bot_persona?.escalation) L.push(`Eskalasi: ${p.bot_persona.escalation}`)

    profileCache = { mtime, text: L.join('\n') }
    return profileCache.text
  } catch (err) {
    console.warn(`⚠️  ${PROFILE_FILE} gagal di-parse: ${err.message}`)
    return ''
  }
}

function loadSystemPrompt() {
  const parts = [loadSoul()]
  const profile = loadProfile()
  if (profile) parts.push(`## Data Faktual Fakrul\n${profile}`)
  const memory = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8').trim() : ''
  if (memory) parts.push(`## Catatan Tambahan\n${memory}`)
  return parts.join('\n\n')
}

// --- Helpers ---
const HISTORY_CAP = 50

// WhatsApp pakai @c.us maupun @lid — jangan hardcode salah satu
function shortId(chatId) {
  return String(chatId).replace(/@(c\.us|lid|g\.us|broadcast)$/, '')
}

// Cari chatId asli dari input admin: bisa nomor polos, @c.us, @lid, atau nama kontak
function resolveChatId(input) {
  const raw = String(input).replace(/^\+/, '').trim()
  if (history[raw]) return raw
  if (history[raw + '@c.us']) return raw + '@c.us'
  if (history[raw + '@lid']) return raw + '@lid'
  const byPrefix = Object.keys(history).find(k => k.startsWith(raw + '@'))
  if (byPrefix) return byPrefix
  const byName = Object.entries(nameMap).find(([, n]) => n.toLowerCase() === raw.toLowerCase())?.[0]
  return byName || null
}

function trimHistory(chatId) {
  const h = history[chatId]
  if (h && h.length > HISTORY_CAP) history[chatId] = h.slice(-HISTORY_CAP)
}

function logQuestion(chatId, question) {
  const line = `- [${new Date().toLocaleString('id-ID')}] ${shortId(chatId)}: ${question}\n`
  fs.appendFileSync(QUESTIONS_LOG, line)
}

function contains(text, keywords) {
  const lower = text.toLowerCase()
  return keywords.some(k => lower.includes(k))
}

// ponytail: delay proporsional dari panjang reply, max 6 detik
function typingDelay(replyLength) {
  return Math.min(800 + replyLength * 12, 6000)
}

async function notifyAdmin(text) {
  if (!client || !ADMIN) return
  try { await client.sendMessage(ADMIN, `🤖 Alert:\n${text}`) } catch (_) {}
}

async function compressMemory() {
  const current = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8') : ''
  if (current.split('\n').length < 40) return
  try {
    const compressed = (await callAI([{ role: 'user', content:
`Ini memory bot WA pribadi Fakrul. Rangkum jadi maksimal 20 poin paling penting, format "- <fakta>".
Hapus duplikat, basa-basi, dan cerita pribadi kontak lain. Simpan hanya fakta tentang Fakrul dan instruksi perilaku bot.
Keluarkan HANYA daftar poinnya, tanpa kalimat pembuka.

${current}` }], { retries: 0 })).trim()
    if (compressed.startsWith('- ')) {
      fs.writeFileSync(MEMORY_FILE, compressed)
      console.log('Memory compressed')
    }
  } catch (err) {
    console.warn('compressMemory gagal (diabaikan):', err.message)
  }
}

// Berapa pesan sekali ekstraksi memory. Tiap pesan = 2x call AI = boros kuota free-tier.
const MEMORY_EVERY = parseInt(process.env.MEMORY_EVERY) || 5
const memoryCounter = {}   // chatId -> jumlah pesan sejak ekstraksi terakhir

// Aturan apa yang layak masuk memory. Tanpa ini memory keisi curhat kontak random.
const MEMORY_RULES = `Yang BOLEH disimpan (cuma ini):
- Fakta tentang Fakrul: skill, pengalaman, harga/rate, jadwal, preferensi kerja, kontak.
- Instruksi eksplisit soal bagaimana bot harus bersikap atau menjawab.
- Kesepakatan konkret hasil obrolan (mis. "sudah janjian meeting", "diminta kirim CV").

Yang DILARANG disimpan (langsung SKIP):
- Cerita pribadi, curhat, perasaan, atau urusan hidup lawan bicara.
- Basa-basi, sapaan, obrolan santai tanpa informasi.
- Status internal bot (siapa yang chat, statistik, daftar kontak).
- Apa pun yang sudah ada di memory, walau beda kalimat.`

// ponytail: fire-and-forget memory update
async function updateMemory(chatId, userMsg, botReply, isAdmin = false) {
  // Throttle per chat — admin tetap tiap pesan karena info dia paling berharga
  if (!isAdmin) {
    memoryCounter[chatId] = (memoryCounter[chatId] || 0) + 1
    if (memoryCounter[chatId] < MEMORY_EVERY) return
    memoryCounter[chatId] = 0
  }

  const currentMemory = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8') : ''
  const who = isAdmin ? 'Fakrul sendiri (owner bot)' : 'kontak lain, BUKAN Fakrul'
  try {
    const extracted = (await callAI([{ role: 'user', content:
`Kamu penyaring memory untuk bot WA pribadi Fakrul. Lawan bicara di percakapan ini adalah ${who}.

${MEMORY_RULES}

Percakapan:
User: ${userMsg}
Bot: ${botReply}

Memory yang sudah ada:
${currentMemory}

Jawab HANYA satu baris: entah "SKIP", atau satu fakta baru dengan format "- <fakta>". Jangan ada penjelasan lain.` }], { retries: 0 })).trim()

    if (extracted.startsWith('- ') && !extracted.toUpperCase().includes('SKIP')) {
      fs.appendFileSync(MEMORY_FILE, `\n${extracted}`)
      console.log('Memory updated:', extracted)
      compressMemory()
    }
  } catch (err) {
    console.warn('updateMemory gagal (diabaikan):', err.message)
  }
}

// --- Rate limiter ---
function checkRateLimit(chatId) {
  const now = Date.now()
  if (cooldownMap[chatId] && now < cooldownMap[chatId]) return 'cooldown'
  if (!rateLimitMap[chatId]) rateLimitMap[chatId] = []
  rateLimitMap[chatId] = rateLimitMap[chatId].filter(t => now - t < RATE_WINDOW)
  rateLimitMap[chatId].push(now)
  if (rateLimitMap[chatId].length > RATE_LIMIT) {
    cooldownMap[chatId] = now + RATE_COOLDOWN
    notifyAdmin(`⚠️ Rate limit: ${nameMap[chatId] || shortId(chatId)} dikirim ke cooldown 10 menit`)
    return 'limited'
  }
  return 'ok'
}

// --- Burst handler (debounce 2 detik) ---
function handleBurst(chatId, text, callback) {
  if (!burstBuffer[chatId]) burstBuffer[chatId] = { messages: [] }
  clearTimeout(burstBuffer[chatId].timer)
  burstBuffer[chatId].messages.push(text)
  burstBuffer[chatId].timer = setTimeout(() => {
    const combined = burstBuffer[chatId].messages.join('\n')
    delete burstBuffer[chatId]
    callback(combined)
  }, 2000)
}

// --- Main reply logic ---
async function processMessage(msg, chatId, text) {
  const isNew = !knownContacts.has(chatId)
  if (isNew) {
    knownContacts.add(chatId)
    notifyAdmin(`👤 Kontak baru: ${nameMap[chatId] || shortId(chatId)}\nPesan: "${text}"`)
  }
  if (msg.notifyName && !nameMap[chatId]) {
    nameMap[chatId] = msg.notifyName
    fs.writeFileSync(NAMES_FILE, JSON.stringify(nameMap))
  }

  // Profanity check
  if (contains(text, PROFANITY)) {
    try {
      const chat = await msg.getChat()
      await chat.sendSeen()
      await chat.sendStateTyping()
      await new Promise(r => setTimeout(r, 1500))
      await chat.clearState()
      await msg.reply('Hei, kita bisa ngobrol dengan baik kok. Ada yang bisa dibantu?')
    } catch (_) {}
    notifyAdmin(`🚨 Profanity dari ${nameMap[chatId] || shortId(chatId)}: "${text}"`)
    return
  }

  // Frustrated detection
  const isFrustrated = contains(text, FRUSTRATED_KEYWORDS)
  if (isFrustrated) {
    notifyAdmin(`😤 Pesan frustrated dari ${nameMap[chatId] || shortId(chatId)}: "${text}"`)
  }

  // History
  if (!history[chatId]) history[chatId] = []
  history[chatId].push({ role: 'user', content: text })
  trimHistory(chatId)
  saveHistory()
  logQuestion(chatId, text)

  // Build system prompt — lebih empati kalau frustrated
  const extra = isFrustrated
    ? '\n\nCATATAN: User ini terlihat frustrasi. Prioritaskan empati, akui perasaannya dulu sebelum kasih solusi. Jangan defensif.'
    : ''
  const systemPrompt = loadSystemPrompt() + extra

  // Typing indicator — getChat() bisa throw kalau WA session reset
  let chat = null
  try {
    chat = await msg.getChat()
    await chat.sendSeen()
    await chat.sendStateTyping()
  } catch (_) {}

  // Retry/fallback sudah ditangani di dalam callAI() — nggak perlu loop lagi di sini
  try {
    let reply = await callAI([{ role: 'system', content: systemPrompt }, ...history[chatId]])

    // Portfolio trigger
    if (contains(text, PORTFOLIO_KEYWORDS)) {
      reply += PORTFOLIO_LINKS
    }

    // Delay proporsional panjang reply
    await new Promise(r => setTimeout(r, typingDelay(reply.length)))
    if (chat) await chat.clearState()

    history[chatId].push({ role: 'assistant', content: reply })
    trimHistory(chatId)
    saveHistory()
    await msg.reply(reply)
    updateMemory(chatId, text, reply)
  } catch (err) {
    if (chat) { try { await chat.clearState() } catch (_) {} }
    console.error('AI error:', err.message)
    // Jangan diemin user — kasih tau ada gangguan, dan lapor ke admin
    try { await msg.reply('Waduh, lagi ada gangguan di sistem gue. Coba chat lagi bentar lagi ya 🙏') } catch (_) {}
    notifyAdmin(`❌ Gagal balas ${nameMap[chatId] || shortId(chatId)}: ${err.message}`)
  }
}

// --- Admin commands ---
async function handleAdmin(msg) {
  const text = msg.body.trim()
  const cmd = text.split(' ')[0].toLowerCase()
  const args = text.slice(cmd.length).trim()

  if (cmd === '/status') {
    const uptime = Math.floor((Date.now() - startTime) / 60000)
    const totalChats = Object.keys(history).filter(k => !k.includes('@g.us')).length
    const totalMsgs = Object.values(history).reduce((a, h) => a + h.length, 0)
    const now = Date.now()
    const providers = PROVIDERS.map(p =>
      `${p.name}${providerCooldown[p.name] > now ? ' 🔴' : ' 🟢'}`).join(', ')
    const soul = resolveSoulPath()
    return [
      'Status bot:',
      `- Uptime: ${uptime} menit`,
      `- Mode: ${paused ? '⏸ PAUSE' : '▶ AKTIF'}`,
      `- Jam aktif: ${ACTIVE_HOURS.from}-${ACTIVE_HOURS.to} (sekarang ${isActiveHour() ? 'dalam' : 'DI LUAR'} jam aktif)`,
      `- Provider: ${providers}`,
      `- Total panggilan AI: ${callCount}`,
      `- SOUL: ${soul ? path.basename(soul) + ' ✔' : 'TIDAK ADA ⚠️ (pakai fallback)'}`,
      `- Profil: ${fs.existsSync(PROFILE_FILE) ? 'termuat ✔' : 'tidak ada ⚠️'}`,
      `- Total chat: ${totalChats}`,
      `- Total pesan: ${totalMsgs}`,
      `- Kontak dikenal: ${knownContacts.size}`,
    ].join('\n')
  }
  if (cmd === '/log') {
    if (!fs.existsSync(QUESTIONS_LOG)) return 'Belum ada log.'
    return fs.readFileSync(QUESTIONS_LOG, 'utf8').trim().split('\n').slice(-10).join('\n') || 'Log kosong.'
  }
  if (cmd === '/memory') {
    return fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8') : 'Memory kosong.'
  }
  if (cmd === '/add') {
    if (!args) return 'Usage: /add <teks>'
    fs.appendFileSync(MEMORY_FILE, `\n- ${args}`)
    return `Ditambahkan:\n- ${args}`
  }
  if (cmd === '/soul') {
    if (!args) return 'Usage: /soul <instruksi>'
    // Tulis ke SOUL.md yang sedang dipakai; kalau belum ada, bikin di dalam repo
    const target = resolveSoulPath() || path.join(__dirname, 'SOUL.md')
    fs.appendFileSync(target, `\n${args}`)
    return `Personality diupdate (${path.basename(target)}):\n${args}`
  }
  if (cmd === '/pause') {
    paused = true
    return '⏸ Bot di-pause. Ketik /resume untuk aktifkan lagi.'
  }
  if (cmd === '/resume') {
    paused = false
    return '▶ Bot aktif lagi.'
  }
  if (cmd === '/clear') {
    if (!args) return 'Usage: /clear <nomor|nama|chatId>'
    const target = resolveChatId(args)   // sekarang paham @lid & nama, bukan cuma @c.us
    if (!target || !history[target]) return `Tidak ada history untuk ${args}`
    delete history[target]
    knownContacts.delete(target)
    delete memoryCounter[target]
    saveHistory()
    return `History ${nameMap[target] || shortId(target)} dihapus.`
  }
  if (cmd === '/chat') {
    if (!args) return 'Usage: /chat <nomor|nama|chatId>'
    const target = resolveChatId(args)
    if (!target || !history[target]?.length) return `Tidak ada history untuk ${args}`
    return history[target].slice(-10).map(m => `[${m.role}]: ${m.content}`).join('\n\n')
  }
  if (cmd === '/who') {
    const list = Object.keys(history)
      .filter(k => k !== ADMIN && !k.includes('@g.us') && !k.includes('broadcast'))
      .map(k => `- ${nameMap[k] || '(tanpa nama)'} — ${shortId(k)} (${history[k].length} pesan)`)
    return list.length ? `Kontak:\n${list.join('\n')}` : 'Belum ada kontak.'
  }
  if (cmd === '/send') {
    const spaceIdx = args.indexOf(' ')
    if (spaceIdx === -1) return 'Usage: /send <nomor|nama|chatId> <pesan>'
    const rawTarget = args.slice(0, spaceIdx)
    const message = args.slice(spaceIdx + 1)
    const target = resolveChatId(rawTarget)
      || (rawTarget.includes('@') ? rawTarget : rawTarget.replace(/^\+/, '') + '@c.us')
    try {
      await client.sendMessage(target, message)
      return `Pesan terkirim ke ${nameMap[target] || shortId(target)}`
    } catch (err) {
      return `Gagal kirim ke ${target}: ${err.message}`
    }
  }
  if (cmd === '/forget') {
    if (!args) return 'Usage: /forget <kata kunci>'
    if (!fs.existsSync(MEMORY_FILE)) return 'Memory kosong.'
    const lines = fs.readFileSync(MEMORY_FILE, 'utf8').split('\n')
    const filtered = lines.filter(l => !l.toLowerCase().includes(args.toLowerCase()))
    fs.writeFileSync(MEMORY_FILE, filtered.join('\n'))
    return `Baris yang mengandung "${args}" dihapus.`
  }
  if (cmd === '/help') {
    return [
      'Perintah admin:',
      '/status — statistik bot + kesehatan provider',
      '/log — 10 pertanyaan terakhir',
      '/who — daftar kontak yang pernah chat',
      '/memory — isi memory',
      '/add <teks> — tambah memory',
      '/forget <kata> — hapus baris dari memory',
      '/soul <teks> — update personality',
      '/pause — mode manual',
      '/resume — aktifkan bot',
      '/clear <nomor|nama> — hapus history',
      '/chat <nomor|nama> — lihat riwayat',
      '/send <nomor|nama> <pesan> — kirim pesan',
      '/help — daftar perintah',
    ].join('\n')
  }

  // Pesan bebas dari admin — owner mode: pakai SOUL tapi tanpa gatekeeper
  const contacts = Object.keys(history)
    .filter(k => k !== ADMIN && !k.includes('@g.us') && !k.includes('broadcast'))
    .map(k => nameMap[k] ? `${nameMap[k]} (${shortId(k)})` : shortId(k))
    .join(', ') || 'belum ada'
  const adminPrompt = `Kamu adalah Hermes, bot WA pribadi Fakrul Mukhlisin — Full Stack Developer, owner dan satu-satunya admin bot ini. Yang ngobrol sama kamu sekarang adalah FAKRUL MUKHLISIN sendiri. Kalau dia tanya "gua siapa" atau "gua admin bukan", jawab tegas: dia Fakrul, owner lo. Jawab santai, langsung, boleh bercanda. Plain text pendek, kayak chat biasa — jangan list, jangan formal.
Data kamu saat ini: kontak yang pernah chat = ${contacts}. Kalau Fakrul tanya siapa aja yang chat, jawab dari data ini.`
  if (!history[ADMIN]) history[ADMIN] = []
  history[ADMIN].push({ role: 'user', content: text })
  if (history[ADMIN].length > 20) history[ADMIN] = history[ADMIN].slice(-20)
  const reply = await callAI([{ role: 'system', content: adminPrompt }, ...history[ADMIN]])
  history[ADMIN].push({ role: 'assistant', content: reply })
  if (history[ADMIN].length > 20) history[ADMIN] = history[ADMIN].slice(-20)
  saveHistory()
  updateMemory(ADMIN, text, reply, true)
  return reply
}

// --- WhatsApp client ---
// Diisi di startWhatsApp(). Sebelum itu null — notifyAdmin() sudah jaga-jaga.
let client = null

function startWhatsApp() {
  const { Client, LocalAuth } = require('whatsapp-web.js')
  const qrcode = require('qrcode-terminal')

  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 0 }
  })

  client.on('qr', qr => {
    console.log('Scan QR ini dari WhatsApp:')
    qrcode.generate(qr, { small: true })
  })

  client.on('ready', () => {
    console.log('✅ Bot aktif!')
    console.log(`   Provider: ${PROVIDERS.map(p => p.name).join(', ')}`)
    console.log(`   Jam aktif: ${ACTIVE_HOURS.from}-${ACTIVE_HOURS.to}`)
    console.log(`   SOUL: ${resolveSoulPath() || 'TIDAK ADA (pakai fallback)'}`)
    if (!ADMIN) console.warn('   ⚠️  ADMIN_NUMBER kosong — alert & perintah admin nggak jalan')
  })

  client.on('auth_failure', m => console.error('❌ Auth gagal:', m))
  client.on('disconnected', reason => {
    console.error('⚠️  Terputus dari WhatsApp:', reason)
    console.error('   Restart proses buat konek ulang.')
  })

  client.on('message', onMessage)
  client.initialize()
  return client
}

async function onMessage(msg) {
  if (!msg.body) return

  const chatId = msg.from
  const isGroup = chatId.includes('@g.us')
  // ponytail: resolve actual phone from @lid via getContact, fallback to chatId parse
  const isAdmin = msg.fromMe || chatId === ADMIN

  // Admin bypass semua filter
  if (isAdmin) {
    try { await msg.reply(await handleAdmin(msg)) }
    catch (err) { await msg.reply('Error: ' + err.message) }
    return
  }

  if (msg.fromMe) return

  if (isGroup || paused || msg.body.startsWith('/')) return

  // Jam aktif — di luar jam, bot diem (biar nggak keliatan "online" 24 jam)
  if (!isActiveHour()) {
    console.log(`⏰ Di luar jam aktif, pesan dari ${nameMap[chatId] || shortId(chatId)} dilewati`)
    return
  }

  // Rate limit
  const rateStatus = checkRateLimit(chatId)
  if (rateStatus === 'cooldown') return
  if (rateStatus === 'limited') {
    await msg.reply('Hei, pesan kamu lagi banyak banget. Coba lagi beberapa menit ya!')
    return
  }

  // Burst handling — debounce 2 detik
  handleBurst(chatId, msg.body, (combined) => {
    processMessage(msg, chatId, combined).catch(err => console.error('processMessage error:', err.message))
  })
}

// Jangan biarin satu promise nyangkut membunuh proses
process.on('unhandledRejection', err => console.error('unhandledRejection:', err?.message || err))

// Simpan state sebelum mati
function shutdown(sig) {
  console.log(`\n${sig} diterima, menyimpan state...`)
  try { saveHistory() } catch (_) {}
  try { fs.writeFileSync(NAMES_FILE, JSON.stringify(nameMap)) } catch (_) {}
  if (client) client.destroy().catch(() => {}).finally(() => process.exit(0))
  else process.exit(0)
  setTimeout(() => process.exit(0), 5000).unref()
}

// Cuma konek ke WhatsApp kalau dijalankan langsung (`node bot.js`).
// Kalau di-require (mis. oleh smoke.js), helper-nya bisa diuji tanpa buka browser.
if (require.main === module) {
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  startWhatsApp()
}

module.exports = {
  shortId, resolveChatId, trimHistory, contains, typingDelay,
  isActiveHour, checkRateLimit, handleBurst,
  loadSoul, loadProfile, loadSystemPrompt, resolveSoulPath,
  history, nameMap, PROVIDERS, ACTIVE_HOURS, HISTORY_CAP,
}
