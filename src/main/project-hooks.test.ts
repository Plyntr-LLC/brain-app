import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import './test-resolve.ts'

const { extraFromStdout, toolCaptureFromUpdate, wrapPromptWithHooks } = await import('./project-hooks.ts')

test('slash commands skip project hook wrap', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hooks-'))
  try {
    const hook = join(cwd, 'code', 'typesafe', 'context-router')
    mkdirSync(hook, { recursive: true })
    writeFileSync(join(hook, 'hook.cjs'), 'process.stdout.write(JSON.stringify({ additional_context: "ROUTED" }))')
    const say = (text: string) => wrapPromptWithHooks({ cwd, kind: 'cursor', sessionId: 's1', text })
    assert.match(say('what changed today'), /ROUTED/)
    assert.equal(say('/compact'), '/compact')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
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
