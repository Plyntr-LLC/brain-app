import assert from 'node:assert/strict'
import test from 'node:test'
import { applyFactoryText, hideTell, showOutgoing, visibleGuide } from './guide-thread.ts'

test('the typed line is in the thread before the saved note, then one bubble', () => {
  const pending = showOutgoing('how is this factory run going?')
  const before = visibleGuide([], pending)
  assert.equal(before.length, 1)
  assert.equal(before[0].text, pending.text)
  const saved = [{ text: pending.text, ack: 'Still in review.', sent: true, at: 5 }]
  const after = visibleGuide(saved, pending)
  assert.equal(after.length, 1)
  assert.equal(after[0], saved[0])
})

test('a guide text event stays off the builder activity line', () => {
  const start = { activity: 'builder', guideAck: '' }
  const guided = applyFactoryText(start, 'guide', 'answer')
  assert.equal(guided.activity, 'builder')
  assert.equal(guided.guideAck, 'answer')
  const streamed = applyFactoryText(guided, 'stream', ' more')
  assert.equal(streamed.activity, 'builder more')
  assert.equal(streamed.guideAck, 'answer')
  const told = applyFactoryText(start, 'guide', 'Hi\nFACTORY_TELL: add a footer credit')
  assert.equal(told.activity, 'builder')
  assert.equal(told.guideAck, 'Hi')
  assert.equal(hideTell('Hi\nFACTORY'), 'Hi')
  let streamedTell = start
  for (const chunk of ['Adding that.', '\n', 'FACTORY_TELL: add a footer credit']) {
    streamedTell = applyFactoryText(streamedTell, 'guide', chunk)
  }
  assert.equal(streamedTell.guideAck, 'Adding that.')
  assert.equal(streamedTell.activity, 'builder')
  let splitTell = applyFactoryText(start, 'guide', 'Hi\nFACT')
  splitTell = applyFactoryText(splitTell, 'guide', 'ORY_TELL: add a footer credit')
  assert.equal(splitTell.guideAck, 'Hi')
  assert.equal(splitTell.activity, 'builder')
})
