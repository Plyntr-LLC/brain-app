import assert from 'node:assert/strict'
import test from 'node:test'
import { KIND_CONFIDENCE, buildQuestions, decideProposal, jevShouldRun } from './jev-propose.ts'

test('jevShouldRun skips matched, hidden, and token kinds', () => {
  assert.equal(jevShouldRun({ matched: true, eventKind: 'waiting_screen' }), false)
  assert.equal(jevShouldRun({ matched: false, eventKind: 'tool_call_update' }), false)
  assert.equal(jevShouldRun({ matched: false, eventKind: 'text' }), false)
  assert.equal(jevShouldRun({ matched: false, eventKind: 'waiting_screen' }), true)
})

test('unknown and RawFallback never paint', () => {
  assert.equal(decideProposal({ answers: { kind: { choice: 'unknown', confidence: 0.99 } }, optionLabels: [] }).paint, false)
  assert.equal(decideProposal({ answers: { kind: { choice: 'RawFallback', confidence: 0.99 } }, optionLabels: [] }).paint, false)
})

test('high-confidence ToolCard paints', () => {
  const p = decideProposal({
    answers: { kind: { choice: 'ToolCard', confidence: KIND_CONFIDENCE } },
    optionLabels: []
  })
  assert.equal(p.component, 'ToolCard')
  assert.equal(p.paint, true)
})

test('low confidence stays proposed, not painted', () => {
  const p = decideProposal({
    answers: { kind: { choice: 'ToolCard', confidence: KIND_CONFIDENCE - 0.01 } },
    optionLabels: []
  })
  assert.equal(p.component, 'ToolCard')
  assert.equal(p.paint, false)
})

test('PermissionAsk is proposed and never painted or allowed', () => {
  const p = decideProposal({
    answers: {
      kind: { choice: 'PermissionAsk', confidence: 0.99 },
      looks_like_permission: { noul: 0.95 },
      option_binding: { choice: 'Allow' }
    },
    optionLabels: ['Allow', 'Skip']
  })
  assert.equal(p.component, 'PermissionAsk')
  assert.equal(p.paint, false)
  assert.equal(p.option, 'Allow')
  assert.match(p.detail, /not bound/)
})

test('option_binding copies only labels on the screen', () => {
  const p = decideProposal({
    answers: {
      kind: { choice: 'ToolCard', confidence: 0.99 },
      option_binding: { choice: 'Always allow everywhere' }
    },
    optionLabels: ['Allow', 'Skip']
  })
  assert.equal(p.option, null)
})

test('invented catalog ids do not paint', () => {
  const p = decideProposal({
    answers: { kind: { choice: 'MergeAsk', confidence: 0.99 } },
    optionLabels: []
  })
  assert.equal(p.component, null)
  assert.equal(p.paint, false)
})

test('option_binding question only lists on-screen labels', () => {
  const q = buildQuestions(['Allow', 'Skip']) as {
    option_binding: { criteria: Record<string, string> }
  }
  assert.deepEqual(Object.keys(q.option_binding.criteria).sort(), ['Allow', 'Skip', 'none'])
  assert.equal('option_binding' in buildQuestions([]), false)
})
