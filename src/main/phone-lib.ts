import { randomBytes, timingSafeEqual } from 'node:crypto'

export function mintToken(): string {
  return randomBytes(24).toString('base64url')
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

export function parseTunnelUrl(text: string): string | null {
  const m = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
  return m ? m[0].replace(/\/$/, '').toLowerCase() : null
}

export function phoneUrl(origin: string, token: string): string {
  const base = String(origin || '').replace(/\/$/, '')
  const t = String(token || '')
  if (!base || !t) return ''
  return `${base}/?t=${encodeURIComponent(t)}`
}

export function tokenFromRequest(search: string, authorization: string): string {
  let q = ''
  try {
    const raw = String(search || '')
    const sp = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw)
    q = String(sp.get('t') || '')
  } catch {
    q = ''
  }
  const h = String(authorization || '')
  const bearer = /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, '').trim() : ''
  return q || bearer
}

export function pinChatId(chatIds: string[], current: string, macActive: string): string {
  const ids = Array.isArray(chatIds) ? chatIds.filter(Boolean) : []
  if (ids.includes(current)) return current
  if (ids.includes(macActive)) return macActive
  return ids[0] || ''
}

export function pickChatTab<T extends { id: string; type?: string }>(
  tabs: T[],
  active: string,
  want?: string
): T | null {
  const list = Array.isArray(tabs) ? tabs : []
  if (want) {
    const hit = list.find((t) => t.id === want && t.type === 'chat')
    if (hit) return hit
  }
  const cur = list.find((t) => t.id === active && t.type === 'chat')
  if (cur) return cur
  return list.find((t) => t.type === 'chat') || null
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
