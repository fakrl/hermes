require('dotenv').config()
const { Client, LocalAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode-terminal')
const OpenAI = require('openai')
const fs = require('fs')
const os = require('os')
const path = require('path')

// --- Config ---
const HISTORY_FILE = './history.json'
const QUESTIONS_LOG = './questions_log.md'
const MEMORY_FILE = './memory.md'
const SOUL_PATH = path.join(os.homedir(), '.hermes', 'SOUL.md')
const ADMIN = process.env.ADMIN_NUMBER + '@c.us'
const startTime = Date.now()

// Rate limit: max 10 pesan per 5 menit per user, cooldown 10 menit
const RATE_LIMIT = 10
const RATE_WINDOW = 5 * 60 * 1000
const RATE_COOLDOWN = 10 * 60 * 1000

const PROFANITY = ['anjing', 'bangsat', 'babi', 'kontol', 'memek', 'jancok', 'fuck', 'shit', 'bastard', 'asshole']
const FRUSTRATED_KEYWORDS = ['kecewa', 'lambat', 'lama banget', 'nggak jelas', 'ga jelas', 'payah', 'jelek', 'buruk', 'ribet', 'susah banget', 'nggak bisa', 'gabisa', 'disappointed', 'slow', 'useless', 'zonk']
const PORTFOLIO_KEYWORDS = ['portfolio', 'portofolio', 'project', 'projek', 'github', 'contoh kerja', 'hasil kerja', 'pernah bikin', 'pernah buat', 'lihat hasil', 'lihat kerja']
const PORTFOLIO_LINKS = `\nPortfolio: fakrul.netlify.app\nGitHub: github.com/fakrl\nLinkedIn: linkedin.com/in/fakrl`

// --- State ---
let paused = false
const rateLimitMap = {}   // chatId -> [timestamps]
const cooldownMap = {}    // chatId -> cooldown end timestamp
const burstBuffer = {}    // chatId -> { timer, messages[] }

const ai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})

// --- History ---
const history = fs.existsSync(HISTORY_FILE)
  ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  : {}

const knownContacts = new Set(Object.keys(history))

function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history))
}

function loadSystemPrompt() {
  const base = fs.readFileSync(SOUL_PATH, 'utf8')
  const memory = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8') : ''
  return `${base}\n\n## Catatan Tambahan\n${memory}`
}

// --- Helpers ---
function logQuestion(chatId, question) {
  const line = `- [${new Date().toLocaleString('id-ID')}] ${chatId.replace('@c.us', '')}: ${question}\n`
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
  try { await client.sendMessage(ADMIN, `🤖 Alert:\n${text}`) } catch (_) {}
}

