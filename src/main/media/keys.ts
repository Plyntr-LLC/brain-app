import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
  sign,
  verify,
  type KeyObject
} from 'node:crypto'
import { PLYNTR_CODE_ALPHABET } from '../../shared/plyntr-invite.ts'

export const KEY_BYTES = 32
export const SCRYPT_N = 2 ** 17
export const SCRYPT_R = 8
export const SCRYPT_P = 1
export const SCRYPT_SALT_BYTES = 16
export const SCRYPT_MAXMEM = 256 * 1024 * 1024
export const GCM_NONCE_BYTES = 12
export const GCM_TAG_BYTES = 16
export const RECOVERY_CHARS = 52
export const RECOVERY_PREFIX = 'RK1'

export const KEY_UNLOCK_FAIL = 'Could not unlock the storage key.'
export const PASSPHRASE_MEMORY_FAIL = 'This Mac does not have enough free memory to protect the passphrase.'
export const PASSPHRASE_SHORT_FAIL = 'Use at least 16 characters for the passphrase.'

const live = new Map<string, Buffer>()

const ED25519_PKCS8_HEAD = Buffer.from('302e020100300506032b657004220420', 'hex')
const ED25519_SPKI_HEAD = Buffer.from('302a300506032b6570032100', 'hex')
const X25519_SPKI_HEAD = Buffer.from('302a300506032b656e032100', 'hex')

export function crockfordFromBytes(bytes: Buffer, length: number): string {
  const alphabet = PLYNTR_CODE_ALPHABET
  let bits = 0
  let acc = 0
  let out = ''
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += alphabet[(acc >>> bits) & 31]
      if (out.length >= length) return out.slice(0, length)
    }
  }
  if (out.length < length && bits > 0) out += alphabet[(acc << (5 - bits)) & 31]
  return out.slice(0, length)
}

export function crockfordToBytes(text: string, size: number): Buffer {
  const alphabet = PLYNTR_CODE_ALPHABET
  const map: Record<string, number> = {}
  for (let i = 0; i < alphabet.length; i++) map[alphabet[i]] = i
  map.I = 1
  map.L = 1
  map.O = 0
  const clean = String(text || '')
    .toUpperCase()
    .replace(/-/g, '')
    .replace(/^RK1/, '')
  const out = Buffer.alloc(size)
  let bits = 0
  let acc = 0
  let n = 0
  for (const ch of clean) {
    if (!(ch in map)) throw new Error(KEY_UNLOCK_FAIL)
    acc = (acc << 5) | map[ch]
    bits += 5
    if (bits >= 8) {
      bits -= 8
      if (n < size) out[n++] = (acc >>> bits) & 0xff
    }
  }
  if (n !== size) throw new Error(KEY_UNLOCK_FAIL)
  return out
}

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export function holdKey(id: string, key: Buffer): void {
  live.set(id, key)
}

export function takeKey(id: string): Buffer | undefined {
  return live.get(id)
}

export function dropKeys(...ids: string[]): void {
  if (!ids.length) {
    for (const k of live.values()) k.fill(0)
    live.clear()
    return
  }
  for (const id of ids) {
    const k = live.get(id)
    if (k) k.fill(0)
    live.delete(id)
  }
}

export function wrapAad(parts: Array<string | number>): Buffer {
  return Buffer.from(parts.map((p) => String(p)).join('|'), 'utf8')
}

export function aesGcmSeal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(GCM_NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

export function aesGcmOpen(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (!Buffer.isBuffer(sealed) || sealed.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) throw new Error(KEY_UNLOCK_FAIL)
  const nonce = sealed.subarray(0, GCM_NONCE_BYTES)
  const tag = sealed.subarray(sealed.length - GCM_TAG_BYTES)
  const body = sealed.subarray(GCM_NONCE_BYTES, sealed.length - GCM_TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error(KEY_UNLOCK_FAIL)
  }
}

export function wrapDek(opts: {
  dek: Buffer
  projectKey: Buffer
  mediaId: string
  scopeId: string
  keyVersion: number
}): Buffer {
  return aesGcmSeal(opts.projectKey, opts.dek, wrapAad([opts.mediaId, opts.scopeId, opts.keyVersion]))
}

export function unwrapDek(opts: {
  wrap: Buffer
  projectKey: Buffer
  mediaId: string
  scopeId: string
  keyVersion: number
}): Buffer {
  return aesGcmOpen(opts.projectKey, opts.wrap, wrapAad([opts.mediaId, opts.scopeId, opts.keyVersion]))
}

function scryptPassphrase(passphrase: string, salt: Buffer): Buffer {
  try {
    return scryptSync(passphrase, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM
    })
  } catch (err) {
    const code = (err as { code?: string }).code || ''
    if (code === 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' || /memory/i.test(String(err))) {
      throw new Error(PASSPHRASE_MEMORY_FAIL)
    }
    throw err
  }
}

