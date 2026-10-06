import assert from 'node:assert/strict'
import test from 'node:test'
import { toSavedMsgs } from './saved-msg.ts'

test('a message with pastes keeps them when saved', () => {
  const pastes = [{ token: '[Pasted text #1 +3 lines]', text: 'a\nb\nc' }]
  const saved = toSavedMsgs([{ who: 'me', text: 'see [Pasted text #1 +3 lines]', pastes }])
  assert.deepEqual(saved, [{ who: 'me', text: 'see [Pasted text #1 +3 lines]', pastes }])
})

test('a message without pastes saves as who and text only', () => {
  const saved = toSavedMsgs([{ who: 'me', text: 'hi', at: 5, files: [] } as never, { who: 'brain', text: 'yo', pastes: [] }])
  assert.deepEqual(saved, [
    { who: 'me', text: 'hi' },
    { who: 'brain', text: 'yo' }
  ])
  assert.deepEqual(Object.keys(saved[0]), ['who', 'text'])
})

test('thoughts and other rows are dropped and the last 200 stay', () => {
  const list = [{ who: 'think', text: 't' }, { who: 'raw', text: 'r' }, ...Array.from({ length: 205 }, (_, i) => ({ who: 'me', text: `m${i}` }))]
  const saved = toSavedMsgs(list)
  assert.equal(saved.length, 200)
  assert.equal(saved[0].text, 'm5')
  assert.equal(saved[199].text, 'm204')
  assert.ok(saved.every((m) => m.who === 'me'))
})
