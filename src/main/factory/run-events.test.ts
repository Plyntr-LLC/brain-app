import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunEvent, RunRecord, UsageRow } from '../../shared/factory.ts'
import { EVENT_CAP, nextEvents } from './run-events.ts'

const run = (o: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-events-test',
  title: 't',
  task: 't',
  brainPath: '/brain',
  workRepo: '/work',
  tier: 'T0',
  risk: 'none',
  triage: { size: 'T0', original: 'T0', capped: false, reasons: [] },
  phase: 'build',
  base: 'abc',
  acpTab: 'factory-run-events-test',
  createdAt: 0,
  updatedAt: 0,
  ...o
})

const row = (at: number): UsageRow => ({ phase: 'build', cli: 'grok', model: 'grok-4.7', effort: 'xhigh', inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0, costEq: 0, ms: 5, turns: 1, ok: true, at })
const turnFor = (at: number): RunEvent => ({ at, kind: 'turn', call: at, model: 'grok-4.7', ms: 5, ok: true, files: 0, added: 0, deleted: 0, paths: [] })

test('the newest 300 events stay and the oldest go', () => {
  const full: RunEvent[] = Array.from({ length: EVENT_CAP }, (_, i) => ({ at: i, kind: 'hold', hold: 'paused', text: `e${i}` }))
  const prev = run({ events: full })
  const next = run({ events: full, commitSha: 'feedbeef' })
  const out = nextEvents(prev, next, 999)
  assert.equal(out.length, EVENT_CAP)
  assert.deepEqual(out[0], full[1])
  assert.deepEqual(out[EVENT_CAP - 1], { at: 999, kind: 'commit', sha: 'feedbeef' })
})

test('a capped usage list matches builder turns by at, never by count or position', () => {
  const rows = Array.from({ length: 200 }, (_, i) => row(i + 1))
  const told = rows.map((r) => turnFor(r.at))
  const audit = { brain: [], work: [{ path: 'src.ts', added: 1, deleted: 0 }] }
  const prev = run({ usage: rows, events: told, audit })
  const next = run({ usage: [...rows.slice(1), row(201)], events: told, audit, phase: 'verify' })
  const out = nextEvents(prev, next, 1000)
  const added = out.slice(told.length)
  assert.equal(added.length, 1)
  assert.equal(added[0].kind === 'turn' && added[0].call, 201)
  assert.deepEqual(added[0].kind === 'turn' && added[0].paths, ['src.ts'])
})

test('a turn is told once, after the audit it left: zero, one, none', () => {
  const before = { brain: [], work: [] }
  const prev = run({ audit: before, usage: [] })
  const rowDone = run({ audit: before, usage: [row(500)] })
  const zero = nextEvents(prev, rowDone, 10)
  assert.equal(zero.filter((e) => e.kind === 'turn').length, 0)
  const audited = run({ audit: { brain: [], work: [{ path: 'a.ts', added: 3, deleted: 1 }] }, usage: [row(500)], events: zero })
  const one = nextEvents(rowDone, audited, 20)
  const turns = one.filter((e) => e.kind === 'turn')
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0], { at: 20, kind: 'turn', call: 500, model: 'grok-4.7', ms: 5, ok: true, files: 1, added: 3, deleted: 1, paths: ['a.ts'] })
  const again = run({ ...audited, events: one })
  assert.equal(nextEvents(again, again, 30), one)
})
