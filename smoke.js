/**
 * Smoke test — nguji logika murni bot.js tanpa konek WhatsApp atau manggil AI.
 * Jalanin: npm run smoke
 *
 * Ini BUKAN pengganti tes beneran. Cuma jaring pengaman biar refactor nggak
 * diam-diam ngerusak resolver chatId, rate limiter, atau loading prompt.
 */
const assert = require('assert')
const bot = require('./bot')

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✔ ${name}`) }
  catch (err) { fail++; console.log(`  ✖ ${name}\n      ${err.message}`) }
}

console.log('\n── shortId ──')
t('buang @c.us', () => assert.strictEqual(bot.shortId('628123@c.us'), '628123'))
t('buang @lid',  () => assert.strictEqual(bot.shortId('148962753433618@lid'), '148962753433618'))
t('buang @g.us', () => assert.strictEqual(bot.shortId('12345@g.us'), '12345'))
t('nomor polos lewat apa adanya', () => assert.strictEqual(bot.shortId('628123'), '628123'))

console.log('\n── resolveChatId ──')
bot.history['628999@c.us'] = [{ role: 'user', content: 'halo' }]
bot.history['777888@lid'] = [{ role: 'user', content: 'hai' }]
bot.nameMap['777888@lid'] = 'Budi'

t('nomor polos → @c.us',  () => assert.strictEqual(bot.resolveChatId('628999'), '628999@c.us'))
t('nomor polos → @lid',   () => assert.strictEqual(bot.resolveChatId('777888'), '777888@lid'))
t('pakai prefix +',       () => assert.strictEqual(bot.resolveChatId('+628999'), '628999@c.us'))
t('chatId lengkap',       () => assert.strictEqual(bot.resolveChatId('777888@lid'), '777888@lid'))
t('cari lewat nama',      () => assert.strictEqual(bot.resolveChatId('budi'), '777888@lid'))
t('nggak ketemu → null',  () => assert.strictEqual(bot.resolveChatId('000000'), null))

console.log('\n── trimHistory ──')
t(`cap di ${bot.HISTORY_CAP}, buang yang paling lama`, () => {
  const id = 'cap@lid'
  bot.history[id] = Array.from({ length: bot.HISTORY_CAP + 12 }, (_, i) => ({ role: 'user', content: String(i) }))
  bot.trimHistory(id)
  assert.strictEqual(bot.history[id].length, bot.HISTORY_CAP)
  assert.strictEqual(bot.history[id].at(-1).content, String(bot.HISTORY_CAP + 11))  // yang terbaru dipertahankan
  delete bot.history[id]
})

console.log('\n── isActiveHour ──')
const at = h => new Date(2026, 0, 1, h, 0, 0)
t('0-24 selalu aktif', () => {
  assert.ok([0, 3, 12, 23].every(h => bot.isActiveHour(at(h))))
})

console.log('\n── contains / typingDelay ──')
t('contains case-insensitive', () => assert.ok(bot.contains('Ini PORTFOLIO ku', ['portfolio'])))
t('contains nggak false-positive', () => assert.ok(!bot.contains('halo', ['portfolio'])))
t('typingDelay naik seiring panjang', () => assert.ok(bot.typingDelay(500) > bot.typingDelay(10)))
t('typingDelay dibatasi 6 detik', () => assert.strictEqual(bot.typingDelay(999999), 6000))

console.log('\n── rate limiter ──')
t(`lolos ${10} pesan lalu kena limit`, () => {
  const id = 'rate@lid'
  for (let i = 0; i < 10; i++) assert.strictEqual(bot.checkRateLimit(id), 'ok', `pesan ke-${i + 1}`)
  assert.strictEqual(bot.checkRateLimit(id), 'limited')
  assert.strictEqual(bot.checkRateLimit(id), 'cooldown')
})

// Burst pakai debounce 2 detik, jadi hasilnya dicek di akhir
let burstCalls = 0, burstOut = null
{
  const id = 'burst@lid'
  const cb = c => { burstCalls++; burstOut = c }
  bot.handleBurst(id, 'satu', cb)
  bot.handleBurst(id, 'dua', cb)
  bot.handleBurst(id, 'tiga', cb)
}

console.log('\n── prompt loading ──')
t('loadSoul selalu balikin teks (fallback kalau file nggak ada)', () => {
  const s = bot.loadSoul()
  assert.ok(typeof s === 'string' && s.length > 50)
})
t('loadProfile baca fakrul_public.json', () => {
  const p = bot.loadProfile()
  assert.ok(p.includes('Fakhrul'), 'nama harus muncul di profil')
  assert.ok(p.includes('Laravel'), 'skill harus muncul di profil')
})
t('loadProfile pakai cache di panggilan kedua', () => {
  assert.strictEqual(bot.loadProfile(), bot.loadProfile())
})
t('do_not_share ikut masuk prompt', () => {
  assert.ok(/JANGAN PERNAH dibocorkan/.test(bot.loadProfile()))
})
t('loadSystemPrompt gabung semua bagian', () => {
  const sp = bot.loadSystemPrompt()
  assert.ok(sp.includes('Data Faktual Fakrul'))
  assert.ok(sp.length > 500)
})

console.log('\n── provider config ──')
t('minimal satu provider terkonfigurasi', () => assert.ok(bot.PROVIDERS.length > 0))
t('tiap provider punya key + model', () => {
  for (const p of bot.PROVIDERS) {
    assert.ok(p.apiKey, `${p.name} tanpa apiKey`)
    assert.ok(p.model, `${p.name} tanpa model`)
  }
})

setTimeout(() => {
  console.log('\n── burst debounce ──')
  t('3 pesan beruntun → 1 callback', () => assert.strictEqual(burstCalls, 1))
  t('isinya digabung pakai newline', () => assert.strictEqual(burstOut, 'satu\ndua\ntiga'))

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} lolos, ${fail} gagal\n`)
  process.exit(fail === 0 ? 0 : 1)
}, 2500)
