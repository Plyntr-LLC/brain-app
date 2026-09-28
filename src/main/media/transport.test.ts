import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CHUNK_SIZE_MIN } from './crypto.ts'
import { encryptMedia } from './format.ts'
import { writeCipherCache } from './cache.ts'
import { enableDirectoryBucket, putDryObject } from './dry-worker.ts'
import {
  DRY_ONLY,
  R2_REFUSE,
  assertNotR2Url,
  loadMediaV1,
  loadR2Admin,
  startDryMedia
} from './transport.ts'

test('dry-run refuses r2.cloudflarestorage.com URLs', () => {
  assert.throws(
    () => assertNotR2Url('https://abc.r2.cloudflarestorage.com/o/x'),
    (err: Error) => err.message === R2_REFUSE
  )
  assert.doesNotThrow(() => assertNotR2Url('brain-media://3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90'))
})

test('directory bucket is a local folder with bucket_status on', () => {
  const userData = mkdtempSync(join(tmpdir(), 'media-dry-'))
  try {
    const row = enableDirectoryBucket(userData, 'bm-aaaaaaaaaaaaaaaaaaaaaaaa')
    assert.equal(row.bucket_status, 'on')
    assert.equal(row.dir, join(userData, 'media-dry-bucket', 'bm-aaaaaaaaaaaaaaaaaaaaaaaa'))
    const mediaId = '3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90'
    const { object } = encryptMedia({
      plaintext: Buffer.alloc(CHUNK_SIZE_MIN, 3),
      mediaId,
      chunkSize: CHUNK_SIZE_MIN
    })
    const path = putDryObject(userData, row.bucket, `o/${mediaId}`, object)
    assert.equal(readFileSync(path).subarray(0, 8).toString('ascii'), 'BRMEDIA1')
    writeCipherCache(userData, 'media-brain-test-01', mediaId, object)
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('dry-run loads media-v1 in process and never loads r2-admin', async () => {
  const prev = process.env.BRAIN_APP_DRY_RUN
  process.env.BRAIN_APP_DRY_RUN = '1'
  const root = mkdtempSync(join(tmpdir(), 'media-sync-'))
  const userData = mkdtempSync(join(tmpdir(), 'media-ud-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(root, 'src', 'media-v1.js'), 'export const kind = "media-v1"\n')
    writeFileSync(
      join(root, 'src', 'r2-admin.js'),
      'globalThis.__R2_ADMIN_LOADED = true\nexport const kind = "r2-admin"\n'
    )
    const started = await startDryMedia({
      userData,
      bucket: 'bm-bbbbbbbbbbbbbbbbbbbbbbbb',
      syncRoot: root
    })
    assert.equal(started.bucket.bucket_status, 'on')
    assert.equal((started.mediaV1 as { kind: string }).kind, 'media-v1')
    assert.equal((globalThis as { __R2_ADMIN_LOADED?: boolean }).__R2_ADMIN_LOADED, undefined)
    await assert.rejects(loadR2Admin(root), (err: Error) => err.message === 'Dry-run never loads r2-admin.')
    assert.equal((globalThis as { __R2_ADMIN_LOADED?: boolean }).__R2_ADMIN_LOADED, undefined)
    const req = createRequire(import.meta.url)
    const registry = [
      ...Object.keys(req.cache || {}),
      ...Object.keys((req('node:module') as { _cache?: Record<string, unknown> })._cache || {})
    ]
    assert.equal(registry.some((k) => /r2-admin/.test(k)), false)
  } finally {
    if (prev === undefined) delete process.env.BRAIN_APP_DRY_RUN
    else process.env.BRAIN_APP_DRY_RUN = prev
    rmSync(root, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  }
})

test('media-v1 load refuses when dry-run is off', async () => {
  const prev = process.env.BRAIN_APP_DRY_RUN
  delete process.env.BRAIN_APP_DRY_RUN
  try {
    await assert.rejects(loadMediaV1('/tmp'), (err: Error) => err.message === DRY_ONLY)
  } finally {
    if (prev !== undefined) process.env.BRAIN_APP_DRY_RUN = prev
  }
})
