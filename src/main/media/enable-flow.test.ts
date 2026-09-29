import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CONFLICT_DETAIL, conflictBrainId, reclaimStartOutcome } from './enable-flow.ts'
import { KEY_UNLOCK_FAIL, createBrainKey, unwrapBrainKeyWithPassphrase, wrapBrainKeyWithPassphrase } from './keys.ts'
import { readMediaConfig, removeMediaConfig, writeMediaConfig } from './media-config.ts'

const OLD_ID = 'abcdef0123456789abcdef0123456789'
const NEW_ID = '0123456789abcdef0123456789abcdef'

test('create 409 names the existing brain and asks for a new code plus the original passphrase', () => {
  assert.equal(conflictBrainId({ error: 'exists', id: OLD_ID }, NEW_ID), OLD_ID)
  assert.match(CONFLICT_DETAIL, /new email code/)
  assert.match(CONFLICT_DETAIL, /six-word passphrase/)
})

test('create 409 never keeps the id this Mac just generated or a junk id', () => {
  assert.equal(conflictBrainId({ error: 'exists', id: NEW_ID }, NEW_ID), '')
  assert.equal(conflictBrainId({ error: 'exists' }, NEW_ID), '')
  assert.equal(conflictBrainId({ error: 'exists', id: '../x' }, NEW_ID), '')
  assert.equal(conflictBrainId(null, NEW_ID), '')
})

test('reclaim/start: bad or used code keeps media.json, no brain drops it', () => {
  assert.equal(reclaimStartOutcome(200), 'ok')
  assert.equal(reclaimStartOutcome(401), 'bad_code')
  assert.equal(reclaimStartOutcome(410), 'bad_code')
  assert.equal(reclaimStartOutcome(403), 'no_brain')
  assert.equal(reclaimStartOutcome(500), 'other')
})

test('stale media.json is removed so the next enable creates', () => {
  const folder = mkdtempSync(join(tmpdir(), 'media-stale-'))
  try {
    assert.equal(writeMediaConfig(folder, OLD_ID), true)
    assert.equal(readMediaConfig(folder)?.mediaBrainId, OLD_ID)
    if (reclaimStartOutcome(403) === 'no_brain') removeMediaConfig(folder)
    assert.equal(readMediaConfig(folder), null)
    removeMediaConfig(folder)
    assert.equal(readMediaConfig(folder), null)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('right words under the wrong brain id still fail to unlock', () => {
  const brainKey = createBrainKey()
  const passphrase = 'correct horse battery staple'
  const wrap = wrapBrainKeyWithPassphrase({ brainKey, passphrase, mediaBrainId: OLD_ID })
  assert.equal(Buffer.compare(unwrapBrainKeyWithPassphrase({ wrap, passphrase, mediaBrainId: OLD_ID }), brainKey), 0)
  assert.throws(
    () => unwrapBrainKeyWithPassphrase({ wrap, passphrase, mediaBrainId: NEW_ID }),
    (err: Error) => err.message === KEY_UNLOCK_FAIL
  )
})