export function passphraseIkm(passphrase: string, salt: Buffer): Buffer {
  return scryptPassphrase(passphrase, salt)
}

export function hkdfBytes(ikm: Buffer, info: string, length: number, salt: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length))
}

function ed25519PublicFromSeed(seed: Buffer): Buffer {
  const pkcs8 = Buffer.concat([ED25519_PKCS8_HEAD, seed])
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  const pub = createPublicKey(priv)
  const spki = pub.export({ type: 'spki', format: 'der' }) as Buffer
  return Buffer.from(spki.subarray(spki.length - KEY_BYTES))
}

function ed25519PrivateFromSeed(seed: Buffer): KeyObject {
  const pkcs8 = Buffer.concat([ED25519_PKCS8_HEAD, seed])
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
}

export type ProofSplit = { wrapKey: Buffer; publicKey: Buffer }

export function splitProof(ikm: Buffer, info: string): ProofSplit {
  const material = hkdfBytes(ikm, info, 64)
  const wrapKey = Buffer.from(material.subarray(0, KEY_BYTES))
  const seed = Buffer.from(material.subarray(KEY_BYTES, 64))
  const publicKey = ed25519PublicFromSeed(seed)
  seed.fill(0)
  material.fill(0)
  return { wrapKey, publicKey }
}

export function signWithProof(ikm: Buffer, info: string, data: Buffer): Buffer {
  const material = hkdfBytes(ikm, info, 64)
  const seed = Buffer.from(material.subarray(KEY_BYTES, 64))
  material.fill(0)
  const priv = ed25519PrivateFromSeed(seed)
  seed.fill(0)
  return sign(null, data, priv)
}

export function signWithSeed(seed: Buffer, data: Buffer): Buffer {
  return sign(null, data, ed25519PrivateFromSeed(seed))
}

export function verifyEd25519(publicKey: Buffer, data: Buffer, signature: Buffer): boolean {
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== KEY_BYTES) return false
  if (!Buffer.isBuffer(signature) || !signature.length) return false
  try {
    const pub = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_HEAD, publicKey]),
      format: 'der',
      type: 'spki'
    })
    return verify(null, data, pub, signature)
  } catch {
    return false
  }
}

export const PASSPHRASE_INFO = (mediaBrainId: string): string => `brain-media passphrase v1|${mediaBrainId}`
export const RECOVERY_INFO = (mediaBrainId: string): string => `brain-media recovery v1|${mediaBrainId}`

export type PassphraseWrap = {
  salt: Buffer
  N: number
  r: number
  p: number
  wrap: Buffer
  proofPublicKey: Buffer
}

export function wrapBrainKeyWithPassphrase(opts: {
  brainKey: Buffer
  passphrase: string
  mediaBrainId: string
}): PassphraseWrap {
  const pass = String(opts.passphrase || '')
  if (pass.length < 16) throw new Error(PASSPHRASE_SHORT_FAIL)
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const derived = scryptPassphrase(pass, salt)
  const proof = splitProof(derived, PASSPHRASE_INFO(opts.mediaBrainId))
  derived.fill(0)
  const wrap = aesGcmSeal(proof.wrapKey, opts.brainKey, wrapAad(['brain', opts.mediaBrainId, 'passphrase']))
  proof.wrapKey.fill(0)
  return { salt, N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, wrap, proofPublicKey: proof.publicKey }
}

export function unwrapBrainKeyWithPassphrase(opts: {
  wrap: PassphraseWrap
  passphrase: string
  mediaBrainId: string
}): Buffer {
  const pass = String(opts.passphrase || '')
  if (opts.wrap.N !== SCRYPT_N || opts.wrap.r !== SCRYPT_R || opts.wrap.p !== SCRYPT_P) {
    throw new Error(KEY_UNLOCK_FAIL)
  }
  const derived = scryptPassphrase(pass, opts.wrap.salt)
  const proof = splitProof(derived, PASSPHRASE_INFO(opts.mediaBrainId))
  derived.fill(0)
  try {
    const key = aesGcmOpen(proof.wrapKey, opts.wrap.wrap, wrapAad(['brain', opts.mediaBrainId, 'passphrase']))
    proof.wrapKey.fill(0)
    return key
  } catch {
    proof.wrapKey.fill(0)
    throw new Error(KEY_UNLOCK_FAIL)
  }
}

export function formatRecoveryKey(raw: Buffer): string {
  const chars = crockfordFromBytes(raw, RECOVERY_CHARS)
  const groups: string[] = []
  for (let i = 0; i < chars.length; i += 4) groups.push(chars.slice(i, i + 4))
  return `${RECOVERY_PREFIX}-${groups.join('-')}`
}

export function parseRecoveryKey(display: string): Buffer {
  return crockfordToBytes(display, KEY_BYTES)
}

