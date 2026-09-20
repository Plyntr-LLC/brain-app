import assert from 'node:assert/strict'
import test from 'node:test'
import { activateProfile, alreadyActive, findProfile, type AgencyConfig } from './agency-config.ts'

const plyntr: AgencyConfig = {
  brainPath: '/Users/me/agency-brain',
  mode: 'agency',
  teamSlug: 'plyntr',
  memberEmail: 'joe@plyntr.com',
  memberName: 'Joe',
  memberRole: 'owner',
  memberToken: 'tok-plyntr',
  scoutSeats: 5,
  packageTier: 'Team of 5',
  kind: 'agency',
  brains: []
}

const acme = {
  brainPath: '/Users/me/acme-brain',
  mode: 'agency',
  teamSlug: 'acme',
  memberEmail: 'pat@acme.org',
  memberName: 'Pat',
  memberRole: 'owner',
  memberToken: 'tok-acme',
  scoutSeats: null,
  packageTier: null,
  kind: 'client',
  brandName: 'Acme'
}

test('activateProfile archives Plyntr and puts the new brain on top', () => {
  const next = activateProfile(plyntr, acme)
  assert.equal(next.brainPath, '/Users/me/acme-brain')
  assert.equal(next.teamSlug, 'acme')
  assert.equal(next.memberToken, 'tok-acme')
  const stored = next.brains || []
  const p = stored.find((b) => b.teamSlug === 'plyntr')
  const a = stored.find((b) => b.teamSlug === 'acme')
  assert.equal(p?.memberToken, 'tok-plyntr')
  assert.equal(p?.brainPath, '/Users/me/agency-brain')
  assert.equal(a?.memberToken, 'tok-acme')
})

test('activateProfile back to Plyntr restores its token', () => {
  const onAcme = activateProfile(plyntr, acme)
  const back = activateProfile(onAcme, {
    brainPath: '/Users/me/agency-brain',
    teamSlug: 'plyntr',
    memberToken: 'tok-plyntr',
    memberEmail: 'joe@plyntr.com',
    memberName: 'Joe',
    memberRole: 'owner',
    kind: 'agency'
  })
  assert.equal(back.brainPath, '/Users/me/agency-brain')
  assert.equal(back.memberToken, 'tok-plyntr')
  assert.equal(back.teamSlug, 'plyntr')
  const acmeRow = (back.brains || []).find((b) => b.teamSlug === 'acme')
  assert.equal(acmeRow?.memberToken, 'tok-acme')
})

test('findProfile matches folder then slug', () => {
  const cfg = activateProfile(plyntr, acme)
  const byPath = findProfile(cfg, '/Users/me/agency-brain')
  assert.equal(byPath?.teamSlug, 'plyntr')
  assert.equal(byPath?.memberToken, 'tok-plyntr')
  const bySlug = findProfile(cfg, '/Users/me/moved-acme', 'acme')
  assert.equal(bySlug?.memberToken, 'tok-acme')
  assert.equal(bySlug?.brainPath, '/Users/me/moved-acme')
})

test('alreadyActive is only true for the same folder', () => {
  assert.equal(alreadyActive(plyntr, '/Users/me/agency-brain', 'plyntr'), true)
  assert.equal(alreadyActive(plyntr, '/Users/me/acme-brain', 'acme'), false)
})
