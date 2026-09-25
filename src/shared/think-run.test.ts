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