export function createRecoveryKey(): { raw: Buffer; display: string } {
  const raw = randomKey()
  return { raw, display: formatRecoveryKey(raw) }
}

export type RecoveryWrap = {
  wrap: Buffer
  proofPublicKey: Buffer
}

export function wrapBrainKeyWithRecovery(opts: {
  brainKey: Buffer
  recoveryKey: Buffer
  mediaBrainId: string
}): RecoveryWrap {
  const proof = splitProof(opts.recoveryKey, RECOVERY_INFO(opts.mediaBrainId))
  const wrap = aesGcmSeal(proof.wrapKey, opts.brainKey, wrapAad(['brain', opts.mediaBrainId, 'recovery']))
  proof.wrapKey.fill(0)
  return { wrap, proofPublicKey: proof.publicKey }
}

export function unwrapBrainKeyWithRecovery(opts: {
  wrap: RecoveryWrap
  recoveryKey: Buffer
  mediaBrainId: string
}): Buffer {
  const proof = splitProof(opts.recoveryKey, RECOVERY_INFO(opts.mediaBrainId))
  try {
    const key = aesGcmOpen(proof.wrapKey, opts.wrap.wrap, wrapAad(['brain', opts.mediaBrainId, 'recovery']))
    proof.wrapKey.fill(0)
    return key
  } catch {
    proof.wrapKey.fill(0)
    throw new Error(KEY_UNLOCK_FAIL)
  }
}

export function importX25519Public(raw: Buffer): KeyObject {
  if (!Buffer.isBuffer(raw) || raw.length !== KEY_BYTES) throw new Error(KEY_UNLOCK_FAIL)
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_HEAD, raw]), format: 'der', type: 'spki' })
}

export function exportX25519Public(key: KeyObject): Buffer {
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer
  return Buffer.from(spki.subarray(spki.length - KEY_BYTES))
}

export type DeviceKeyWrap = {
  ephPub: Buffer
  nonce: Buffer
  ciphertext: Buffer
}

export function wrapKeyToDevice(opts: {
  key: Buffer
  devicePublicKey: Buffer
  mediaBrainId: string
  scope: string
  version: number
}): DeviceKeyWrap {
  const eph = generateKeyPairSync('x25519')
  const devicePub = importX25519Public(opts.devicePublicKey)
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: devicePub })
  const ephPub = exportX25519Public(eph.publicKey)
  const info = `brain-media wrap v1|${opts.mediaBrainId}|${opts.scope}|${opts.version}`
  const wrapKey = hkdfBytes(shared, info, KEY_BYTES, Buffer.concat([ephPub, opts.devicePublicKey]))
  shared.fill(0)
  const sealed = aesGcmSeal(wrapKey, opts.key, wrapAad(['device', opts.mediaBrainId, opts.scope, opts.version]))
  wrapKey.fill(0)
  const nonce = Buffer.from(sealed.subarray(0, GCM_NONCE_BYTES))
  const ciphertext = Buffer.from(sealed.subarray(GCM_NONCE_BYTES))
  return { ephPub, nonce, ciphertext }
}

export function unwrapKeyFromDevice(opts: {
  wrap: DeviceKeyWrap
  devicePrivateKey: KeyObject
  mediaBrainId: string
  scope: string
  version: number
}): Buffer {
  const ephPub = importX25519Public(opts.wrap.ephPub)
  const shared = diffieHellman({ privateKey: opts.devicePrivateKey, publicKey: ephPub })
  const devicePub = exportX25519Public(createPublicKey(opts.devicePrivateKey))
  const info = `brain-media wrap v1|${opts.mediaBrainId}|${opts.scope}|${opts.version}`
  const wrapKey = hkdfBytes(shared, info, KEY_BYTES, Buffer.concat([opts.wrap.ephPub, devicePub]))
  shared.fill(0)
  const sealed = Buffer.concat([opts.wrap.nonce, opts.wrap.ciphertext])
  try {
    const key = aesGcmOpen(wrapKey, sealed, wrapAad(['device', opts.mediaBrainId, opts.scope, opts.version]))
    wrapKey.fill(0)
    return key
  } catch {
    wrapKey.fill(0)
    throw new Error(KEY_UNLOCK_FAIL)
  }
}

export function wrapKeyWithBrain(opts: {
  key: Buffer
  brainKey: Buffer
  mediaBrainId: string
  scope: string
  version: number
}): Buffer {
  return aesGcmSeal(opts.brainKey, opts.key, wrapAad(['brain', opts.mediaBrainId, opts.scope, opts.version]))
}

export function unwrapKeyWithBrain(opts: {
  wrap: Buffer
  brainKey: Buffer
  mediaBrainId: string
  scope: string
  version: number
}): Buffer {
  return aesGcmOpen(opts.brainKey, opts.wrap, wrapAad(['brain', opts.mediaBrainId, opts.scope, opts.version]))
}

export function createScopeKey(): Buffer {
  return randomKey()
}
