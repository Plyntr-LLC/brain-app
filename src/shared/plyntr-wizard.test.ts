import assert from 'node:assert/strict'
import test from 'node:test'
import { previousCreateStep } from './plyntr-wizard.ts'

test('Back on company setup stays inside the wizard until the organization step', () => {
  assert.equal(previousCreateStep(2, true), null)
  assert.equal(previousCreateStep(3, false), 2)
  assert.equal(previousCreateStep(4, true), 2)
  assert.equal(previousCreateStep(4, false), 3)
  assert.equal(previousCreateStep(5, true), 4)
  assert.equal(previousCreateStep(6, true), 5)
})
