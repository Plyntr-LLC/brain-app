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
  assert.equal(four.suggest, 'T2')
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

test('T1 with 5 files / 200 lines suggests T2; lockfile suggests null; T2 over its limit suggests T3', () => {
  assert.equal(checkTripwire('T1', [row('a', 40), row('b', 40), row('c', 40), row('d', 40), row('e', 40)]).suggest, 'T2')
  assert.equal(checkTripwire('T1', [row('a.ts', 10), row('yarn.lock', 5)]).suggest, null)
  const eleven = Array.from({ length: 11 }, (_, i) => row(`f${i}.ts`))
  const t2 = checkTripwire('T2', eleven)
  assert.equal(t2.trip, true)
  assert.equal(t2.suggest, 'T3')
  assert.equal(checkTripwire('T2', eleven.slice(0, 10)).trip, false)
})

test('T0 over T1 but inside T2 suggests T2; over T2 suggests T3; over T3 suggests null', () => {
  assert.equal(checkTripwire('T0', [row('a', 100), row('b', 100)]).suggest, 'T2')
  assert.equal(checkTripwire('T0', [row('a', 400), row('b', 400)]).suggest, 'T3')
  assert.equal(checkTripwire('T0', [row('a', 1400), row('b', 1400)]).suggest, null)
})

test('T3 limits: 40 files / 2500 lines; over T3, lockfile, or schema suggests null', () => {
  const forty = Array.from({ length: 40 }, (_, i) => row(`f${i}.ts`, 10))
  assert.equal(checkTripwire('T3', forty).trip, false)
  const over = checkTripwire('T3', [...forty, row('g.ts')])
  assert.equal(over.trip, true)
  assert.equal(over.suggest, null)
  assert.equal(checkTripwire('T3', [row('a.ts', 2501)]).suggest, null)
  assert.equal(checkTripwire('T2', [...forty.slice(0, 12), row('pnpm-lock.yaml')]).suggest, null)
  assert.equal(checkTripwire('T2', [...forty.slice(0, 12), row('prisma/schema.prisma')]).suggest, null)
})
