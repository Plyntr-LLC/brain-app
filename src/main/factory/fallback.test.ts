import assert from 'node:assert/strict'
import test from 'node:test'
import { cursorGrokModel, grokUsageBlocked, isNeedOpus, needOpusError } from './fallback.ts'
import { BRAIN_WRITE_REFUSAL, OTHER_REPO_WRITE_REFUSAL, PUSH_REFUSAL } from './gates.ts'

test('grokUsageBlocked: usage, credits, missing binary, and auth are unusable', () => {
  assert.equal(grokUsageBlocked(new Error('You have reached your weekly usage limit. Try again Monday.')), true)
  assert.equal(grokUsageBlocked('Credits exhausted for this period'), true)
  assert.equal(grokUsageBlocked({ creditUsagePercent: 100 }), true)
  assert.equal(grokUsageBlocked({ billing: { config: { creditUsagePercent: 99 } } }), true)
  assert.equal(grokUsageBlocked(new Error('grok is not installed on this computer')), true)
  assert.equal(grokUsageBlocked(new Error('Authentication required: not signed in')), true)
})

test('grokUsageBlocked: cancelled, write blocks, permission cards, and stop reasons are not', () => {
  for (const e of ['cancelled', BRAIN_WRITE_REFUSAL, OTHER_REPO_WRITE_REFUSAL, PUSH_REFUSAL, 'refusal', 'max_tokens', 'Permission asked: Edit src/a.ts', 'Factory session is not ready.']) {
    assert.equal(grokUsageBlocked(new Error(e)), false, e)
  }
  assert.equal(grokUsageBlocked({ creditUsagePercent: 42 }), false)
})

test('needOpusError is tagged', () => {
  assert.equal(isNeedOpus(needOpusError('x')), true)
  assert.equal(isNeedOpus(new Error('cancelled')), false)
})

test('cursorGrokModel picks the Grok family, 4.7 when unknown, null without a Cursor Grok', () => {
  const models = [
    { id: 'composer-2.5[fast=true]', label: 'Composer 2.5' },
    { id: 'cursor-grok-4.6[effort=high]', label: 'Cursor Grok 4.6' },
    { id: 'cursor-grok-4.7[effort=high]', label: 'Cursor Grok 4.7' }
  ]
  assert.equal(cursorGrokModel(models, 'grok-4.6'), 'cursor-grok-4.6[effort=high]')
  assert.equal(cursorGrokModel(models, 'grok-4.7-fast'), 'cursor-grok-4.7[effort=high]')
  assert.equal(cursorGrokModel(models), 'cursor-grok-4.7[effort=high]')
  assert.equal(cursorGrokModel([{ id: 'composer-2.5', label: 'Composer' }]), null)
})
