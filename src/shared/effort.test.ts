import assert from 'node:assert/strict'
import test from 'node:test'
import { CLAUDE_DEFAULT_EFFORT } from './claude-defaults.ts'
import {
  defaultEffort,
  GROK_DEFAULT_EFFORT,
  hydrateEffort,
  normalizeEffort,
  prettyEffort
} from './effort.ts'

test('Grok Chat default effort is high, not Default', () => {
  assert.equal(GROK_DEFAULT_EFFORT, 'high')
  assert.equal(defaultEffort('grok'), 'high')
  assert.equal(prettyEffort(undefined, 'grok'), 'High')
  assert.equal(prettyEffort(undefined, 'claude'), 'Low')
  assert.equal(prettyEffort('high', 'grok'), 'High')
  assert.equal(prettyEffort('xhigh', 'grok'), 'Extra high')
  assert.equal(prettyEffort(undefined), 'High')
  assert.equal(/default/i.test(prettyEffort(undefined, 'grok')), false)
  assert.equal(/default/i.test(prettyEffort(undefined, 'claude')), false)
})

test('hydrate keeps an explicit high pick instead of wiping it to Default', () => {
  assert.equal(hydrateEffort('grok', 'high'), 'high')
  assert.equal(hydrateEffort('grok', undefined), 'high')
  assert.equal(hydrateEffort('grok', 'xhigh'), 'xhigh')
  assert.equal(hydrateEffort('claude', undefined), CLAUDE_DEFAULT_EFFORT)
  assert.equal(hydrateEffort('claude', 'high'), 'high')
  assert.equal(hydrateEffort('cursor', 'high'), undefined)
})

test('normalizeEffort maps extra-high aliases', () => {
  assert.equal(normalizeEffort('extra high'), 'xhigh')
  assert.equal(normalizeEffort('x-high'), 'xhigh')
})
