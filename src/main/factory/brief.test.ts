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

test('T2 plan and fix briefs with a 5,000-char task stay at 1,200 and keep the path lines', () => {
  const plan = buildBrief({ ...base, role: 'planner', tier: 'T2', phase: 'plan', task: 'p'.repeat(5_000), note: 'too big', previousPlanPath: '/u/factory/runs/run-abc.plan.md' })
  assert.ok(plan.length <= BRIEF_MAX, String(plan.length))
  assert.match(plan, /Tier: T2\. Phase: plan\./)
  assert.match(plan, /Do not edit files\./)
  assert.ok(plan.includes('Previous plan: /u/factory/runs/run-abc.plan.md'))
  const build = buildBrief({ ...base, tier: 'T2', task: 'b'.repeat(5_000), planPath: '/u/factory/runs/run-abc.plan.md' })
  assert.ok(build.length <= BRIEF_MAX)
  assert.ok(build.includes('Approved plan: /u/factory/runs/run-abc.plan.md. Read it first.'))
  assert.match(build, /Limit T2: up to 10 files, 600/)
  const fix = buildBrief({ ...base, tier: 'T2', phase: 'fix', task: 'f'.repeat(5_000), note: 'n'.repeat(5_000), reviewPath: '/u/factory/runs/run-abc.review.md' })
  assert.ok(fix.length <= BRIEF_MAX, String(fix.length))
  assert.match(fix, /Phase: fix\./)
  assert.ok(fix.includes('Reviewer notes: /u/factory/runs/run-abc.review.md. Fix what it names.'))
})
