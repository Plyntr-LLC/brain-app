import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chatTransport,
  mintToken,
  parseTunnelUrl,
  phoneUrl,
  pickChatTab,
  pinChatId,
  pendingLanded,
  tokenFromRequest,
  tokenOk
} from './phone-lib.ts'
import { phonePageHtml } from './phone-page.ts'

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

test('phoneUrl puts the token in the query and tokenFromRequest reads it', () => {
  const origin = 'https://random-words-1234.trycloudflare.com'
  const t = 'abc_TOKEN-1'
  const url = phoneUrl(origin, t)
  assert.equal(url, `${origin}/?t=abc_TOKEN-1`)
  const u = new URL(url)
  assert.equal(tokenFromRequest(u.search, ''), t)
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
})

test('phone server binds loopback only and does not log the token', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'phone.ts'), 'utf8')
  assert.match(src, /listen\(0, '127\.0\.0\.1'/)
  assert.equal(/0\.0\.0\.0/.test(src), false)
  assert.equal(/console\.(log|info|debug)\(/.test(src), false)
  assert.match(src, /function applyLiveEvent/)
  assert.match(src, /void \(async \(\) =>/)
  assert.match(src, /pinChatId\(chatIds/)
})
