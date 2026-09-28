import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAGIC } from './format.ts'
import {
  CACHE_LIMIT_BYTES,
  cachePath,
  cipherCacheExists,
  deleteCipherCache,
  evictCipherCache,
  listCipherCaches,
  writeCipherCache
} from './cache.ts'

function fakeCipher(size: number): Buffer {
  const buf = Buffer.alloc(size, 9)
  MAGIC.copy(buf, 0)
  return buf
}

test('cache stores ciphertext only and never writes a plaintext marker', () => {
  const userData = mkdtempSync(join(tmpdir(), 'media-cache-'))
  const brain = 'mediabrain01'
  const id = '3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90'
  try {
    const object = fakeCipher(64)
    const path = writeCipherCache(userData, brain, id, object)
    assert.equal(path, cachePath(userData, brain, id))
    assert.equal(cipherCacheExists(userData, brain, id), true)
    assert.throws(() => writeCipherCache(userData, brain, id, Buffer.from('PLAINTEXT-MARKER-7f3c')), (err: Error) =>
      err.message.includes('ciphertext')
    )
    deleteCipherCache(userData, brain, id)
    assert.equal(cipherCacheExists(userData, brain, id), false)
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('LRU evicts oldest cache files across brains until under the limit', () => {
  const userData = mkdtempSync(join(tmpdir(), 'media-lru-'))
  try {
    const a = writeCipherCache(userData, 'brainone01', '3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90', fakeCipher(80))
    const b = writeCipherCache(userData, 'brainone01', '4f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90', fakeCipher(80))
    const c = writeCipherCache(userData, 'braintwo02', '5f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90', fakeCipher(80))
    const old = new Date('2020-01-01T00:00:00Z')
    const mid = new Date('2021-01-01T00:00:00Z')
    const neu = new Date('2022-01-01T00:00:00Z')
    utimesSync(a, old, old)
    utimesSync(b, mid, mid)
    utimesSync(c, neu, neu)
    evictCipherCache(userData, { limitBytes: 100, keepPath: c })
    assert.equal(cipherCacheExists(userData, 'brainone01', '3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90'), false)
    assert.equal(cipherCacheExists(userData, 'braintwo02', '5f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90'), true)
    assert.ok(CACHE_LIMIT_BYTES >= 20 * 1024 * 1024 * 1024)
    assert.ok(listCipherCaches(userData).every((e) => e.path.endsWith('.bin')))
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})
