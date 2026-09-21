import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chatTransport,
  isSealed,
  mintToken,
  openBytes,
  openJson,
  parseTunnelUrl,
  phoneUrl,
  pickChatTab,
  pinChatId,
  pendingLanded,
  PHONE_TOKEN_MS,
  rateHit,
  sealBytes,
  sealJson,
  shownPhoneLine,
  tokenFresh,
  tokenFromHash,
  keyFromHash,
  tokenFromRequest,
  tokenOk,
  underDir
} from './phone-lib.ts'
import { phonePageHtml } from './phone-page.ts'
import { escapeHtml, mdToHtml, phonePaintHtml } from '../shared/md.ts'

test('tokenOk accepts the same token and rejects a miss', () => {
  const t = mintToken()
  assert.equal(t.length > 20, true)
  assert.equal(tokenOk(t, t), true)
  assert.equal(tokenOk('nope', t), false)
  assert.equal(tokenOk('', t), false)
  assert.equal(tokenOk(t, ''), false)
})

test('parseTunnelUrl pulls the trycloudflare host and ignores the rest', () => {
  const log = `INF |  https://random-words-1234.trycloudflare.com                                               |
INF Thank you for trying Cloudflare Tunnel`
  assert.equal(parseTunnelUrl(log), 'https://random-words-1234.trycloudflare.com')
  assert.equal(parseTunnelUrl('no url here'), null)
})

test('phoneUrl puts token and seal key in the hash and APIs only read Bearer', () => {
  const origin = 'https://random-words-1234.trycloudflare.com'
  const t = 'abc_TOKEN-1'
  const k = 'seal_KEY-9'
  const url = phoneUrl(origin, t, k)
  assert.equal(url, `${origin}/#t=abc_TOKEN-1&k=seal_KEY-9`)
  assert.equal(phoneUrl(origin, t), '')
  const u = new URL(url)
  assert.equal(u.search, '')
  assert.equal(tokenFromHash(u.hash), t)
  assert.equal(keyFromHash(u.hash), k)
  assert.equal(tokenFromRequest(u.search, ''), '')
  assert.equal(tokenFromRequest('?t=leaked', ''), '')
  assert.equal(tokenFromRequest('', `Bearer ${t}`), t)
  assert.equal(tokenFromRequest('', ''), '')
})

test('pickChatTab prefers the asked chat, then the active chat, then the first chat', () => {
  const tabs = [
    { id: 'term', type: 'term' },
    { id: 'a', type: 'chat' },
    { id: 'b', type: 'chat' }
  ]
  assert.equal(pickChatTab(tabs, 'a', 'b')?.id, 'b')
  assert.equal(pickChatTab(tabs, 'a')?.id, 'a')
  assert.equal(pickChatTab(tabs, 'term')?.id, 'a')
  assert.equal(pickChatTab(tabs, 'missing', 'nope')?.id, 'a')
  assert.equal(pickChatTab(tabs.filter((t) => t.type !== 'chat'), 'term'), null)
  assert.equal(pickChatTab([], ''), null)
})

test('pinChatId keeps a chat the phone already chose and never sticks on a file or terminal id', () => {
  const chats = ['chat-a', 'chat-b']
  assert.equal(pinChatId(chats, 'chat-b', 'term'), 'chat-b')
  assert.equal(pinChatId(chats, 'term', 'term'), 'chat-a')
  assert.equal(pinChatId(chats, '', 'file-1'), 'chat-a')
  assert.equal(pinChatId(chats, '', 'chat-b'), 'chat-b')
  assert.equal(pinChatId([], 'term', 'term'), '')
})

test('pendingLanded waits for a new me line on that tab, not a repeat already on screen', () => {
  const pending = { tabId: 'a', text: 'ok', meCount: 1 }
  assert.equal(
    pendingLanded(pending, { a: [{ who: 'me', text: 'ok' }], b: [{ who: 'me', text: 'ok' }] }),
    false
  )
  assert.equal(
    pendingLanded(pending, { a: [{ who: 'me', text: 'ok' }, { who: 'me', text: 'ok' }] }),
    true
  )
  assert.equal(pendingLanded(null, {}), true)
})



