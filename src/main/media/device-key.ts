import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { crockfordFromBytes, exportX25519Public } from './keys.ts'

export const SAFE_STORAGE_FAIL = "This Mac can't keep the storage key safe, so storage stays off here."

export type SafeStorageApi = {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export type DeviceKey = {
  publicKey: Buffer
  fingerprint: string
  privateKey: KeyObject
}

function assertBrainId(id: string): string {
  const s = String(id || '')
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(s)) throw new Error('Bad media brain id.')
  return s
}

export function deviceKeyPath(userData: string, mediaBrainId: string): string {
  return join(userData, 'media', assertBrainId(mediaBrainId), 'device.key')
}

export function deviceFingerprint(publicKey: Buffer): string {
  const digest = createHash('sha256').update(publicKey).digest()
  const chars = crockfordFromBytes(digest, 8)
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`
}

function refuseUnsafe(safe: SafeStorageApi): void {
  if (!safe || typeof safe.isEncryptionAvailable !== 'function' || !safe.isEncryptionAvailable()) {
    throw new Error(SAFE_STORAGE_FAIL)
  }
}

export function createDeviceKey(safe: SafeStorageApi): DeviceKey {
  refuseUnsafe(safe)
  const pair = generateKeyPairSync('x25519')
  const publicKey = exportX25519Public(pair.publicKey)
  return {
    publicKey,
    fingerprint: deviceFingerprint(publicKey),
    privateKey: pair.privateKey
  }
}

export function sealDevicePrivate(privateKey: KeyObject, safe: SafeStorageApi): Buffer {
  refuseUnsafe(safe)
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
  return safe.encryptString(pkcs8.toString('base64'))
}

export function unsealDevicePrivate(sealed: Buffer, safe: SafeStorageApi): KeyObject {
  refuseUnsafe(safe)
  try {
    const b64 = safe.decryptString(sealed)
    const der = Buffer.from(b64, 'base64')
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  } catch {
    throw new Error(SAFE_STORAGE_FAIL)
  }
}

export function saveDeviceKey(userData: string, mediaBrainId: string, key: DeviceKey, safe: SafeStorageApi): void {
  const path = deviceKeyPath(userData, mediaBrainId)
  if (existsSync(path)) throw new Error(SAFE_STORAGE_FAIL)
  mkdirSync(dirname(path), { recursive: true })
  const sealed = sealDevicePrivate(key.privateKey, safe)
  writeFileSync(path, sealed, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* windows */
  }
}

export function loadDeviceKey(userData: string, mediaBrainId: string, safe: SafeStorageApi): DeviceKey | null {
  const path = deviceKeyPath(userData, mediaBrainId)
  if (!existsSync(path)) return null
  refuseUnsafe(safe)
  // An existing file that will not open is still the only copy of the wrap target. Never report it as missing.
  try {
    const privateKey = unsealDevicePrivate(readFileSync(path), safe)
    const publicKey = exportX25519Public(createPublicKey(privateKey))
    return { publicKey, fingerprint: deviceFingerprint(publicKey), privateKey }
  } catch {
    throw new Error(SAFE_STORAGE_FAIL)
  }
}

/** Creates a key only when device.key is missing. An unreadable file throws SAFE_STORAGE_FAIL and is left alone. */
export function ensureDeviceKey(userData: string, mediaBrainId: string, safe: SafeStorageApi): DeviceKey {
  const existing = loadDeviceKey(userData, mediaBrainId, safe)
  if (existing) return existing
  if (existsSync(deviceKeyPath(userData, mediaBrainId))) throw new Error(SAFE_STORAGE_FAIL)
  const created = createDeviceKey(safe)
  saveDeviceKey(userData, mediaBrainId, created, safe)
  return created
}
