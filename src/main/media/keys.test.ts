import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, createPublicKey, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  KEY_UNLOCK_FAIL,
  PASSPHRASE_SHORT_FAIL,
  createBrainKey,
  createRecoveryKey,
  createScopeKey,
  dropKeys,
  exportX25519Public,
  holdKey,
  parseRecoveryKey,
  takeKey,
  unwrapBrainKeyWithPassphrase,
  unwrapBrainKeyWithRecovery,
  unwrapDek,
  unwrapKeyFromDevice,
  wrapBrainKeyWithPassphrase,
  wrapBrainKeyWithRecovery,
  wrapDek,
  wrapKeyToDevice
} from './keys.ts'
import { SAFE_STORAGE_FAIL, ensureDeviceKey, type SafeStorageApi } from './device-key.ts'

function memorySafe(available = true): SafeStorageApi {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => available,
    encryptString(plain: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return Buffer.concat([iv, enc, cipher.getAuthTag()])
    },
    decryptString(buf: Buffer) {
      const iv = buf.subarray(0, 12)
      const tag = buf.subarray(buf.length - 16)
      const data = buf.subarray(12, buf.length - 16)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    }
  }
}

test('DEK wrap opens under the project key and fails with the wrong AAD', () => {
  const dek = randomBytes(32)
  const projectKey = createScopeKey()
  const wrap = wrapDek({
    dek,
    projectKey,
    mediaId: '3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90',
    scopeId: 'scope-a',
    keyVersion: 1
  })
  const back = unwrapDek({
    wrap,
    projectKey,
    mediaId: '3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90',
    scopeId: 'scope-a',
    keyVersion: 1
  })
  assert.equal(Buffer.compare(back, dek), 0)
  assert.throws(
    () =>
      unwrapDek({
        wrap,
        projectKey,
        mediaId: '3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90',
        scopeId: 'scope-a',
        keyVersion: 2
      }),
    (err: Error) => err.message === KEY_UNLOCK_FAIL
  )
})

test('passphrase wrap opens and fails with one wrong character', () => {
  const brainKey = createBrainKey()
  const mediaBrainId = 'media-brain-test-01'
  const passphrase = 'correct horse battery staple'
  const wrap = wrapBrainKeyWithPassphrase({ brainKey, passphrase, mediaBrainId })
  const back = unwrapBrainKeyWithPassphrase({ wrap, passphrase, mediaBrainId })
  assert.equal(Buffer.compare(back, brainKey), 0)
  assert.throws(
    () => unwrapBrainKeyWithPassphrase({ wrap, passphrase: 'correct horse battery staplf', mediaBrainId }),
    (err: Error) => err.message === KEY_UNLOCK_FAIL
  )
  assert.throws(
    () => wrapBrainKeyWithPassphrase({ brainKey, passphrase: 'too-short', mediaBrainId }),
    (err: Error) => err.message === PASSPHRASE_SHORT_FAIL
  )
})

test('recovery key wrap opens and the display parses back', () => {
  const brainKey = createBrainKey()
  const mediaBrainId = 'media-brain-test-01'
  const rec = createRecoveryKey()
  assert.match(rec.display, /^RK1(-[0-9A-HJKMNP-TV-Z]{4}){13}$/)
  assert.equal(Buffer.compare(parseRecoveryKey(rec.display), rec.raw), 0)
  const wrap = wrapBrainKeyWithRecovery({ brainKey, recoveryKey: rec.raw, mediaBrainId })
  const back = unwrapBrainKeyWithRecovery({ wrap, recoveryKey: rec.raw, mediaBrainId })
  assert.equal(Buffer.compare(back, brainKey), 0)
  rec.raw[0] ^= 1
  assert.throws(
    () => unwrapBrainKeyWithRecovery({ wrap, recoveryKey: rec.raw, mediaBrainId }),
    (err: Error) => err.message === KEY_UNLOCK_FAIL
  )
})

test('device key seals, fingerprints as ABCD-EFGH, and wraps a brain key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-dev-'))
  try {
    const safe = memorySafe()
    const key = ensureDeviceKey(dir, 'media-brain-test-01', safe)
    assert.match(key.fingerprint, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    const again = ensureDeviceKey(dir, 'media-brain-test-01', safe)
    assert.equal(again.fingerprint, key.fingerprint)
    assert.equal(Buffer.compare(again.publicKey, key.publicKey), 0)
    const brainKey = createBrainKey()
    const wrapped = wrapKeyToDevice({
      key: brainKey,
      devicePublicKey: key.publicKey,
      mediaBrainId: 'media-brain-test-01',
      scope: 'brain',
      version: 1
    })
    const opened = unwrapKeyFromDevice({
      wrap: wrapped,
      devicePrivateKey: again.privateKey,
      mediaBrainId: 'media-brain-test-01',
      scope: 'brain',
      version: 1
    })
    assert.equal(Buffer.compare(opened, brainKey), 0)
    assert.equal(exportX25519Public(createPublicKey(key.privateKey)).equals(key.publicKey), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('storage refuses when safeStorage is unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-dev-'))
  try {
    assert.throws(
      () => ensureDeviceKey(dir, 'media-brain-test-01', memorySafe(false)),
      (err: Error) => err.message === SAFE_STORAGE_FAIL
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('live key map drops on clear', () => {
  const k = createBrainKey()
  holdKey('brain', k)
  assert.equal(takeKey('brain'), k)
  dropKeys()
  assert.equal(takeKey('brain'), undefined)
})
