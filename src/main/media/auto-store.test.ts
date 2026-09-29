import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AUTO_STORE_MIN_BYTES,
  autoStoreQualifies,
  autoStoreRoot,
  autoStoreSkip,
  autoStoreTitle,
  pointerDedupeKey,
  pointerTitleOk,
  scanAutoStore
} from './auto-store.ts'
import { writePointer } from './pointer.ts'

test('root comes from the path', () => {
  assert.equal(autoStoreRoot('projects/foo/bar/baz.mp4'), 'projects/foo/')
  assert.equal(autoStoreRoot('clients/summit/clip.mov'), 'clients/summit/')
  assert.equal(autoStoreRoot('projects/foo'), null)
  assert.equal(autoStoreRoot('projects/clip.mp4'), null)
  assert.equal(autoStoreRoot('notes/clip.mp4'), null)
  assert.equal(autoStoreRoot('clip.mp4'), null)
  assert.equal(autoStoreRoot('projects/.hidden/clip.mp4'), null)
})

test('skip list', () => {
  assert.equal(autoStoreSkip('projects/foo/.git/objects/ab'), true)
  assert.equal(autoStoreSkip('projects/foo/node_modules/x/big.zip'), true)
  assert.equal(autoStoreSkip('projects/foo/.DS_Store'), true)
  assert.equal(autoStoreSkip('projects/foo/media/clip--abcd1234.media.md'), true)
  assert.equal(autoStoreSkip('projects/media-live-check/clip.mp4'), true)
  assert.equal(autoStoreSkip('projects/foo/../bar/clip.mp4'), true)
  assert.equal(autoStoreSkip('projects/foo/clip.mp4'), false)
  assert.equal(autoStoreSkip('clients/summit/deck.pdf'), false)
})

test('media qualifies at any size; other files only when large; brain text never', () => {
  assert.equal(autoStoreQualifies('projects/foo/shot.png', 10), true)
  assert.equal(autoStoreQualifies('projects/foo/a/b/clip.MOV', 10), true)
  assert.equal(autoStoreQualifies('clients/summit/voice.m4a', 10), true)
  assert.equal(autoStoreQualifies('projects/foo/deck.pdf', AUTO_STORE_MIN_BYTES), false)
  assert.equal(autoStoreQualifies('projects/foo/deck.pdf', AUTO_STORE_MIN_BYTES + 1), true)
  assert.equal(autoStoreQualifies('projects/foo/bundle.zip', 5 * 1024 * 1024), true)
  assert.equal(autoStoreQualifies('projects/foo/notes.md', 5 * 1024 * 1024), false)
  assert.equal(autoStoreQualifies('projects/foo/data.csv', 5 * 1024 * 1024), false)
  assert.equal(autoStoreQualifies('notes/clip.mp4', 10), false)
  assert.equal(autoStoreQualifies('projects/media-live-check/clip.mp4', 10), false)
  assert.equal(autoStoreQualifies('projects/foo/empty.png', 0), false)
})

test('title and dedupe key match what liveAdd writes', () => {
  assert.equal(autoStoreTitle('projects/foo/Launch Clip.mp4'), 'Launch Clip')
  assert.equal(pointerDedupeKey('Launch Clip', 12), 'launch-clip|12')
  assert.equal(pointerTitleOk('Launch Clip'), true)
  assert.equal(pointerTitleOk('a'.repeat(48)), false)
})

test('scan finds files, skips pointered, fresh, and outside files', () => {
  const folder = mkdtempSync(join(tmpdir(), 'auto-store-'))
  try {
    const old = new Date(Date.now() - 120_000)
    const put = (rel: string, bytes: number, fresh = false): void => {
      const p = join(folder, ...rel.split('/'))
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, Buffer.alloc(bytes, 1))
      if (!fresh) utimesSync(p, old, old)
    }
    put('projects/foo/bar/big.mp4', 30)
    put('clients/summit/shot.png', 10)
    put('projects/foo/done.mov', 20)
    put('projects/foo/copying.mp4', 20, true)
    put('notes/clip.mp4', 10)
    put('projects/foo/.git/pack.mp4', 10)
    put('projects/foo/small.pdf', 100)
    writePointer({
      folder,
      root: 'projects/foo/',
      fields: {
        brain_media: 1,
        media_id: '11111111-2222-4333-8444-555555555555',
        title: 'done',
        mime: 'video/quicktime',
        bytes: 20,
        added: '2026-09-29'
      }
    })
    const got = scanAutoStore(folder)
    assert.deepEqual(
      got.map((c) => [c.rel, c.root]),
      [
        ['clients/summit/shot.png', 'clients/summit/'],
        ['projects/foo/bar/big.mp4', 'projects/foo/']
      ]
    )
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
