import assert from 'node:assert/strict'
import test from 'node:test'
import { orgStepCopy, typedOrgReadyLogin } from './plyntr-org-copy.ts'

test('a typed organization name replaces the company-slug lecture', () => {
  assert.equal(typedOrgReadyLogin('its-a-test-rosene', 'rose-wine'), 'its-a-test-rosene')
  assert.equal(typedOrgReadyLogin('rose-wine', 'rose-wine'), '')
  assert.equal(typedOrgReadyLogin('rose-wine-brain', 'rose-wine'), '')
  const copy = orgStepCopy(
    'rose',
    'rose-wine',
    { preferred: 'rose-wine', free: false, takenType: 'User', suggestion: 'rose-wine-hq' },
    'its-a-test-rosene'
  )
  assert.match(copy, /its-a-test-rosene/)
  assert.doesNotMatch(copy, /person's GitHub login/)
  assert.match(
    orgStepCopy(
      'rose',
      'rose-wine',
      { preferred: 'rose-wine', free: false, takenType: 'User', suggestion: 'rose-wine-hq' },
      ''
    ),
    /person's GitHub login/
  )
})
