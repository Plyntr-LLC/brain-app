import assert from 'node:assert/strict'
import test from 'node:test'
import { CODE_DID_NOT_WORK, GONE_BRAIN_CODE, ipcErrorText, orgStepCopy, pickCodeError, typedOrgReadyLogin } from './plyntr-org-copy.ts'

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

test('several failed code tries show the most useful line, never raw not found', () => {
  assert.equal(pickCodeError(['not found', 'That code did not work.']), CODE_DID_NOT_WORK)
  assert.equal(
    pickCodeError(["Error invoking remote method 'plyntr:resolve': Error: " + GONE_BRAIN_CODE, 'not found']),
    GONE_BRAIN_CODE
  )
  assert.equal(pickCodeError(['not found', 'That code was already used.']), 'That code was already used.')
  assert.equal(pickCodeError(['expired', 'not found']), 'That code has expired. Ask for a fresh one.')
  assert.equal(pickCodeError(['not found', 'Could not make the project folder.']), 'Could not make the project folder.')
  assert.equal(pickCodeError(['That code did not work (HTTP 401)']), CODE_DID_NOT_WORK)
})
