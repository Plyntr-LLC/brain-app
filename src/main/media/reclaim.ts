import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { PLYNTR_CODE_ALPHABET, PLYNTR_INVITE_LEN } from '../../shared/plyntr-invite.ts'
import { SCRYPT_N, SCRYPT_P, SCRYPT_R, verifyEd25519 } from './keys.ts'
import { mintPmsToken } from './pms-seats.ts'
import {
  memoryMediaStore,
  type MediaBrainRow,
  type MediaCodeRow,
  type MemoryMediaStore
} from './store.ts'
import { reclaimStartHasSecrets, type ReclaimStartOk } from './worker-shapes.ts'

export const RECLAIM_TTL_MS = 10 * 60 * 1000
export const CODE_TTL_MS = 10 * 60 * 1000
export const CODE_RATE_MAX = 8
export const FORBIDDEN = 'forbidden'
export const BAD_CODE = 'bad_code'
export const RATE = 'rate_limited'
export const BAD_EMAIL = 'bad_email'

const sends = new Map<string, number[]>()

export type HttpResult = { status: number; body: Record<string, unknown> }

function now(): number {
  return Date.now()
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}

export function normalizeEmail(raw: string): string {
  return String(raw || '').trim().toLowerCase()
}

function validEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(raw))
}

function mintCode(): string {
  let out = ''
  const bytes = randomBytes(PLYNTR_INVITE_LEN)
  for (let i = 0; i < PLYNTR_INVITE_LEN; i++) out += PLYNTR_CODE_ALPHABET[bytes[i] % PLYNTR_CODE_ALPHABET.length]
  return out
}

function rateOk(email: string): boolean {
  const t = now()
  const prev = (sends.get(email) || []).filter((x) => t - x < CODE_TTL_MS)
  if (prev.length >= CODE_RATE_MAX) {
    sends.set(email, prev)
    return false
  }
  prev.push(t)
  sends.set(email, prev)
  return true
}

export function resetMediaCodeRate(): void {
  sends.clear()
}

function mem(userData: string): MemoryMediaStore {
  return memoryMediaStore(userData)
}

function builderSeat(row: MediaBrainRow, email: string, store: MemoryMediaStore) {
  const want = normalizeEmail(email)
  const seats = store.seats.filter((s) => s.media_brain_id === row.id && s.email === want)
  const devices = store.devices.filter((d) => d.media_brain_id === row.id && d.email.toLowerCase() === want)
  return { seats, devices }
}

function reclaimDenied(row: MediaBrainRow | undefined, email: string, store: MemoryMediaStore): string | null {
  const want = normalizeEmail(email)
  if (!row) return FORBIDDEN
  const { seats, devices } = builderSeat(row, want, store)
  const seat = seats[0]
  const device = devices[0]
  if (!seat && !device && row.created_by_email.toLowerCase() !== want) return FORBIDDEN
  if (seat?.status === 'revoked' || device?.status === 'revoked') return FORBIDDEN
  if (seat?.role === 'project' || device?.seat_kind === 'project') return FORBIDDEN
  if (seat?.role === 'team') return FORBIDDEN
  if (seat?.role === 'owner' || seat?.role === 'scout') return null
  if (row.created_by_email.toLowerCase() === want) return null
  return FORBIDDEN
}

function findBrainForEmail(store: MemoryMediaStore, email: string, mediaBrainId?: string): MediaBrainRow | undefined {
  const id = String(mediaBrainId || '')
  if (id) return store.brains.find((b) => b.id === id && b.status === 'on')
  const want = normalizeEmail(email)
  const seat = store.seats.find((s) => s.email === want && s.status === 'active')
  if (seat) return store.brains.find((b) => b.id === seat.media_brain_id && b.status === 'on')
  const device = store.devices.find((d) => d.email.toLowerCase() === want)
  if (device) return store.brains.find((b) => b.id === device.media_brain_id && b.status === 'on')
  return store.brains.find((b) => b.created_by_email.toLowerCase() === want && b.status === 'on')
}

function consumeCode(store: MemoryMediaStore, email: string, code: string): MediaCodeRow | null {
  const hash = sha256Hex(String(code || '').trim().toUpperCase())
  const want = normalizeEmail(email)
  const row = store.codes.find((c) => c.email === want && c.hash === hash && !c.used && c.expires > now())
  if (!row) return null
  row.used = true
  return row
}

