import assert from 'node:assert/strict'
import test from 'node:test'
import { DONE_CONTRACT } from '../../shared/factory-done.ts'
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

test('a huge task is cut to the cap and the rules survive', () => {
  const b = buildBrief({ ...base, tier: 'T1', phase: 'review', role: 'self-check', task: 'x'.repeat(10_000), note: 'n'.repeat(5_000) })
  assert.ok(b.length <= BRIEF_MAX, String(b.length))
  assert.match(b, /Tier: T1/)
  assert.match(b, /Phase: review/)
  assert.match(b, /No git push/)
  assert.match(b, /Task: x+\.\.\./)
})

test('T2 plan and fix briefs with a 5,000-char task stay at the cap and keep the path lines', () => {
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

test('T3 plan brief asks for the slices JSON line; a T3 worker brief names its files; both fit', () => {
  const plan = buildBrief({ ...base, role: 'planner', tier: 'T3', phase: 'plan', task: 'x'.repeat(10_000) })
  assert.match(plan, /Limit T3: up to 40 files, 2500 changed lines/)
  assert.ok(plan.includes('{"slices":[{"title":"...","files":["rel/path.ts"]}]}'))
  assert.ok(plan.length <= BRIEF_MAX)
  assert.doesNotMatch(buildBrief({ ...base, role: 'planner', tier: 'T2', phase: 'plan' }), /"slices"/)
  const files = Array.from({ length: 40 }, (_, i) => `src/feature/file-${i}.ts`)
  const worker = buildBrief({ ...base, tier: 'T3', task: 'y'.repeat(10_000), planPath: '/tmp/ud/run.plan.md', slice: { title: 'api', files, n: 1, of: 2 } })
  assert.match(worker, /Your slice 1 of 2: api\. Edit only these files/)
  assert.ok(worker.includes('src/feature/file-0.ts'))
  assert.ok(worker.includes('Approved plan: /tmp/ud/run.plan.md'))
  assert.match(worker, /No git push, no gh, no deploy/)
  assert.ok(worker.length <= BRIEF_MAX)
})

test('build, fix, and self-check briefs carry the done contract under the cap', () => {
  assert.equal(BRIEF_MAX, 2000)
  const task = 'Fix the date shown one day off in the order list'
  const reviewPath = '/u/factory/runs/run-abc.review.md'
  for (const b of [
    buildBrief({ ...base, tier: 'T3', phase: 'build', task }),
    buildBrief({ ...base, role: 'self-check', tier: 'T1', phase: 'review', task }),
    buildBrief({ ...base, tier: 'T3', phase: 'fix', task, reviewPath })
  ]) {
    assert.ok(b.includes(DONE_CONTRACT), b.slice(0, 80))
    assert.ok(b.length <= BRIEF_MAX, String(b.length))
  }
  assert.ok(buildBrief({ ...base, tier: 'T3', phase: 'fix', task, reviewPath }).includes(reviewPath))
})

test("Joe's guide note wins over a long task; the task keeps a floor", () => {
  const joe = `Joe says: ${'g'.repeat(400)}`
  const b = buildBrief({ ...base, tier: 'T2', phase: 'fix', task: 't'.repeat(5_000), note: joe, reviewPath: '/u/factory/runs/run-abc.review.md' })
  assert.ok(b.length <= BRIEF_MAX, String(b.length))
  assert.ok(b.includes(joe), 'the whole guide note survives')
  assert.match(b, /Task: t{100,}\.\.\./)
})
