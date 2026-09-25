import assert from 'node:assert/strict'
import test from 'node:test'
import { appendThought, collapseAdjacentThinks, type ThreadMsg } from './think-run.ts'

test('back to back thoughts become one entry', () => {
  const first = appendThought([] as ThreadMsg[], 'One')
  const second = appendThought(first, ' two')
  assert.equal(second.length, 1)
  assert.equal(second[0].text, 'One two')
})

test('a real reply splits the next thought', () => {
  const msgs = appendThought([{ who: 'think', text: 'One' }], ' two')
  const split = appendThought([...msgs, { who: 'brain', text: 'Answer' }], 'Next')
  assert.equal(split.length, 3)
  assert.equal(split[2].text, 'Next')
})

test('an invisible raw row between thoughts does not split them', () => {
  const msgs = collapseAdjacentThinks([
    { who: 'think', text: 'First' },
    { who: 'raw', rawKind: 'usage_update', text: '12 tokens' },
    { who: 'think', text: 'Second' }
  ])
  assert.equal(msgs.filter((m) => m.who === 'think').length, 1)
  assert.match(String(msgs.find((m) => m.who === 'think')?.text), /First/)
  assert.match(String(msgs.find((m) => m.who === 'think')?.text), /Second/)
})

test('an empty tool update does not split thoughts', () => {
  const msgs = collapseAdjacentThinks([
    { who: 'think', text: 'First' },
    { who: 'raw', rawKind: 'tool_call', skinLabel: 'Tool', text: '' },
    { who: 'think', text: 'Second' }
  ])
  assert.equal(msgs.filter((m) => m.who === 'think').length, 1)
})

test('protocol text on a raw row does not split thoughts', () => {
  const msgs = collapseAdjacentThinks([
    { who: 'think', text: 'First' },
    { who: 'raw', rawKind: 'tool_call', skinLabel: 'Tool', text: 'response_completed' },
    { who: 'think', text: 'Second' }
  ])
  assert.equal(msgs.filter((m) => m.who === 'think').length, 1)
})

test('a visible card without a skin label starts a new thought', () => {
  const next = appendThought(
    [
      { who: 'think', text: 'First' },
      { who: 'raw', rawKind: 'status', text: 'working' }
    ],
    'Next'
  )
  assert.equal(next[next.length - 1].text, 'Next')
  assert.notEqual(next[0].text, 'FirstNext')
})

test('a raw fallback does not split thoughts', () => {
  const msgs = collapseAdjacentThinks([
    { who: 'think', text: 'First' },
    { who: 'raw', rawKind: 'tool_call', skinLabel: 'RawFallback', text: 'Read install.ts' },
    { who: 'think', text: 'Second' }
  ])
  assert.equal(msgs.filter((m) => m.who === 'think').length, 1)
})

test('a visible tool card starts a new thought', () => {
  const next = appendThought(
    [
      { who: 'think', text: 'First' },
      { who: 'raw', rawKind: 'tool_call', skinLabel: 'Tool', text: 'Read install.ts' }
    ],
    'Next'
  )
  assert.equal(next[next.length - 1].text, 'Next')
  assert.notEqual(next[0].text, 'FirstNext')
})

test('a real reply still starts a new thought after an empty tool row', () => {
  const next = appendThought(
    [
      { who: 'think', text: 'First' },
      { who: 'raw', rawKind: 'tool_call_update', skinLabel: 'RawFallback', text: '' },
      { who: 'brain', text: 'Yes, for the two setups.' }
    ],
    'After'
  )
  assert.equal(next[next.length - 1].text, 'After')
  assert.equal(next.filter((m) => m.who === 'brain')[0].text, 'Yes, for the two setups.')
})

test('hidden protocol between thoughts does not split them', () => {
  const msgs = collapseAdjacentThinks([
    { who: 'think', text: 'First' },
    { who: 'brain', text: 'response_completed' },
    { who: 'think', text: 'Second' },
    { who: 'me', text: 'Hi' },
    { who: 'think', text: 'After' }
  ])
  assert.deepEqual(
    msgs.map((m) => m.text),
    ['First\n\nSecond', 'response_completed', 'Hi', 'After']
  )
})