test('chatTransport follows the CLI kind', () => {
  assert.equal(chatTransport('claude'), 'stream-json')
  assert.equal(chatTransport('gpt'), 'app-server')
  assert.equal(chatTransport('grok'), 'acp')
  assert.equal(chatTransport('cursor'), 'acp')
})

test('phone page uses Schibsted Grotesk and Source Serif 4, never Inter', () => {
  const html = phonePageHtml()
  assert.match(html, /Schibsted Grotesk/)
  assert.match(html, /Source Serif 4/)
  assert.equal(/Inter|Space Grotesk|Geist|Instrument|Archivo|Spline Sans Mono/.test(html), false)
  assert.match(html, /referrer" content="no-referrer"/)
  assert.match(html, /The computer is off or Brain\.app is closed/)
  assert.equal(/EventSource/.test(html), false)
  assert.match(html, /startPoll/)
  assert.match(html, /pullState/)
  assert.match(html, /function pinChatId/)
  assert.match(html, /function pendingLanded/)
  assert.match(html, /pending = \{ tabId: tabId/)
  assert.equal(/pendingSend/.test(html), false)
  assert.equal(/active = s\.active \|\|/.test(html), false)
  assert.match(html, /position: fixed/)
  assert.match(html, /visualViewport/)
  assert.match(html, /grid-template-rows: auto auto minmax\(0, 1fr\) auto/)
  assert.match(html, /grid-row: 1/)
  assert.match(html, /grid-row: 2/)
  assert.match(html, /grid-row: 3/)
  assert.match(html, /grid-row: 4/)
  assert.equal(/\.note\.hidden \{ display: none/.test(html), false)
  assert.match(html, /\.note\.hidden/)
  assert.match(html, /visibility: hidden/)
  assert.match(html, /id="new"/)
  assert.match(html, /id="close"/)
  assert.match(html, /\/api\/tab/)
  assert.match(html, /\/api\/attach/)
  assert.match(html, /\/api\/queue/)
  assert.match(html, /\/api\/stop/)
  assert.match(html, /class="bubble md"/)
  assert.match(html, /think-label/)
  assert.match(html, /mdbody/)
  assert.match(html, /id="queue"/)
  assert.match(html, /id="attach"/)
  assert.equal(/fonts\.googleapis|fonts\.gstatic/.test(html), false)
  assert.match(html, /\/font\/schibsted\.woff2/)
  assert.match(html, /Bearer/)
  assert.match(html, /function seal/)
  assert.match(html, /history\.replaceState/)
  assert.match(html, /pathname \+ location.hash/)
  assert.match(html, /localStorage/)
  assert.equal(/replaceState\(\{\}, '', location\.pathname\)/.test(html), false)
  assert.match(html, /1200 : 4000/)
  assert.match(html, /brain-phone-k/)
  assert.match(html, /encode\(sealSecret\)/)
  assert.match(html, /if \(!m\.html\) continue/)
  assert.equal(/x-file-name/.test(html), false)
  assert.equal(/\?t=/.test(html), false)
})

test('phone paint uses the same markdown as Skin', () => {
  const html = phonePaintHtml('brain', '## Hello\n\n- one\n- two')
  assert.match(html, /<h2>/)
  assert.match(html, /<ul>/)
  assert.equal(phonePaintHtml('me', '<script>x</script>').includes('<script>'), false)
})

test('markdown links cannot break out of href with quotes', () => {
  const html = mdToHtml('[x](https://evil.com" onclick="alert(1)")')
  assert.equal(/onclick="/i.test(html), false)
  assert.match(escapeHtml('"'), /&quot;/)
})

test('shownPhoneLine names attachments like desktop', () => {
  assert.equal(shownPhoneLine('look', [{ name: 'a.pdf' }, { name: 'b.mp3' }]), 'look\na.pdf, b.mp3')
  assert.equal(shownPhoneLine('', [{ name: 'clip.m4a' }]), 'clip.m4a')
  assert.equal(shownPhoneLine('hi', []), 'hi')
})

test('phone server binds loopback only and does not log the token', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'phone.ts'), 'utf8')
  assert.match(src, /listen\(port, '127\.0\.0\.1'/)
  assert.match(src, /--token-file/)
  assert.match(src, /brain-phone\.plyntr\.com/)
  assert.equal(/0\.0\.0\.0/.test(src), false)
  assert.equal(/console\.(log|info|debug)\(/.test(src), false)
  assert.match(src, /function applyLiveEvent/)
  assert.match(src, /void \(async \(\) =>/)
  assert.match(src, /pinChatId\(chatIds/)
  assert.match(src, /\/api\/tab/)
  assert.match(src, /\/api\/attach/)
  assert.match(src, /stashBytes/)
  assert.match(src, /sendPhoneStop/)
  assert.match(src, /forceQueue \|\| isChatBusy/)
  assert.match(src, /saveToken\(mintToken\(\)\)/)
  assert.match(src, /sendSealed/)
  assert.match(src, /currentSealKey/)
  assert.match(src, /phoneUrl\(origin, token, sealKey\)/)
  assert.match(src, /function closeTabFromPhone/)
  assert.match(src, /No chat to close/)
  const closeSrc = src.slice(src.indexOf('function closeTabFromPhone'), src.indexOf('function asFiles'))
  assert.equal(/pickChatTab/.test(closeSrc), false)
  assert.equal(/x-file-name/.test(src), false)
  assert.equal(/text\/event-stream/.test(src), false)
  assert.equal(/sseBroadcast/.test(src), false)
  assert.equal(/\/\?t=/.test(src), false)
  assert.match(src, /stashed\.has\(real\)/)
  assert.match(src, /Those files are not from this Phone session/)
  assert.match(src, /stashed\.clear\(\)/)
  assert.match(src, /clipboard\.writeText\(s\.url\)/)
})

test('underDir only allows real files inside the drop folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-drops-'))
  const inside = join(dir, 'ok.txt')
  writeFileSync(inside, 'x')
  try {
    assert.equal(underDir(dir, inside), true)
    assert.equal(underDir(dir, '/etc/hosts'), false)
    assert.equal(underDir(dir, join(dir, '..', 'nope')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('phone Now routes through sendTextRef and sendText reads busyRef', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../renderer/src/TerminalWorkspace.tsx'),
    'utf8'
  )
  assert.match(src, /await sendTextRef\.current\(item\.text/)
  const sendText = src.slice(src.indexOf('async function sendText'), src.indexOf('sendTextRef.current = sendText'))
  assert.match(sendText, /if \(opts\?\.cancel && busyRef\.current\)/)
  assert.match(sendText, /if \(busyRef\.current && !opts\?\.fromQueue/)
  assert.equal(/if \(opts\?\.cancel && busy\)/.test(sendText), false)
  assert.match(src, /function markBusy/)
})

test('sealJson roundtrips and query tokens are ignored', () => {
  const t = mintToken()
  const sealed = sealJson(t, { hello: 'there', n: 2 })
  assert.equal(isSealed(sealed), true)
  assert.deepEqual(openJson(t, sealed), { hello: 'there', n: 2 })
  const buf = Buffer.from('pdf-bytes')
  assert.deepEqual(openBytes(t, sealBytes(t, buf)), buf)
  const other = mintToken()
  assert.throws(() => openJson(other, sealed))
  assert.equal(tokenFresh(Date.now()), true)
  assert.equal(tokenFresh(Date.now() - PHONE_TOKEN_MS - 1), false)
  const first = rateHit(1000, [], 1000, 2)
  assert.equal(first.ok, true)
  const second = rateHit(1100, first.next, 1000, 2)
  assert.equal(second.ok, true)
  const third = rateHit(1200, second.next, 1000, 2)
  assert.equal(third.ok, false)
})
