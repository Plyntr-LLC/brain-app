import assert from 'node:assert/strict'
import test from 'node:test'
import { contextNamesLookNew, firstChatWelcome } from '../shared/first-chat.ts'

test('a new brain is the one that still has TEMPLATE files', () => {
  assert.equal(contextNamesLookNew(['context/TEMPLATE-business-overview.md']), true)
  assert.equal(contextNamesLookNew(['context/business/TEMPLATE-voice.md']), true)
  assert.equal(contextNamesLookNew(['context/business/business-overview.md', 'AGENTS.md']), false)
  assert.equal(contextNamesLookNew([]), false)
})

test('the first chat welcome asks for the business and only that once', () => {
  const text = firstChatWelcome('sept-21-co')
  assert.match(text, /Welcome\. sept-21-co is on this computer/)
  assert.match(text, /What it does, who it is for, and what you sell/)
  assert.equal(text.includes('—'), false)
  assert.equal(firstChatWelcome('').includes('this brain'), true)
})
