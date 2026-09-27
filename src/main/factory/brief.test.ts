import assert from 'node:assert/strict'
import test from 'node:test'
import { BRIEF_MAX, buildBrief } from './brief.ts'

const base = { role: 'builder' as const, tier: 'T0' as const, phase: 'build' as const, workRepo: '/tmp/work', brainPath: '/tmp/brain', task: 'fix typo in footer' }

test('brief carries role, tier, phase, work repo and the no-push rules', () => {
  const b = buildBrief(base)
  assert.match(b, /Role: builder/)
  assert.match(b, /Tier: T0/)
  assert.match(b, /Phase: build/)
  assert.match(b, /Work repo: \/tmp\/work/)
  assert.match(b, /absolute paths/)
  assert.match(b, /No git push, no gh, no deploy/)
  assert.match(b, /Do not commit/)
  assert.match(b, /fix typo in footer/)
})

test('a huge task is cut to 1,200 characters and the rules survive', () => {
  const b = buildBrief({ ...base, tier: 'T1', phase: 'review', role: 'self-check', task: 'x'.repeat(10_000), note: 'n'.repeat(5_000) })
  assert.ok(b.length <= BRIEF_MAX, String(b.length))
  assert.match(b, /Tier: T1/)
  assert.match(b, /Phase: review/)
  assert.match(b, /No git push/)
  assert.match(b, /Task: x+\.\.\./)
})