export function postMediaEmailCode(opts: { userData: string; email: string }): HttpResult & { code?: string } {
  const email = normalizeEmail(opts.email)
  if (!validEmail(email)) return { status: 400, body: { error: BAD_EMAIL } }
  if (!rateOk(email)) return { status: 429, body: { error: RATE } }
  const code = mintCode()
  const store = mem(opts.userData)
  store.codes.push({
    id: randomUUID(),
    email,
    hash: sha256Hex(code),
    purpose: 'email',
    media_brain_id: '',
    role: '',
    roots: [],
    expires: now() + CODE_TTL_MS,
    used: false
  })
  return { status: 200, body: { ok: true }, code }
}

function forbiddenNoWrap(): HttpResult {
  return { status: 403, body: { error: FORBIDDEN } }
}

export function postReclaimStart(opts: {
  userData: string
  email: string
  code: string
  devicePublicKey: string
  mediaBrainId?: string
}): HttpResult {
  const email = normalizeEmail(opts.email)
  const store = mem(opts.userData)
  const codeRow = consumeCode(store, email, opts.code)
  if (!codeRow) return { status: 401, body: { error: BAD_CODE } }
  const row = findBrainForEmail(store, email, opts.mediaBrainId)
  const why = reclaimDenied(row, email, store)
  if (why || !row) return forbiddenNoWrap()
  const pub = String(opts.devicePublicKey || '').replace(/^0x/, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(pub)) return { status: 400, body: { error: 'bad_device' } }
  const challenge = randomBytes(32).toString('hex')
  const token = `mrc_${randomBytes(18).toString('hex')}`
  store.reclaims.push({
    token,
    email,
    media_brain_id: row.id,
    device_pub: pub,
    challenge,
    expires: now() + RECLAIM_TTL_MS,
    used: false
  })
  const body: ReclaimStartOk = {
    salt: row.passphrase_salt,
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    passphrase_wrap: row.passphrase_wrap,
    recovery_wrap: row.recovery_wrap,
    challenge,
    token,
    media_brain_id: row.id,
    brain_key_version: row.brain_key_version
  }
  if (reclaimStartHasSecrets(body)) return { status: 500, body: { error: 'refused' } }
  return { status: 200, body: { ...body } }
}

export function proofKindForSignature(opts: {
  row: MediaBrainRow
  challenge: Buffer
  signature: Buffer
}): 'passphrase' | 'recovery' | null {
  const passPub = Buffer.from(String(opts.row.passphrase_proof || ''), 'hex')
  const recPub = Buffer.from(String(opts.row.recovery_proof || ''), 'hex')
  if (passPub.length === 32 && verifyEd25519(passPub, opts.challenge, opts.signature)) return 'passphrase'
  if (recPub.length === 32 && verifyEd25519(recPub, opts.challenge, opts.signature)) return 'recovery'
  return null
}

