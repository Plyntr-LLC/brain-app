import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dryRunInstalledBody,
  dryRunOwnerBind,
  dryRunPlyntrBind,
  dryRunProjectInvite,
  plyntrBindAllowed,
  storeBrainOwnerSession
} from './plyntr-dry-run.ts'

test('dry-run project connect follows the live bind gate', () => {
  const platformGate = plyntrBindAllowed({ sessionKind: 'platform' })
  assert.equal(plyntrBindAllowed(null).ok, false)
  assert.equal(platformGate.ok, false)
  if (!platformGate.ok) assert.equal(platformGate.detail, 'company login only')
  const teamGate = plyntrBindAllowed({ role: 'team' })
  assert.equal(teamGate.ok, false)
  if (!teamGate.ok) {
    assert.equal(teamGate.detail, 'Only the bootstrap scout or the client owner can connect this brain.')
  }
  assert.equal(plyntrBindAllowed({ role: 'scout', bootstrap: false }).ok, false)
  assert.equal(plyntrBindAllowed({ role: 'scout', bootstrap: true, sessionKind: 'platform' }).ok, true)
  assert.equal(plyntrBindAllowed({ role: 'owner' }).ok, true)
  assert.equal(storeBrainOwnerSession('platform'), false)
  assert.equal(storeBrainOwnerSession('owner'), true)
  assert.equal(storeBrainOwnerSession(undefined), true)

  assert.equal(dryRunInstalledBody('acme/acme-brain').projectSeatCount, 0)
  const platform = dryRunOwnerBind('acme/acme-brain', 'platform')
  assert.equal(platform.ok, false)
  assert.equal(platform.detail, 'company login only')
  assert.equal(dryRunInstalledBody('acme/acme-brain').projectSeatCount, 0)
  const unsigned = dryRunOwnerBind('acme/acme-brain')
  assert.equal(unsigned.ok, false)
  const team = dryRunPlyntrBind('acme/acme-brain', { role: 'team' })
  assert.equal(team.ok, false)
  assert.equal(dryRunProjectInvite(['projects/bible/']).ok, true)
  const blocked = dryRunProjectInvite(['projects/bible/'])
  if (blocked.ok) assert.equal(blocked.needsBridge, true)

  const scout = dryRunPlyntrBind('acme/acme-brain', { role: 'scout', bootstrap: true, sessionKind: 'platform' })
  assert.equal(scout.ok, true)
  assert.equal(scout.hq_repo, 'acme/acme-brain')
  assert.equal(dryRunInstalledBody('acme/acme-brain').projectSeatCount, 1)
  const minted = dryRunProjectInvite(['projects/bible/'])
  assert.equal(minted.ok, true)
  if (!minted.ok) return
  assert.equal(minted.code, 'PR0J3CT12X')
  assert.equal(minted.needsBridge, false)
  assert.equal(dryRunProjectInvite([]).ok, false)

  const owner = dryRunPlyntrBind('ada/ada-brain', { role: 'owner' })
  assert.equal(owner.ok, true)
  assert.equal(owner.hq_repo, 'ada/ada-brain')
})
