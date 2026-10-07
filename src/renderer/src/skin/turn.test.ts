import assert from 'node:assert/strict'
import test from 'node:test'
import { activityLabel, cliLetter, isActivityComponent, thoughtLabel } from './turn.ts'

test('the avatar letter per CLI', () => {
  assert.equal(cliLetter('grok'), 'G')
  assert.equal(cliLetter('claude'), 'C')
  assert.equal(cliLetter('cursor'), 'C')
  assert.equal(cliLetter('gpt'), 'O')
})

test('a run of thinking and file chips is one closed line', () => {
  assert.equal(isActivityComponent('Thought'), true)
  assert.equal(isActivityComponent('ToolCard'), true)
  assert.equal(isActivityComponent('AgentMessage'), false)
  const parts = [
    { kind: 'thought' as const, at: 1000, end: 5000 },
    { kind: 'file' as const },
    { kind: 'thought' as const, at: 6000, end: 14000, live: true },
    { kind: 'file' as const },
    { kind: 'file' as const }
  ]
  assert.equal(activityLabel(parts, false), 'Thinking · 3 files · show')
  assert.equal(activityLabel(parts.map((p) => ({ ...p, live: false })), false), 'Thought for 13 s · 3 files · show')
  assert.equal(activityLabel([{ kind: 'file' }, { kind: 'file' }], true), '2 files')
  assert.equal(activityLabel([{ kind: 'thought', at: 1000, end: 4000 }], false), 'Thought for 3 s · show')
})

test('a thought reads Thinking until it has both times and the turn is over', () => {
  assert.equal(thoughtLabel({}), 'Thinking · show')
  assert.equal(thoughtLabel({ at: 1000 }), 'Thinking · show')
  assert.equal(thoughtLabel({ at: 1000, end: 3400, live: true }), 'Thinking · show')
  assert.equal(thoughtLabel({ at: 1000, end: 3400 }), 'Thought for 2 s · show')
  assert.equal(thoughtLabel({ at: 1000, end: 3400, open: true }), 'Thought for 2 s')
})
