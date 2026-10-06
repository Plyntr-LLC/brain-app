import assert from 'node:assert/strict'
import test from 'node:test'
import { cliLetter, thoughtLabel } from './turn.ts'

test('the avatar letter per CLI', () => {
  assert.equal(cliLetter('grok'), 'G')
  assert.equal(cliLetter('claude'), 'C')
  assert.equal(cliLetter('cursor'), 'C')
  assert.equal(cliLetter('gpt'), 'O')
})

test('a thought reads Thinking until it has both times and the turn is over', () => {
  assert.equal(thoughtLabel({}), 'Thinking · show')
  assert.equal(thoughtLabel({ at: 1000 }), 'Thinking · show')
  assert.equal(thoughtLabel({ at: 1000, end: 3400, live: true }), 'Thinking · show')
  assert.equal(thoughtLabel({ at: 1000, end: 3400 }), 'Thought for 2 s · show')
  assert.equal(thoughtLabel({ at: 1000, end: 3400, open: true }), 'Thought for 2 s')
})
