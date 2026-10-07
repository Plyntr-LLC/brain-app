import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { matchName } = require('./imessage.cjs') as {
  matchName: (chats: { guid: string; display_name: string; handles?: string[] }[], to: string) => {
    sendable: boolean
    note?: string
    guid?: string
    label?: string
  }
}

const brent = (guid: string, handle = '+15551212') => ({ guid, display_name: 'Brent', handles: [handle] })

test('zero chats for Brent is not sendable', () => {
  const got = matchName([], 'Brent')
  assert.equal(got.sendable, false)
  assert.equal(got.note, 'No existing iMessage thread for Brent.')
  assert.equal(got.guid, undefined)
})

test('one chat for Brent stores that guid', () => {
  const got = matchName([brent('iMessage;+;brent')], 'Brent')
  assert.equal(got.sendable, true)
  assert.equal(got.guid, 'iMessage;+;brent')
  assert.equal(got.label, 'Brent +15551212')
})

test('two chats for Brent is not sendable', () => {
  const got = matchName([brent('a'), brent('b', '+15550000')], 'brent')
  assert.equal(got.sendable, false)
  assert.equal(got.note, 'More than one iMessage chat matches brent.')
})
