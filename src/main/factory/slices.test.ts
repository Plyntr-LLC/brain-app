import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_PARALLEL, parseSlices, scheduleSlices, WHOLE_TASK } from './slices.ts'

test('parseSlices reads the last slices JSON in the plan', () => {
  const plan = [
    'Plan: two parts.',
    '{"slices":[{"title":"old","files":["x.ts"]}]}',
    'Revised:',
    '{"slices":[{"title":"api","files":["src/api.ts","./src/types.ts"]},{"title":"ui","files":["src/ui/page.tsx"]}]}'
  ].join('\n')
  assert.deepEqual(parseSlices(plan), [
    { title: 'api', files: ['src/api.ts', 'src/types.ts'] },
    { title: 'ui', files: ['src/ui/page.tsx'] }
  ])
})

test('empty, invalid, or unsafe slices give one whole-task slice', () => {
  assert.deepEqual(parseSlices(''), [WHOLE_TASK])
  assert.deepEqual(parseSlices('no json'), [WHOLE_TASK])
  assert.deepEqual(parseSlices('{"slices": [oops'), [WHOLE_TASK])
  assert.deepEqual(parseSlices('{"slices":[{"title":"bad","files":["/etc/passwd","../up.ts"]}]}'), [WHOLE_TASK])
  assert.deepEqual(parseSlices('{"slices":[]}'), [WHOLE_TASK])
})

test('disjoint slices share one wave; at most 3 per wave', () => {
  const four = ['a', 'b', 'c', 'd'].map((n) => ({ title: n, files: [`src/${n}.ts`] }))
  const waves = scheduleSlices(four)
  assert.equal(waves.length, 2)
  assert.equal(waves[0].length, MAX_PARALLEL)
  assert.deepEqual(waves[1].map((s) => s.title), ['d'])
})

test('overlapping slices go sequential, including folder overlap and case', () => {
  const waves = scheduleSlices([
    { title: 'one', files: ['src/a.ts'] },
    { title: 'two', files: ['SRC/A.ts', 'src/b.ts'] },
    { title: 'three', files: ['lib'] },
    { title: 'four', files: ['lib/x.ts'] }
  ])
  assert.deepEqual(waves.map((w) => w.map((s) => s.title)), [['one', 'three'], ['two', 'four']])
  assert.deepEqual(scheduleSlices([WHOLE_TASK, { title: 'b', files: ['b.ts'] }]).map((w) => w.length), [1, 1])
})
