import type { KeyInput } from '../../shared/desk.ts'

/**
 * Sends one WhatsApp message through Brain's in-app WhatsApp window, the way a person would: search, open the
 * chat whose name matches, type, Enter, then wait until WhatsApp itself marks the new message sent.
 * It never starts a new chat, never guesses between chats, and never sends twice.
 */

export type WhatsAppMessage = { account: string; to: string; body: string }
export type WhatsAppSent = { ok: true; chat: string } | { ok: false; note: string }

/** What the sender needs from the window. The in-app page has all of it. */
export type WhatsAppPage = {
  url: () => string
  goto: (url: string) => Promise<void>
  run: <T>(fn: (...args: any[]) => unknown, ...args: unknown[]) => Promise<T>
  clickAt: (x: number, y: number) => Promise<void>
  typeText: (text: string) => Promise<void>
  key: (ev: KeyInput) => Promise<void>
  pressKey: (key: string) => Promise<void>
}

export const WHATSAPP_URL = 'https://web.whatsapp.com/'
/** The name a refused Enter in WhatsApp's message box carries, so the reply can point at whatsapp_send. */
export const WHATSAPP_BOX = "WhatsApp's message box"

// The anchors wa.cjs uses on the real site. Class names rotate; these have held.
const SEARCH = ['input[aria-label="Search or start a new chat"]', '[data-tab="3"][role="textbox"]', 'div[contenteditable="true"][data-tab="3"]', '[aria-label*="Search"]']
const COMPOSE = ['footer div[contenteditable="true"][data-tab="10"]', 'footer div[contenteditable="true"]', '[aria-label="Type a message"]']
const SELECT_ALL: KeyInput = { key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2, command: 'selectAll' }
const LINE_BREAK: KeyInput = { key: 'Enter', code: 'Enter', modifiers: 8 }

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const spaced = (s: string) => s.replace(/\s+/g, ' ').trim()
const named = (s: string) => spaced(s).toLowerCase()
/** Letters and digits only. WhatsApp shows *bold*, _italic_ and ~strike~ without their marks, and emoji as images. */
export const plainWords = (s: string) => spaced(s.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ')).toLowerCase()

// In-page readers. They run through executeJavaScript, so they use only their arguments and the page's globals.

function pageState(): 'chats' | 'qr' | 'loading' {
  if (document.querySelector('#pane-side')) return 'chats'
  const qr = Array.from(document.querySelectorAll('canvas')).some((c) => {
    const label = c.getAttribute('aria-label') || ''
    const r = c.getBoundingClientRect()
    return /scan|qr/i.test(label) && r.width > 0 && r.height > 0
  })
  return qr ? 'qr' : 'loading'
}

function centreOf(selectors: string[]): { x: number; y: number } | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) continue
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }
  return null
}

function chatNames(): string[] {
  return Array.from(document.querySelectorAll('#pane-side [role="row"]')).map((row) => row.querySelector('span[title]')?.getAttribute('title') || '')
}

function rowCentre(i: number): { x: number; y: number } | null {
  const row = document.querySelectorAll('#pane-side [role="row"]')[i] as HTMLElement | undefined
  if (!row) return null
  row.scrollIntoView({ block: 'center' })
  const r = row.getBoundingClientRect()
  return { x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2 }
}

function chatTitle(): string {
  return document.querySelector('#main header span[title]')?.getAttribute('title') || ''
}

/** WhatsApp draws emoji as images, so a reader takes each image's alt as its text. */
function boxText(selectors: string[]): string | null {
  const text = (n: Node): string =>
    n.nodeType === 3 ? n.textContent || '' : n instanceof HTMLImageElement ? n.alt : n.nodeName === 'BR' ? '\n' : Array.from(n.childNodes).map(text).join('') + (/^(DIV|P)$/.test(n.nodeName) ? '\n' : '')
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLElement | null
    if (el) return text(el)
  }
  return null
}