// ponytail: fire-and-forget memory update
async function updateMemory(userMsg, botReply) {
  const currentMemory = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8') : ''
  try {
    const res = await ai.chat.completions.create({
      model: process.env.MODEL,
      messages: [{ role: 'user', content: `Percakapan:\nUser: ${userMsg}\nBot: ${botReply}\n\nMemory ada:\n${currentMemory}\n\nAda info baru yang berguna? Tulis SATU baris dimulai "- ". Kalau tidak ada/sudah ada: SKIP` }]
    })
    const extracted = res.choices[0].message.content.trim()
    if (!extracted.startsWith('SKIP') && extracted.startsWith('- ')) {
      fs.appendFileSync(MEMORY_FILE, `\n${extracted}`)
      console.log('Memory updated:', extracted)
    }
  } catch (_) {}
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
    notifyAdmin(`⚠️ Rate limit: ${chatId.replace('@c.us', '')} dikirim ke cooldown 10 menit`)
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
    notifyAdmin(`👤 Kontak baru: ${chatId.replace('@c.us', '')}\nPesan: "${text}"`)
  }

  // Profanity check
  if (contains(text, PROFANITY)) {
    const chat = await msg.getChat()
    await chat.sendSeen()
    await chat.sendStateTyping()
    await new Promise(r => setTimeout(r, 1500))
    await chat.clearState()
    await msg.reply('Hei, kita bisa ngobrol dengan baik kok. Ada yang bisa dibantu?')
    notifyAdmin(`🚨 Profanity dari ${chatId.replace('@c.us', '')}: "${text}"`)
    return
  }

  // Frustrated detection
  const isFrustrated = contains(text, FRUSTRATED_KEYWORDS)
  if (isFrustrated) {
    notifyAdmin(`😤 Pesan frustrated dari ${chatId.replace('@c.us', '')}: "${text}"`)
  }

  // History
  if (!history[chatId]) history[chatId] = []
  history[chatId].push({ role: 'user', content: text })
  if (history[chatId].length > 50) history[chatId].shift()
  saveHistory()
  logQuestion(chatId, text)

  // Build system prompt — lebih empati kalau frustrated
  const extra = isFrustrated
    ? '\n\nCATATAN: User ini terlihat frustrasi. Prioritaskan empati, akui perasaannya dulu sebelum kasih solusi. Jangan defensif.'
    : ''
  const systemPrompt = loadSystemPrompt() + extra

  // Typing indicator
  const chat = await msg.getChat()
  await chat.sendSeen()
  await chat.sendStateTyping()

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await ai.chat.completions.create({
        model: process.env.MODEL,
        messages: [{ role: 'system', content: systemPrompt }, ...history[chatId]],
      })
      let reply = res.choices[0].message.content

      // Portfolio trigger
      if (contains(text, PORTFOLIO_KEYWORDS)) {
        reply += PORTFOLIO_LINKS
      }

      // Proportional delay based on reply length
      await new Promise(r => setTimeout(r, typingDelay(reply.length)))
      await chat.clearState()

      history[chatId].push({ role: 'assistant', content: reply })
      saveHistory()
      await msg.reply(reply)
      updateMemory(text, reply)
      break
    } catch (err) {
      if (err.status === 429 && attempt < 2) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 5000))
      } else {
        await chat.clearState()
        console.error('API error:', err.message)
        break
      }
    }
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
    return `Status bot:\n- Uptime: ${uptime} menit\n- Mode: ${paused ? '⏸ PAUSE' : '▶ AKTIF'}\n- Total chat: ${totalChats}\n- Total pesan: ${totalMsgs}\n- Kontak dikenal: ${knownContacts.size}`
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
    fs.appendFileSync(SOUL_PATH, `\n${args}`)
    return `Personality diupdate:\n${args}`
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
    if (!args) return 'Usage: /clear <nomor>'
    const target = args.replace('+', '') + '@c.us'
    if (!history[target]) return `Tidak ada history untuk ${args}`
    delete history[target]
    knownContacts.delete(target)
    saveHistory()
    return `History ${args} dihapus.`
  }
  if (cmd === '/chat') {
    if (!args) return 'Usage: /chat <nomor>'
    const target = args.replace('+', '') + '@c.us'
    if (!history[target]?.length) return `Tidak ada history untuk ${args}`
    return history[target].slice(-10).map(m => `[${m.role}]: ${m.content}`).join('\n\n')
  }
  if (cmd === '/help') {
    return `Perintah admin:\n/status — statistik bot\n/log — 10 pertanyaan terakhir\n/memory — isi memory\n/add <teks> — tambah memory\n/soul <teks> — update personality\n/pause — mode manual\n/resume — aktifkan bot\n/clear <nomor> — hapus history\n/chat <nomor> — lihat riwayat\n/help — daftar perintah`
  }

  // Pesan bebas dari admin
  const res = await ai.chat.completions.create({
    model: process.env.MODEL,
    messages: [
      { role: 'system', content: 'Kamu adalah Hermes, asisten pribadi Fakrul. Ini Fakrul sendiri. Jawab santai dan langsung.' },
      { role: 'user', content: text }
    ]
  })
  return res.choices[0].message.content
}

// --- WhatsApp client ---
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox'], protocolTimeout: 60000 }
})

client.on('qr', qr => {
  console.log('Scan QR ini dari WhatsApp:')
  qrcode.generate(qr, { small: true })
})

client.on('ready', () => console.log('✅ Bot aktif!'))

client.on('message', async msg => {
  if (msg.fromMe || !msg.body) return

  const chatId = msg.from
  const isGroup = chatId.includes('@g.us')
  const isAdmin = chatId === ADMIN

  // Admin bypass semua filter
  if (isAdmin) {
    try { await msg.reply(await handleAdmin(msg)) }
    catch (err) { await msg.reply('Error: ' + err.message) }
    return
  }

  if (isGroup || paused) return

  // Rate limit
  const rateStatus = checkRateLimit(chatId)
  if (rateStatus === 'cooldown') return
  if (rateStatus === 'limited') {
    await msg.reply('Hei, pesan kamu lagi banyak banget. Coba lagi beberapa menit ya!')
    return
  }

  // Burst handling — debounce 2 detik
  handleBurst(chatId, msg.body, (combined) => {
    processMessage(msg, chatId, combined)
  })
})

client.initialize()
