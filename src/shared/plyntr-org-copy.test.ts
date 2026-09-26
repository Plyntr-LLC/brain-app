import assert from 'node:assert/strict'
import test from 'node:test'
import { ipcErrorText, orgStepCopy, typedOrgReadyLogin } from './plyntr-org-copy.ts'

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

test('ipcErrorText drops Electron’s invoking prefix', () => {
  assert.equal(
    ipcErrorText("Error invoking remote method 'plyntr:emailCode': Error: That email has not been added yet. The company has to be set up before a code can be emailed."),
    'That email has not been added yet. The company has to be set up before a code can be emailed.'
  )
  assert.equal(ipcErrorText(new Error('That code was already used.')), 'That code was already used.')
})
