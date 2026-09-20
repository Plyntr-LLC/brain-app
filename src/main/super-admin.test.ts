import assert from 'node:assert/strict'
import test from 'node:test'
import { isJoeSuperAdmin } from './super-admin.ts'

test('isJoeSuperAdmin is joe@plyntr.com on a real Brain login only', () => {
  assert.equal(isJoeSuperAdmin({ email: 'joe@plyntr.com', source: 'ads2ai' }, {}), true)
  assert.equal(isJoeSuperAdmin({ email: 'joe@plyntr.com' }, { superAdmin: true }), true)
  assert.equal(isJoeSuperAdmin({ email: 'Joe@Plyntr.com', source: 'ads2ai' }, {}), true)
  assert.equal(isJoeSuperAdmin({ email: 'joe@plyntr.com', source: 'team-file' }, {}), false)
  assert.equal(isJoeSuperAdmin({ email: 'joe@plyntr.com', source: 'hq-sync' }, {}), false)
  assert.equal(isJoeSuperAdmin({ email: 'joe@plyntr.com' }, { superAdmin: false }), false)
  assert.equal(isJoeSuperAdmin({ email: 'joewine2@gmail.com', appEmail: 'joe@plyntr.com', source: 'ads2ai' }, {}), true)
  assert.equal(isJoeSuperAdmin({ email: 'pat@acme.org', source: 'ads2ai' }, {}), false)
  assert.equal(isJoeSuperAdmin(null, {}), false)
})
