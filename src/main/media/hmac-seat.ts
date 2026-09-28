import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const HMAC_KIND = 'client-project'
export const HMAC_SEAT_FILE = 'hmac-seat.json'
export const PBT_ON_PROJECT = 'Project devices must use an HMAC seat token.'

export type ProjectHmacPayload = {
  seat_id: string
  email: string
  hq_repo: string
  device_id: string
  kind: typeof HMAC_KIND
  roots: string[]
  iat: number
  exp: number
}

export type StoredHmacSeat = {
  token: string
  email: string
  roots: string[]
  hq_repo: string
  seat_id: string
}

function seatSecret(): string {
  return String(process.env.BRAIN_SYNC_SEAT_TOKEN_KEY || 'dry-media-seat-key')
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

export function assertHmacProjectToken(token: string): string {
  const raw = String(token || '')
  if (raw.startsWith('pbt_') || raw.startsWith('pms_')) throw new Error(PBT_ON_PROJECT)
  if (!raw.includes('.')) throw new Error(PBT_ON_PROJECT)
  return raw
}

export function mintProjectHmacToken(opts: {
  seat_id: string
  email: string
  hq_repo: string
  device_id: string
  roots: string[]
  now?: number
}): string {
  const iat = Math.floor((opts.now || Date.now()) / 1000)
  // Same fields as brain-sync tokens.js issueSeatPayload, plus roots (plan §17).
  const payload: ProjectHmacPayload = {
    seat_id: String(opts.seat_id || ''),
    email: String(opts.email || '').trim().toLowerCase(),
    hq_repo: String(opts.hq_repo || ''),
    device_id: String(opts.device_id || ''),
    kind: HMAC_KIND,
    roots: (opts.roots || []).map(normalizeMediaRoot).filter(Boolean),
    iat,
    exp: iat + 30 * 24 * 3600
  }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = b64url(createHmac('sha256', seatSecret()).update(body).digest())
  return `${body}.${sig}`
}

export function verifyProjectHmacToken(
  token: string,
  now = Date.now()
): { ok: true; payload: ProjectHmacPayload } | { ok: false; reason: string } {
  try {
    assertHmacProjectToken(token)
  } catch {
    return { ok: false, reason: 'pbt' }
  }
  const parts = String(token || '').split('.')
  if (parts.length !== 2) return { ok: false, reason: 'malformed' }
  const [body, sig] = parts
  const expect = b64url(createHmac('sha256', seatSecret()).update(body).digest())
  if (expect.length !== sig.length) return { ok: false, reason: 'bad sig' }
  let diff = 0
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i)
  if (diff !== 0) return { ok: false, reason: 'bad sig' }
  let payload: ProjectHmacPayload
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8')) as ProjectHmacPayload
  } catch {
    return { ok: false, reason: 'bad json' }
  }
  if (payload.kind !== HMAC_KIND) return { ok: false, reason: 'kind' }
  if (payload.exp && now / 1000 > payload.exp) return { ok: false, reason: 'expired' }
  payload.roots = (payload.roots || []).map(normalizeMediaRoot).filter(Boolean)
  payload.email = String(payload.email || '').trim().toLowerCase()
  return { ok: true, payload }
}

export function normalizeMediaRoot(raw: string): string {
  let s = String(raw || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
  if (!s) return ''
  if (!s.startsWith('projects/') && !s.startsWith('clients/')) s = `projects/${s}`
  return `${s}/`
}

export function hmacSeatPath(userData: string): string {
  return join(userData, 'media', HMAC_SEAT_FILE)
}

export function readHmacSeat(userData: string): StoredHmacSeat | null {
  const path = hmacSeatPath(userData)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as StoredHmacSeat
    if (!raw || typeof raw.token !== 'string') return null
    return raw
  } catch {
    return null
  }
}

export function writeHmacSeat(userData: string, seat: StoredHmacSeat): void {
  const path = hmacSeatPath(userData)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(seat))
}

export function rootsOverlap(have: string[], need: string): boolean {
  const root = normalizeMediaRoot(need)
  return (have || []).some((r) => {
    const n = normalizeMediaRoot(r)
    return n === root || root.startsWith(n)
  })
}