function messageRows(): { id: string; text: string; labels: string[] }[] {
  const text = (n: Node): string =>
    n.nodeType === 3 ? n.textContent || '' : n instanceof HTMLImageElement ? n.alt : n.nodeName === 'BR' ? '\n' : Array.from(n.childNodes).map(text).join(' ')
  const main = document.querySelector('#main')
  if (!main) return []
  main.querySelectorAll('div').forEach((n) => {
    if (n.scrollHeight > n.clientHeight + 80) n.scrollTop = n.scrollHeight
  })
  return Array.from(main.querySelectorAll('[role="row"]')).map((row) => ({
    id: row.querySelector('[data-id]')?.getAttribute('data-id') || '',
    text: text(row),
    labels: Array.from(row.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label') || '')
  }))
}

/** True when the focus is WhatsApp's message box, where Enter sends. */
export function messageBoxFocused(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && el.isContentEditable && !!el.closest('footer')
}

/** The status WhatsApp gives an outgoing message, read from its labels as wa.cjs reads them. */
export function outgoingState(labels: string[]): 'failed' | 'pending' | 'delivered' | 'read' | 'sent' | 'unknown' {
  const flat = labels.join('\n').toLowerCase()
  if (flat.includes('something went wrong') || flat.includes('not sent')) return 'failed'
  if (flat.includes('pending')) return 'pending'
  if (flat.includes('delivered')) return 'delivered'
  if (flat.includes('read')) return 'read'
  if (/(^|[^a-z])sent([^a-z]|$)/.test(flat)) return 'sent'
  return 'unknown'
}

/** The one row `to` names: an exact name wins, else a single chat whose name contains it. */
export function pickChat(names: string[], to: string): { index: number; name: string } | { note: string } {
  const q = named(to)
  const rows = names.map((name, index) => ({ name, index })).filter((r) => r.name && !/also in this group/i.test(r.name))
  const exact = rows.find((r) => named(r.name) === q)
  if (exact) return exact
  const hits = rows.filter((r) => named(r.name).includes(q))
  const distinct = [...new Set(hits.map((r) => spaced(r.name)))]
  if (distinct.length === 1) return hits[0]
  if (!distinct.length) return { note: `No WhatsApp chat named ${to}.` }
  return { note: `More than one WhatsApp chat matches ${to}: ${distinct.slice(0, 5).join(', ')}. Nothing was sent.` }
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms: number, every = 400): Promise<T> {
  const end = Date.now() + ms
  let v = await read()
  while (!ok(v) && Date.now() < end) {
    await sleep(every)
    v = await read()
  }
  return v
}

async function clear(page: WhatsAppPage) {
  await page.key(SELECT_ALL)
  await page.pressKey('Backspace')
}

/**
 * `stillClear` says nothing is open on top of WhatsApp. It is asked before the chat search, before typing and right before
 * Enter; a pop-up that opens during the send stops it there.
 */
export async function sendOnWhatsApp(
  page: WhatsAppPage,
  msg: WhatsAppMessage,
  limits = { readyMs: 30_000, confirmMs: 20_000 },
  stillClear: () => boolean = () => true
): Promise<WhatsAppSent> {
  const covered = { ok: false as const, note: 'A pop-up opened over WhatsApp during the send. Nothing was sent.' }
  const account = msg.account || 'main'
  const body = msg.body.replace(/\r\n?/g, '\n')
  let onSite = false
  try {
    onSite = new URL(page.url()).hostname === 'web.whatsapp.com'
  } catch {
    onSite = false
  }
  if (!onSite) await page.goto(WHATSAPP_URL)
  const state = await until(() => page.run<string>(pageState), (s) => s !== 'loading', limits.readyMs, 500)
  if (state === 'qr') return { ok: false, note: `WhatsApp ${account} is not linked in Brain. Open it and scan the QR first.` }
  if (state !== 'chats') return { ok: false, note: `WhatsApp ${account} did not finish loading. Nothing was sent.` }

  const search = await page.run<{ x: number; y: number } | null>(centreOf, SEARCH)
  if (!search) return { ok: false, note: "Couldn't find WhatsApp's search box. Nothing was sent." }
  if (!stillClear()) return covered
  await page.clickAt(search.x, search.y)
  await clear(page)
  await page.typeText(msg.to)
  await sleep(1200)
  let last = ''
  const names = await until(
    async () => {
      const now = await page.run<string[]>(chatNames)
      const same = JSON.stringify(now) === last
      last = JSON.stringify(now)
      return { now, same }
    },
    (r) => r.same,
    6000
  ).then((r) => r.now)
  const pick = pickChat(names, msg.to)
  if ('note' in pick) return { ok: false, note: pick.note }

  const at = await page.run<{ x: number; y: number } | null>(rowCentre, pick.index)
  if (!at) return { ok: false, note: `Couldn't open the chat ${pick.name}. Nothing was sent.` }
  await page.clickAt(at.x, at.y)
  const title = await until(() => page.run<string>(chatTitle), (t) => named(t) === named(pick.name), 10_000)
  if (named(title) !== named(pick.name)) return { ok: false, note: `WhatsApp opened ${title || 'no chat'} instead of ${pick.name}. Nothing was sent.` }

  const box = await page.run<{ x: number; y: number } | null>(centreOf, COMPOSE)
  if (!box) return { ok: false, note: `Couldn't find the message box in ${pick.name}. Nothing was sent.` }
  if (!stillClear()) return covered
  await page.clickAt(box.x, box.y)
  await clear(page)
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.key(LINE_BREAK)
    if (lines[i]) await page.typeText(lines[i])
  }
  const typed = await page.run<string | null>(boxText, COMPOSE)
  // The box may draw formatting marks away; the words still have to match, and an empty box never passes.
  const took = typed != null && (spaced(typed) === spaced(body) || (plainWords(body) !== '' && plainWords(typed) === plainWords(body)))
  if (!took) {
    await clear(page)
    return { ok: false, note: "WhatsApp's message box did not take the text. Nothing was sent." }
  }

  const known = new Set((await page.run<{ id: string }[]>(messageRows)).map((r) => r.id).filter(Boolean))
  // Compared as plain words, so a sent *bold* or emoji line still matches. A line of only emoji matches any new row.
  const first = plainWords(body.split('\n').find((l) => plainWords(l)) || '').split(' ').slice(0, 12).join(' ')
  if (!stillClear()) {
    await clear(page)
    return covered
  }
  await page.pressKey('Enter')
  const end = Date.now() + limits.confirmMs
  while (Date.now() < end) {
    await sleep(500)
    for (const row of await page.run<{ id: string; text: string; labels: string[] }[]>(messageRows)) {
      if (!row.id || known.has(row.id) || !plainWords(row.text).includes(first)) continue
      const s = outgoingState(row.labels)
      if (s === 'failed') return { ok: false, note: 'WhatsApp did not send it. It shows in the chat as not sent.' }
      if (s === 'sent' || s === 'delivered' || s === 'read') return { ok: true, chat: pick.name }
    }
  }
  return { ok: false, note: 'WhatsApp did not show it as sent. Check the chat before sending again.' }
}