export function postReclaimFinish(opts: {
  userData: string
  token: string
  signature: string
  kind?: string
  devicePublicKey: string
  deviceId?: string
  wrap?: { eph_pub: string; nonce: string; ciphertext: string }
  scopeWraps?: Array<{ scope: string; key_version: number; eph_pub: string; nonce: string; ciphertext: string }>
  emailHasPbt?: boolean
}): HttpResult & { seatToken?: string } {
  const store = mem(opts.userData)
  const tok = String(opts.token || '')
  const rec = store.reclaims.find((r) => r.token === tok)
  if (!rec) return forbiddenNoWrap()
  if (rec.used || rec.expires <= now()) {
    rec.used = true
    return forbiddenNoWrap()
  }
  rec.used = true
  const pub = String(opts.devicePublicKey || '').replace(/^0x/, '').toLowerCase()
  if (pub !== rec.device_pub) return forbiddenNoWrap()
  const row = store.brains.find((b) => b.id === rec.media_brain_id && b.status === 'on')
  if (!row) return forbiddenNoWrap()
  let sig: Buffer
  try {
    sig = Buffer.from(String(opts.signature || ''), 'hex')
  } catch {
    return forbiddenNoWrap()
  }
  const kind = proofKindForSignature({
    row,
    challenge: Buffer.from(rec.challenge, 'hex'),
    signature: sig
  })
  if (!kind) return forbiddenNoWrap()
  if (opts.kind && opts.kind !== kind && opts.kind !== 'passphrase' && opts.kind !== 'recovery') {
    return forbiddenNoWrap()
  }
  const wrap = opts.wrap
  if (!wrap?.eph_pub || !wrap.nonce || !wrap.ciphertext) return forbiddenNoWrap()
  const pubId = String(opts.deviceId || '').trim()
  const existing = store.devices.find((d) => d.media_brain_id === row.id && d.public_key === pub)
  const deviceId = existing?.id || pubId || randomUUID()
  if (!existing) {
    store.devices.push({
      id: deviceId,
      media_brain_id: row.id,
      email: rec.email,
      fingerprint: deviceId,
      public_key: pub,
      seat_kind: 'full',
      seat_id: deviceId,
      roots: [],
      status: 'approved'
    })
  } else {
    existing.status = 'approved'
    existing.public_key = pub
    existing.seat_kind = 'full'
  }
  store.wraps = store.wraps.filter(
    (w) => !(w.media_brain_id === row.id && w.device_id === (existing?.id || deviceId) && w.scope === 'brain')
  )
  store.wraps.push({
    id: randomUUID(),
    media_brain_id: row.id,
    scope: 'brain',
    key_version: row.brain_key_version,
    target: 'device',
    device_id: existing?.id || deviceId,
    eph_pub: wrap.eph_pub,
    nonce: wrap.nonce,
    ciphertext: wrap.ciphertext
  })
  for (const sw of opts.scopeWraps || []) {
    store.wraps.push({
      id: randomUUID(),
      media_brain_id: row.id,
      scope: sw.scope,
      key_version: sw.key_version,
      target: 'device',
      device_id: existing?.id || deviceId,
      eph_pub: sw.eph_pub,
      nonce: sw.nonce,
      ciphertext: sw.ciphertext
    })
  }
  let seat = store.seats.find((s) => s.media_brain_id === row.id && s.email === rec.email && s.status === 'active')
  if (!seat) {
    seat = {
      id: existing?.id || deviceId,
      media_brain_id: row.id,
      email: rec.email,
      role: 'owner',
      roots: [],
      status: 'active',
      kind: opts.emailHasPbt ? 'pbt' : 'pms'
    }
    store.seats.push(seat)
  }
  const seatToken = opts.emailHasPbt ? `pbt_${randomBytes(18).toString('hex')}` : mintPmsToken()
  return {
    status: 200,
    body: {
      ok: true,
      device_id: existing?.id || deviceId,
      media_brain_id: row.id,
      role: 'owner'
    },
    seatToken
  }
}

export function signedPayload(kind: 'wrap-passphrase' | 'rotate' | 'revoke', row: MediaBrainRow, extra = ''): Buffer {
  return Buffer.from(`${kind}|${row.id}|${row.brain_key_version}|${extra}`, 'utf8')
}

export function postWrapPassphrase(opts: {
  userData: string
  mediaBrainId: string
  signature?: string
  kind?: string
  wrap?: string
  proofPublicKey?: string
  salt?: string
  N?: number
  r?: number
  p?: number
  email?: string
  code?: string
}): HttpResult {
  const store = mem(opts.userData)
  const row = store.brains.find((b) => b.id === opts.mediaBrainId && b.status === 'on')
  if (!row) return forbiddenNoWrap()
  if (opts.email && opts.code && !opts.signature) return forbiddenNoWrap()
  if (!opts.signature || !opts.wrap || !opts.proofPublicKey || !opts.salt) return forbiddenNoWrap()
  let sig: Buffer
  try {
    sig = Buffer.from(opts.signature, 'hex')
  } catch {
    return forbiddenNoWrap()
  }
  const data = signedPayload('wrap-passphrase', row)
  const passPub = Buffer.from(row.passphrase_proof, 'hex')
  const recPub = Buffer.from(row.recovery_proof, 'hex')
  const okPass = passPub.length === 32 && verifyEd25519(passPub, data, sig)
  const okRec = recPub.length === 32 && verifyEd25519(recPub, data, sig)
  if (!okPass && !okRec) return forbiddenNoWrap()
  if (opts.kind === 'brain') return forbiddenNoWrap()
  const prevPass = row.passphrase_wrap
  const prevRec = row.recovery_wrap
  row.passphrase_wrap = String(opts.wrap)
  row.passphrase_salt = String(opts.salt)
  row.passphrase_proof = String(opts.proofPublicKey)
  if (prevRec !== row.recovery_wrap || prevPass === row.passphrase_wrap) {
    /* recovery wrap stays */
  }
  row.recovery_wrap = prevRec
  return { status: 200, body: { ok: true } }
}

