import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  canOfferPlyntrTransfer,
  listedRoleForSeat,
  plyntrSessionRole,
  transferUsesOwnerToken
} from './plyntr-transfer.ts'

const scoutSeat = {
  email: 'joe@plyntr.com',
  role: 'scout',
  status: 'active',
  plyntrScout: true
}
const ownerSeat = {
  email: 'ada@client.com',
  role: 'owner',
  status: 'active'
}

test('a moved brain keeps the scout seat even when the roster says owner', () => {
  assert.equal(
    plyntrSessionRole({ seatRole: 'scout', accountRole: '', rowRole: 'owner' }),
    'scout'
  )
  assert.equal(plyntrSessionRole({ seatRole: 'scout', accountRole: 'owner', rowRole: 'owner' }), 'scout')
  assert.equal(plyntrSessionRole({ seatRole: '', accountRole: '', rowRole: 'owner' }), '')
  assert.equal(plyntrSessionRole({ seatRole: 'owner', accountRole: 'team', rowRole: 'scout' }), 'owner')
  assert.equal(
    listedRoleForSeat({ email: 'joe@plyntr.com' }, [ownerSeat, { ...scoutSeat, role: 'owner' }])?.role,
    'scout'
  )
})

test('Remove Plyntr scout is only offered to the redeemed owner seat', () => {
  assert.equal(
    canOfferPlyntrTransfer({
      accountRole: 'owner',
      seatRole: 'scout',
      sessionEmail: 'joe@plyntr.com',
      seats: [scoutSeat, ownerSeat]
    }),
    false
  )
  assert.equal(
    canOfferPlyntrTransfer({
      accountRole: '',
      seatRole: 'scout',
      sessionEmail: 'joe@plyntr.com',
      seats: [scoutSeat]
    }),
    false
  )
  assert.equal(
    canOfferPlyntrTransfer({
      accountRole: 'scout',
      seatRole: 'owner',
      sessionEmail: 'ada@client.com',
      seats: [scoutSeat, ownerSeat]
    }),
    false
  )
  assert.equal(
    canOfferPlyntrTransfer({
      accountRole: 'owner',
      seatRole: 'owner',
      sessionEmail: 'joe@plyntr.com',
      seats: [scoutSeat]
    }),
    false
  )
  assert.equal(
    canOfferPlyntrTransfer({
      accountRole: 'owner',
      seatRole: 'owner',
      sessionEmail: 'joe@plyntr.com',
      seats: [{ email: 'joe@plyntr.com', role: 'scout', status: 'active' }, scoutSeat]
    }),
    false
  )
  assert.equal(
    canOfferPlyntrTransfer({
      accountRole: 'owner',
      seatRole: 'owner',
      sessionEmail: 'ada@client.com',
      seats: [scoutSeat, ownerSeat]
    }),
    true
  )
  assert.equal(
    canOfferPlyntrTransfer({
      accountRole: 'owner',
      seatRole: 'owner',
      sessionEmail: 'ada@client.com',
      seats: [{ ...scoutSeat, status: 'revoked' }]
    }),
    false
  )
})

test('transfer sends the owner seat token and refuses the scout token', () => {
  const scout = transferUsesOwnerToken({
    seatRole: 'owner',
    seatEmail: 'joe@plyntr.com',
    seatToken: 'pbt_scout',
    seats: [{ ...scoutSeat, role: 'owner' }]
  })
  assert.equal(scout.ok, false)
  const moved = transferUsesOwnerToken({
    seatRole: 'scout',
    seatEmail: 'joe@plyntr.com',
    seatToken: 'pbt_scout',
    seats: [scoutSeat]
  })
  assert.equal(moved.ok, false)
  const owner = transferUsesOwnerToken({
    seatRole: 'owner',
    seatEmail: 'ada@client.com',
    seatToken: 'pbt_owner',
    seats: [scoutSeat, ownerSeat]
  })
  assert.deepEqual(owner, { ok: true, token: 'pbt_owner' })
  const missing = transferUsesOwnerToken({ seatRole: 'owner', seatEmail: 'ada@client.com', seatToken: '' })
  assert.equal(missing.ok, false)
})

test('settings and the transfer call use the owner-seat gate', () => {
  const settings = readFileSync(new URL('../renderer/src/SettingsPanel.tsx', import.meta.url), 'utf8')
  const ipc = readFileSync(new URL('../main/ipc-stubs.ts', import.meta.url), 'utf8')
  const sync = readFileSync(new URL('../main/plyntr-sync.ts', import.meta.url), 'utf8')
  assert.match(settings, /canOfferPlyntrTransfer\(/)
  assert.equal(settings.includes('seat === \'owner\' && plyntrRows.seats.some((s) => s.plyntrScout'), false)
  assert.match(ipc, /plyntrSessionRole\(/)
  assert.match(sync, /transferUsesOwnerToken\(/)
  assert.match(sync, /token: gate\.token/)
})
