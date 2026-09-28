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
  MEDIA_V1_TIP,
  R2_REFUSE,
  SLICE6_MEDIA_PATHS,
  assertNotR2Url,
  loadMediaV1,
  loadR2Admin,
  mediaSyncRoot,
  mediaV1SourceHasSlice6,
  resolveMediaSyncRoot,
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

test('MEDIA_V1_TIP is the Slice 6 worker merge', () => {
  assert.equal(MEDIA_V1_TIP, 'cb25c2b0a58cc5553497cf8f50b1f010f8ba2e62')
  assert.deepEqual([...SLICE6_MEDIA_PATHS], [
    '/v1/media/codes/email',
    '/v1/media/brains',
    '/v1/media/invites',
    '/v1/media/invites/redeem',
    '/v1/media/reclaim/start',
    '/v1/media/reclaim/finish'
  ])
  const src = SLICE6_MEDIA_PATHS.join('\n')
  assert.equal(mediaV1SourceHasSlice6(src), true)
  assert.equal(mediaV1SourceHasSlice6(src.replace('/v1/media/brains', '')), false)
})

test('loadMediaV1 prefers BRAIN_SYNC_ROOT over vendor when media-v1.js is there', async () => {
  const prevDry = process.env.BRAIN_APP_DRY_RUN
  const prevRoot = process.env.BRAIN_SYNC_ROOT
  process.env.BRAIN_APP_DRY_RUN = '1'
  const root = mkdtempSync(join(tmpdir(), 'media-sync-tip-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(
      join(root, 'src', 'media-v1.js'),
      `${SLICE6_MEDIA_PATHS.map((p) => `export const p_${p.replace(/\W/g, '_')} = ${JSON.stringify(p)}`).join('\n')}\nexport const kind = "media-v1"\n`
    )
    process.env.BRAIN_SYNC_ROOT = root
    assert.equal(mediaSyncRoot(), root)
    assert.equal(await resolveMediaSyncRoot(), root)
    const loaded = (await loadMediaV1()) as { kind: string }
    assert.equal(loaded.kind, 'media-v1')
    assert.equal(mediaV1SourceHasSlice6(readFileSync(join(root, 'src', 'media-v1.js'), 'utf8')), true)
  } finally {
    if (prevDry === undefined) delete process.env.BRAIN_APP_DRY_RUN
    else process.env.BRAIN_APP_DRY_RUN = prevDry
    if (prevRoot === undefined) delete process.env.BRAIN_SYNC_ROOT
    else process.env.BRAIN_SYNC_ROOT = prevRoot
    rmSync(root, { recursive: true, force: true })
  }
})