export function refuseBrainKeyProof(opts: {
  userData: string
  mediaBrainId: string
  signature: string
  kind: 'wrap-passphrase' | 'rotate' | 'revoke'
  extra?: string
}): HttpResult {
  const store = mem(opts.userData)
  const row = store.brains.find((b) => b.id === opts.mediaBrainId && b.status === 'on')
  if (!row) return forbiddenNoWrap()
  let sig: Buffer
  try {
    sig = Buffer.from(opts.signature, 'hex')
  } catch {
    return forbiddenNoWrap()
  }
  const data = signedPayload(opts.kind, row, opts.extra || '')
  const passPub = Buffer.from(row.passphrase_proof, 'hex')
  const recPub = Buffer.from(row.recovery_proof, 'hex')
  const okPass = passPub.length === 32 && verifyEd25519(passPub, data, sig)
  const okRec = recPub.length === 32 && verifyEd25519(recPub, data, sig)
  if (!okPass && !okRec) return forbiddenNoWrap()
  return { status: 200, body: { ok: true } }
}

export function postMediaInvite(opts: {
  userData: string
  mediaBrainId: string
  email: string
  role?: string
  roots?: string[]
  builderRole: string
  pmsBrain: boolean
}): HttpResult & { code?: string } {
  if (!opts.pmsBrain) return forbiddenNoWrap()
  if (opts.builderRole !== 'owner' && opts.builderRole !== 'scout') return forbiddenNoWrap()
  const email = normalizeEmail(opts.email)
  if (!validEmail(email)) return { status: 400, body: { error: BAD_EMAIL } }
  const store = mem(opts.userData)
  const row = store.brains.find((b) => b.id === opts.mediaBrainId && b.status === 'on')
  if (!row) return { status: 404, body: { error: 'not_found' } }
  const code = mintCode()
  store.invites.push({
    id: randomUUID(),
    media_brain_id: row.id,
    email,
    role: String(opts.role || 'team'),
    roots: opts.roots || [],
    hash: sha256Hex(code),
    status: 'pending',
    expires: now() + 7 * 24 * 3600 * 1000
  })
  store.codes.push({
    id: randomUUID(),
    email,
    hash: sha256Hex(code),
    purpose: 'invite',
    media_brain_id: row.id,
    role: String(opts.role || 'team'),
    roots: opts.roots || [],
    expires: now() + 7 * 24 * 3600 * 1000,
    used: false
  })
  return { status: 200, body: { ok: true }, code }
}

export function postMediaInviteRedeem(opts: {
  userData: string
  email: string
  code: string
}): HttpResult & { seatToken?: string } {
  const store = mem(opts.userData)
  const email = normalizeEmail(opts.email)
  const hash = sha256Hex(String(opts.code || '').trim().toUpperCase())
  const invite = store.invites.find((i) => i.email === email && i.hash === hash)
  if (!invite || invite.status !== 'pending' || invite.expires <= now()) {
    return { status: 410, body: { error: 'used' } }
  }
  invite.status = 'used'
  const seatToken = mintPmsToken()
  store.seats.push({
    id: randomUUID(),
    media_brain_id: invite.media_brain_id,
    email,
    role: invite.role,
    roots: invite.roots,
    status: 'active',
    kind: 'pms'
  })
  return {
    status: 200,
    body: { ok: true, media_brain_id: invite.media_brain_id, role: invite.role },
    seatToken
  }
}

export function wrapBytesSnapshot(row: MediaBrainRow): { passphrase: string; recovery: string } {
  return { passphrase: row.passphrase_wrap, recovery: row.recovery_wrap }
}
