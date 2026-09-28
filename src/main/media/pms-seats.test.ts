import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dropPmsSeat, mintPmsToken, pmsSeatsPath, readPmsSeat, writePmsSeat } from './pms-seats.ts'
import type { SafeStorageApi } from './device-key.ts'

function memorySafe(): SafeStorageApi {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => true,
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

test('pms_ seats.json stores a sealed token, not plaintext', () => {
  const userData = mkdtempSync(join(tmpdir(), 'pms-seats-'))
  const safe = memorySafe()
  try {
    const token = mintPmsToken()
    assert.equal(token.startsWith('pms_'), true)
    writePmsSeat(userData, { email: 'owner@example.test', role: 'owner', token, mediaBrainId: 'brainid01brainid01brainid' }, safe)
    const disk = readFileSync(pmsSeatsPath(userData), 'utf8')
    assert.equal(disk.includes(token), false)
    const read = readPmsSeat(userData, 'brainid01brainid01brainid', safe)
    assert.equal(read?.token, token)
    dropPmsSeat(userData, 'brainid01brainid01brainid')
    assert.equal(readPmsSeat(userData, 'brainid01brainid01brainid', safe), null)
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})
