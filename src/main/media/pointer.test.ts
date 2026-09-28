import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  POINTER_KEY_FAIL,
  POINTER_SCHEMA_FAIL,
  mediaSlug,
  parsePointer,
  pointerRelPath,
  prettyBytes,
  readPointer,
  serializePointer,
  writePointer,
  type MediaPointer
} from './pointer.ts'

const sample: MediaPointer = {
  brain_media: 1,
  media_id: '3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90',
  title: 'Sermon intro',
  mime: 'video/mp4',
  bytes: 184233112,
  added: '2026-10-02'
}

test('pointer path drops salary payroll private from the slug', () => {
  assert.equal(mediaSlug('Sermon intro'), 'sermon-intro')
  assert.equal(mediaSlug('private payroll salary report'), 'report')
  assert.equal(
    pointerRelPath('projects/bible/', 'Sermon intro', sample.media_id),
    'projects/bible/media/sermon-intro--3f9a1c2b.media.md'
  )
  assert.equal(prettyBytes(184233112), '176 MB')
})

test('writer emits exactly the six schema keys', () => {
  const text = serializePointer(sample)
  assert.match(text, /^---\nbrain_media: 1\nmedia_id: /)
  assert.equal(text.includes('dek'), false)
  assert.equal(text.includes('pbt_'), false)
  const parsed = parsePointer(text)
  assert.deepEqual(parsed, sample)
  assert.equal(text.includes('kept in Plyntr storage'), true)
})

test('reader refuses extra keys', () => {
  const extra = serializePointer(sample).replace('added: 2026-10-02\n', 'added: 2026-10-02\nscope: alpha\n')
  assert.throws(() => parsePointer(extra), (err: Error) => err.message === POINTER_SCHEMA_FAIL)
})

test('writer refuses extra keys and base64-looking key material', () => {
  const extra = { ...sample, dek: 'not-allowed' } as MediaPointer & { dek: string }
  assert.throws(() => serializePointer(extra), (err: Error) => err.message === POINTER_SCHEMA_FAIL)
  assert.throws(
    () => serializePointer({ ...sample, title: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    (err: Error) => err.message === POINTER_KEY_FAIL
  )
  assert.throws(
    () => serializePointer({ ...sample, title: 'token pbt_secret' }),
    (err: Error) => err.message === POINTER_KEY_FAIL
  )
})

test('writePointer lands under root/media and reads back', () => {
  const folder = mkdtempSync(join(tmpdir(), 'media-ptr-'))
  try {
    const { rel, path } = writePointer({ folder, root: 'projects/alpha/', fields: sample })
    assert.equal(rel, 'projects/alpha/media/sermon-intro--3f9a1c2b.media.md')
    const body = readFileSync(path, 'utf8')
    assert.equal(body.startsWith('---\nbrain_media: 1\n'), true)
    assert.deepEqual(readPointer(path), sample)
    assert.equal(/[A-Za-z0-9+/]{40,}/.test(body), false)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
