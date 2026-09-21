import assert from 'node:assert/strict'
import test from 'node:test'
import { extraFromStdout, toolCaptureFromUpdate, wrapPromptWithHooks } from './project-hooks.ts'

test('slash commands skip project hook wrap', () => {
  const out = wrapPromptWithHooks({
    cwd: '/tmp',
    kind: 'cursor',
    sessionId: 's1',
    text: '/compact'
  })
  assert.equal(out, '/compact')
})

test('hook stdout additional_context is pulled from JSON', () => {
  assert.match(
    extraFromStdout('{"continue":true,"additional_context":"KEEP these dropped"}'),
    /KEEP these dropped/
  )
  assert.equal(extraFromStdout('{}'), '')
  assert.equal(extraFromStdout('{"continue":true}'), '')
})

test('tool capture waits for completed output over 200 chars', () => {
  assert.equal(toolCaptureFromUpdate({ status: 'in_progress', rawOutput: 'x'.repeat(300) }), null)
  const hit = toolCaptureFromUpdate({
    status: 'completed',
    title: 'Read',
    toolCallId: 'tc1',
    rawOutput: 'y'.repeat(250)
  })
  assert.ok(hit)
  assert.equal(hit?.toolId, 'tc1')
  assert.equal(hit?.toolOutput.length, 250)
})
