import assert from 'node:assert/strict'
import test from 'node:test'
import { railFor, type Activity } from './activity.ts'

const a = (text: string): Activity => ({ now: { text, tone: 'idle' }, files: [] })

test('the right rail: a Factory or Chat tab its own, any other tab the last chat, else In use', () => {
  const byTab: Record<string, Activity | null> = { F: a('factory'), C1: a('chat one'), C2: a('chat two') }
  const tabs = { F: { id: 'F', type: 'factory' }, C1: { id: 'C1', type: 'chat' }, C2: { id: 'C2', type: 'chat' }, T: { id: 'T', type: 'term' } }
  assert.equal(railFor(tabs.F, 'C2', byTab)?.now.text, 'factory')
  assert.equal(railFor(tabs.C1, 'C2', byTab)?.now.text, 'chat one')
  assert.equal(railFor(tabs.T, 'C2', byTab)?.now.text, 'chat two')
  assert.equal(railFor({ id: 'F2', type: 'factory' }, 'C2', byTab), null)
  assert.equal(railFor(tabs.T, '', byTab), null)
  assert.equal(railFor(undefined, 'C2', byTab), null)
})
