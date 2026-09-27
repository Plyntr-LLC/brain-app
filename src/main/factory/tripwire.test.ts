import assert from 'node:assert/strict'
import test from 'node:test'
import { checkTripwire } from './tripwire.ts'

const row = (path: string, added = 1, deleted = 0) => ({ path, added, deleted })

test('T0 with 2 files trips and suggests T1', () => {
  const r = checkTripwire('T0', [row('a.ts'), row('b.ts')])
  assert.equal(r.trip, true)
  assert.equal(r.suggest, 'T1')
})

test('T0 inside limits does not trip', () => {
  assert.equal(checkTripwire('T0', [row('a.ts', 10, 10)]).trip, false)
})

test('T1 over files or lines trips with no tier in the result', () => {
  const four = checkTripwire('T1', [row('a'), row('b'), row('c'), row('d')])
  assert.equal(four.trip, true)
  assert.equal(four.suggest, null)
  assert.equal('tier' in four, false)
  const lines = checkTripwire('T1', [row('a.ts', 100, 51)])
  assert.equal(lines.trip, true)
  assert.equal(checkTripwire('T1', [row('a.ts', 100, 50)]).trip, false)
})

test('lockfile and migration trip even when small', () => {
  assert.equal(checkTripwire('T1', [row('package-lock.json')]).trip, true)
  assert.equal(checkTripwire('T1', [row('migrations/001.sql')]).trip, true)
  assert.equal(checkTripwire('T0', [row('db/migrations/002_add.sql')]).suggest, null)
})
