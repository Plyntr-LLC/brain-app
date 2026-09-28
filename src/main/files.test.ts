import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readSafe } from './files.ts'
import { serializePointer, writePointer, type MediaPointer } from './media/pointer.ts'

const sample: MediaPointer = {
  brain_media: 1,
  media_id: '3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90',
  title: 'Sermon intro',
  mime: 'video/mp4',
  bytes: 184233112,
  added: '2026-10-02'
}

test('readSafe returns kind media for a parseable .media.md pointer', () => {
  const folder = mkdtempSync(join(tmpdir(), 'media-read-'))
  try {
    const { path } = writePointer({ folder, root: 'projects/alpha/', fields: sample })
    const got = readSafe(folder, path)
    assert.equal(got.kind, 'media')
    if (got.kind !== 'media') throw new Error('expected media')
    assert.equal(got.mediaId, sample.media_id)
    assert.equal(got.title, sample.title)
    assert.equal(got.mime, sample.mime)
    assert.equal(got.bytes, sample.bytes)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('readSafe falls back to markdown when .media.md front matter does not parse', () => {
  const folder = mkdtempSync(join(tmpdir(), 'media-read-bad-'))
  try {
    const path = join(folder, 'broken.media.md')
    writeFileSync(path, '# just a note\n')
    const got = readSafe(folder, path)
    assert.equal(got.kind, 'md')
    assert.equal('mediaId' in got, false)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('serializePointer still emits the six keys used by readSafe', () => {
  assert.match(serializePointer(sample), /^---\nbrain_media: 1\n/)
})
