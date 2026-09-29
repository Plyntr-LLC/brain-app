import assert from 'node:assert/strict'
import { test } from 'node:test'
import { joinReady, missingWraps, seatWrapPlan } from './seat-wraps.ts'

const scopes = [
  { id: 's-alpha', root: 'projects/alpha/', keyVersion: 1 },
  { id: 's-beta', root: 'projects/beta/', keyVersion: 2 },
  { id: 's-acme', root: 'clients/acme/', keyVersion: 1 }
]

test('project seat never gets the brain wrap, only its own roots', () => {
  const plan = seatWrapPlan({ role: 'project', roots: ['projects/alpha/'] }, scopes, 3)
  assert.deepEqual(plan, [{ scope: 's-alpha', keyVersion: 1 }])
  assert.equal(plan.some((w) => w.scope === 'brain'), false)
  assert.deepEqual(seatWrapPlan({ role: 'project', roots: [] }, scopes, 3), [])
  assert.deepEqual(seatWrapPlan({ role: 'project', roots: null }, scopes, 3), [])
  const client = seatWrapPlan({ role: 'client-project', roots: ['clients/acme/'] }, scopes, 3)
  assert.deepEqual(client, [{ scope: 's-acme', keyVersion: 1 }])
})

test('team seat gets every project, never the brain', () => {
  const plan = seatWrapPlan({ role: 'team', roots: null }, scopes, 3)
  assert.deepEqual(plan.map((w) => w.scope), ['s-alpha', 's-beta', 's-acme'])
})

test('owner and scout pending Macs get the brain wrap plus every project', () => {
  for (const role of ['owner', 'scout']) {
    const plan = seatWrapPlan({ role, roots: null }, scopes, 3)
    assert.deepEqual(plan[0], { scope: 'brain', keyVersion: 3 })
    assert.deepEqual(plan.slice(1).map((w) => w.scope), ['s-alpha', 's-beta', 's-acme'])
  }
  assert.deepEqual(seatWrapPlan({ role: '', roots: null }, scopes, 3), [])
})

test('joinReady: builders need the brain wrap, everyone else every visible scope', () => {
  const wraps = [
    { scope: 's-alpha', key_version: 1 },
    { scope: 's-beta', key_version: 2 }
  ]
  const two = scopes.slice(0, 2)
  assert.equal(joinReady({ builder: false, wraps, scopes: two, brainKeyVersion: 1 }), true)
  assert.equal(joinReady({ builder: true, wraps, scopes: two, brainKeyVersion: 1 }), false)
  assert.equal(joinReady({ builder: true, wraps: [{ scope: 'brain', key_version: 1 }], scopes: two, brainKeyVersion: 1 }), true)
  assert.equal(joinReady({ builder: true, wraps: [{ scope: 'brain', key_version: 1 }], scopes: two, brainKeyVersion: 2 }), false)
  assert.equal(joinReady({ builder: false, wraps: [{ scope: 's-beta', key_version: 1 }], scopes: two, brainKeyVersion: 1 }), false)
  assert.equal(joinReady({ builder: false, wraps: [], scopes: [], brainKeyVersion: 1 }), true)
})

test('missingWraps skips what the target already holds', () => {
  const plan = seatWrapPlan({ role: 'owner', roots: null }, scopes, 1)
  const left = missingWraps(plan, [
    { scope: 'brain', keyVersion: 1 },
    { scope: 's-beta', keyVersion: 1 }
  ])
  assert.deepEqual(left.map((w) => w.scope), ['s-alpha', 's-beta', 's-acme'])
})
