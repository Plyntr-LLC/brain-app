import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  createDeviceKey,
  deviceKeyPath,
  ensureDeviceKey,
  loadDeviceKey,
  SAFE_STORAGE_FAIL,
  saveDeviceKey,
  type SafeStorageApi
} from './device-key.ts'

const BRAIN = 'a0b5f9811a0da111794c019aca012bef'

const plainSafe: SafeStorageApi = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`ok:${plain}`),
  decryptString: (buf) => {
    const s = buf.toString()
    if (!s.startsWith('ok:')) throw new Error('bad')
    return s.slice(3)
  }
}

const lockedSafe: SafeStorageApi = {
  ...plainSafe,
  decryptString: () => {
    throw new Error('keychain said no')
  }
}

function tmpUserData(): string {
  return mkdtempSync(join(tmpdir(), 'device-key-'))
}

test('missing device.key is created once and then reused', () => {
  const ud = tmpUserData()
  const first = ensureDeviceKey(ud, BRAIN, plainSafe)
  assert.ok(existsSync(deviceKeyPath(ud, BRAIN)))
  const again = ensureDeviceKey(ud, BRAIN, plainSafe)
  assert.equal(again.fingerprint, first.fingerprint)
})

test('garbage device.key is not overwritten by load or ensure', () => {
  const ud = tmpUserData()
  const path = deviceKeyPath(ud, BRAIN)
  mkdirSync(dirname(path), { recursive: true })
  const garbage = Buffer.from('not a sealed key')
  writeFileSync(path, garbage)
  assert.throws(() => loadDeviceKey(ud, BRAIN, plainSafe), { message: SAFE_STORAGE_FAIL })
  assert.throws(() => ensureDeviceKey(ud, BRAIN, plainSafe), { message: SAFE_STORAGE_FAIL })
  assert.deepEqual(readFileSync(path), garbage)
})

test('a real device.key that safe storage cannot open is left in place', () => {
  const ud = tmpUserData()
  const original = ensureDeviceKey(ud, BRAIN, plainSafe)
  const path = deviceKeyPath(ud, BRAIN)
  const before = readFileSync(path)
  assert.throws(() => ensureDeviceKey(ud, BRAIN, lockedSafe), { message: SAFE_STORAGE_FAIL })
  assert.throws(() => saveDeviceKey(ud, BRAIN, createDeviceKey(plainSafe), plainSafe), { message: SAFE_STORAGE_FAIL })
  assert.deepEqual(readFileSync(path), before)
  assert.equal(ensureDeviceKey(ud, BRAIN, plainSafe).fingerprint, original.fingerprint)
})
