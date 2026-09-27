import assert from 'node:assert/strict'
import test from 'node:test'
import { triage } from './triage.ts'

test('typo in the footer is T0 with no risk', () => {
  const r = triage('fix typo in footer')
  assert.equal(r.size, 'T0')
  assert.equal(r.risk, 'none')
  assert.equal(r.capped, false)
})

const T0 = ['Change the button text on the pricing card to "Start free"', 'Fix spelling of "recieve" in about.md', 'Make the header color darker']
const T1 = ['Fix the date shown one day off in the order list', 'Handle an empty cart in cart.ts and summary.ts']
const BIG = [
  'Add a new page for team settings with a new route and shared types',
  'Rewrite the whole app in Svelte',
  'Refactor a.ts, b.ts, c.ts, d.ts and e.ts to share one helper'
]
const CRITICAL = ['Fix the Stripe checkout rounding', 'Change the login password reset email', 'Add a migration for the users table']

test('fixtures size as expected and stay under 200 ms', () => {
  for (const t of [...T0, ...T1, ...BIG, ...CRITICAL, 'fix typo in footer']) {
    const r = triage(t)
    assert.ok(r.ms < 200, `${t} took ${r.ms} ms`)
  }
  for (const t of T0) assert.equal(triage(t).size, 'T0', t)
  for (const t of T1) assert.equal(triage(t).size, 'T1', t)
})

test('T2 and T3 asks are capped at T1 with the original in reasons', () => {
  for (const t of BIG) {
    const r = triage(t)
    assert.equal(r.capped, true, t)
    assert.equal(r.size, 'T1', t)
    assert.ok(r.original === 'T2' || r.original === 'T3', t)
    assert.ok(r.reasons.some((x) => x.includes(r.original)), t)
  }
  assert.equal(triage('Rewrite the whole app in Svelte').original, 'T3')
})

test('payments, auth and migrations are critical', () => {
  for (const t of CRITICAL) assert.equal(triage(t).risk, 'critical', t)
})

test('file count hints raise the size', () => {
  assert.equal(triage('fix the label', { files: 5 }).original, 'T2')
  assert.equal(triage('fix the label', { files: 12 }).original, 'T3')
})
