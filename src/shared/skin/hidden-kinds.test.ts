import assert from 'node:assert/strict'
import test from 'node:test'
import { isHiddenStreamKind, isProtocolNoise } from './hidden-kinds.ts'

test('protocol lifecycle kinds stay out of the thread', () => {
  for (const kind of ['response_completed', 'hook_run_started', 'hook_run_completed', 'response_started']) {
    assert.equal(isHiddenStreamKind(kind), true, kind)
    assert.equal(isProtocolNoise(kind), true, kind)
  }
  assert.equal(isProtocolNoise('Here is the answer.'), false)
  assert.equal(isHiddenStreamKind('text'), false)
  assert.equal(isHiddenStreamKind('file'), false)
})
