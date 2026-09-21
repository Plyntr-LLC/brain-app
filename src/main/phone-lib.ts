import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export const PHONE_TOKEN_MS = 12 * 60 * 60 * 1000
export const PHONE_PAIR_MS = 2 * 60 * 1000

export function mintToken(): string {
  return randomBytes(24).toString('base64url')
}

export function mintPin(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

export function tokenOk(got: string, want: string): boolean {
  const a = Buffer.from(String(got || ''), 'utf8')
  const b = Buffer.from(String(want || ''), 'utf8')
  if (!a.length || !b.length || a.length !== b.length) {
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32))
    return false
  }
  return timingSafeEqual(a, b)
}

export function tokenFresh(at: number, now = Date.now()): boolean {
  const n = Number(at) || 0
  if (n <= 0) return false
  return now - n < PHONE_TOKEN_MS
}

export function parseTunnelUrl(text: string): string | null {
  const m = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
  return m ? m[0].replace(/\/$/, '').toLowerCase() : null
}

export function phonePairUrl(origin: string, p: string): string {
  const base = String(origin || '').replace(/\/$/, '')
  const offer = String(p || '')
  if (!base || !offer) return ''
  return `${base}/#p=${encodeURIComponent(offer)}`
}

export function offerFresh(at: number, now = Date.now()): boolean {
  const n = Number(at) || 0
  if (n <= 0) return false
  return now - n < PHONE_PAIR_MS
}

export function tokenFromCookie(cookie: string): string {
  for (const part of String(cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === 'brain_phone') return decodeURIComponent(rest.join('=') || '')
  }
  return ''
}

export function tokenFromRequest(search: string, authorization: string, cookie = ''): string {
  const h = String(authorization || '')
  const bearer = /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, '').trim() : ''
  if (bearer) return bearer
  return tokenFromCookie(cookie)
}

export function pairFromHash(hash: string): string {
  const raw = String(hash || '').replace(/^#/, '')
  try {
    return String(new URLSearchParams(raw).get('p') || '')
  } catch {
    return ''
  }
}

export function deviceLabel(ua: string, used: string[]): string {
  let base = 'Phone'
  if (/iPhone/i.test(ua)) base = 'iPhone'
  else if (/iPad/i.test(ua)) base = 'iPad'
  else if (/Android/i.test(ua)) base = 'Android'
  const have = new Set(used)
  if (!have.has(base)) return base
  for (let i = 2; i < 40; i++) {
    const n = `${base} ${i}`
    if (!have.has(n)) return n
  }
  return `${base} ${used.length + 1}`
}

export function findDevice<T extends { token: string }>(devices: T[], got: string): T | null {
  const want = String(got || '')
  if (!want) return null
  for (const row of devices || []) {
    if (tokenOk(want, String(row?.token || ''))) return row
  }
  return null
}

export type Sealed = { v: 1; iv: string; tag: string; data: string }

function keyFromToken(token: string): Buffer {
  return createHash('sha256').update(String(token || ''), 'utf8').digest()
}

export function isSealed(raw: unknown): raw is Sealed {
  if (!raw || typeof raw !== 'object') return false
  const row = raw as Sealed
  return row.v === 1 && Boolean(row.iv && row.tag && row.data)
}

export function sealJson(token: string, obj: unknown): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFromToken(token), iv)
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()])
  return {
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: enc.toString('base64url')
  }
}

export function openJson(token: string, sealed: Sealed): unknown {
  if (!isSealed(sealed)) throw new Error('bad')
  const decipher = createDecipheriv('aes-256-gcm', keyFromToken(token), Buffer.from(sealed.iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'))
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64url')), decipher.final()])
  return JSON.parse(pt.toString('utf8'))
}

export function sealBytes(token: string, buf: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFromToken(token), iv)
  const enc = Buffer.concat([cipher.update(buf), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, enc, tag])
}

export function openBytes(token: string, buf: Buffer): Buffer {
  if (!buf || buf.length < 29) throw new Error('bad')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(buf.length - 16)
  const data = buf.subarray(12, buf.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', keyFromToken(token), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

export function rateHit(now: number, stamps: number[], windowMs: number, max: number): { ok: boolean; next: number[] } {
  const next = stamps.filter((t) => now - t < windowMs)
  if (next.length >= max) return { ok: false, next }
  next.push(now)
  return { ok: true, next }
}

export function pinChatId(chatIds: string[], current: string, macActive: string): string {
  const ids = Array.isArray(chatIds) ? chatIds.filter(Boolean) : []
  if (ids.includes(current)) return current
  if (ids.includes(macActive)) return macActive
  return ids[0] || ''
}

export function isPhoneChatTab(t: { type?: string }): boolean {
  if (t.type === 'file' || t.type === 'term') return false
  return t.type === 'chat' || !t.type
}

export function unknownEmptyChats(
  tabs: { id: string; type?: string }[],
  messages: Record<string, { who: string }[] | undefined>,
  knownIds: string[]
): boolean {
  const chats = (tabs || []).filter(isPhoneChatTab)
  if (!chats.length) return true
  const known = new Set(knownIds)
  return chats.every((t) => {
    const list = messages[t.id] || []
    const said = list.some((m) => m.who === 'me' || m.who === 'brain')
    return !said && !known.has(t.id)
  })
}

export function keepPhoneTabs<T extends { id: string }>(
  macTabs: T[],
  liveTabs: T[],
  owned: string[],
  closed: string[]
): T[] {
  const gone = new Set(closed)
  const mine = new Set(owned)
  const seen = new Set<string>()
  const out: T[] = []
  for (const t of macTabs || []) {
    if (!t?.id || gone.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  for (const t of liveTabs || []) {
    if (!t?.id || gone.has(t.id) || seen.has(t.id) || !mine.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out
}

export function pickChatTab<T extends { id: string; type?: string }>(
  tabs: T[],
  active: string,
  want?: string
): T | null {
  const list = Array.isArray(tabs) ? tabs : []
  if (want) {
    const hit = list.find((t) => t.id === want && isPhoneChatTab(t))
    if (hit) return hit
  }
  const cur = list.find((t) => t.id === active && isPhoneChatTab(t))
  if (cur) return cur
  return list.find((t) => isPhoneChatTab(t)) || null
}

export function pendingLanded(
  pending: { tabId: string; text: string; meCount: number } | null,
  messages: Record<string, { who: string; text: string }[] | undefined>
): boolean {
  if (!pending) return true
  const list = messages[pending.tabId] || []
  const n = list.filter((m) => m.who === 'me' && m.text === pending.text).length
  return n > pending.meCount
}

export function chatTransport(kind: string): 'acp' | 'stream-json' | 'app-server' {
  if (kind === 'claude') return 'stream-json'
  if (kind === 'gpt') return 'app-server'
  return 'acp'
}

export type PhoneAttach = { path: string; name: string; mime: string }
export type PhoneQueueItem = { id: string; text: string; names: string[]; files?: PhoneAttach[] }

export function shownPhoneLine(text: string, files?: { name: string }[]): string {
  const line = String(text || '').trim()
  const names = (files || []).map((f) => f.name).filter(Boolean)
  if (!names.length) return line
  return `${line}${line ? '\n' : ''}${names.join(', ')}`
}

export function underDir(root: string, file: string): boolean {
  try {
    const base = realpathSync(resolve(root))
    const real = realpathSync(file)
    if (!statSync(real).isFile()) return false
    const rel = relative(base, real)
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}
