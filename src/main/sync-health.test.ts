import assert from 'node:assert/strict'
import test from 'node:test'
import { paintHealth, whenSync } from './sync-health-paint.ts'

test('paintHealth is orange-ok only when the silent agent last synced without error', () => {
  const base = { present: true, label: 'Acme', lastSync: '2026-09-19T12:00:00.000Z', offline: false, error: '' }
  assert.equal(paintHealth(base, false).ok, true)
  assert.match(paintHealth(base, false).line, /last sync/)
  assert.equal(paintHealth({ ...base, offline: true }, false).ok, false)
  assert.match(paintHealth({ ...base, offline: true }, false).line, /offline/)
  assert.equal(paintHealth({ ...base, error: 'GitHub 502' }, false).ok, false)
  assert.match(paintHealth({ ...base, error: 'GitHub 502' }, false).line, /GitHub 502/)
  assert.equal(paintHealth({ ...base, lastSync: '' }, false).ok, false)
  assert.equal(paintHealth({ present: false, label: '', lastSync: '', offline: false, error: '' }, true).ok, true)
  assert.equal(paintHealth({ present: false, label: '', lastSync: '', offline: false, error: '' }, false).ok, false)
})

test('whenSync formats ISO or falls back', () => {
  assert.equal(whenSync(''), 'never')
  assert.equal(whenSync('not-a-date'), 'not-a-date')
  assert.ok(whenSync('2026-09-19T12:00:00.000Z').length > 3)
})
