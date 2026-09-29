import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEDIA_JOIN_WAIT,
  MEDIA_LOST_COPY,
  computerLine,
  macLabel,
  macLabelFromHostname,
  parseStorageGb,
  shouldShowStorageAsk,
  storageEstimateLine,
  storageGbToBytes
} from './media.ts'

const eligible = {
  role: 'owner',
  joe: false,
  storageOn: false,
  mediaAsked: false,
  hasSeatToken: true,
  routes: true
}

test('storage-ask shows for an owner with a seat when media routes are live', () => {
  assert.equal(shouldShowStorageAsk(eligible), true)
  assert.equal(shouldShowStorageAsk({ ...eligible, role: 'scout' }), true)
})

test('storage-ask hides when media health routes are down', () => {
  assert.equal(shouldShowStorageAsk({ ...eligible, routes: false }), false)
})

test('storage-ask still skips team, project, and asked paths when routes are live', () => {
  assert.equal(shouldShowStorageAsk({ ...eligible, role: 'team' }), false)
  assert.equal(shouldShowStorageAsk({ ...eligible, role: 'project' }), false)
  assert.equal(shouldShowStorageAsk({ ...eligible, hasSeatToken: false }), true)
  assert.equal(shouldShowStorageAsk({ ...eligible, role: 'owner', joe: true, hasSeatToken: false }), true)
  assert.equal(shouldShowStorageAsk({ ...eligible, role: 'team', joe: true, hasSeatToken: false }), false)
  assert.equal(shouldShowStorageAsk({ ...eligible, storageOn: true }), false)
  assert.equal(shouldShowStorageAsk({ ...eligible, mediaAsked: true }), false)
})

test('storage-ask skips when media.json already exists, even with no token on this Mac', () => {
  assert.equal(shouldShowStorageAsk({ ...eligible, hasMediaConfig: true }), false)
  assert.equal(shouldShowStorageAsk({ ...eligible, hasSeatToken: false, hasMediaConfig: true }), false)
  assert.equal(shouldShowStorageAsk({ ...eligible, hasMediaConfig: false }), true)
})

test('storage estimate: first 10 GB free, then $0.015 per GB-month rounded to cents', () => {
  assert.equal(storageEstimateLine(5), 'About $0.00 a month. The first 10 GB is free.')
  assert.equal(storageEstimateLine(10), 'About $0.00 a month. The first 10 GB is free.')
  assert.equal(storageEstimateLine(15), 'About $0.08 a month. The first 10 GB is free.')
  assert.equal(storageEstimateLine(20), 'About $0.15 a month. The first 10 GB is free.')
  assert.equal(storageEstimateLine(110), 'About $1.50 a month. The first 10 GB is free.')
})

test('storage GB field takes whole numbers of at least 1', () => {
  assert.equal(parseStorageGb('5'), 5)
  assert.equal(parseStorageGb(' 25 '), 25)
  assert.equal(parseStorageGb('0'), null)
  assert.equal(parseStorageGb('1.5'), null)
  assert.equal(parseStorageGb('-3'), null)
  assert.equal(parseStorageGb(''), null)
  assert.equal(storageGbToBytes(5), 5368709120)
})

test('a new computer is named after its hostname without .local', () => {
  assert.equal(macLabelFromHostname('Joes-MacBook-Pro.local'), 'Joes-MacBook-Pro')
  assert.equal(macLabelFromHostname('Joes-MacBook-Pro'), 'Joes-MacBook-Pro')
  assert.equal(macLabelFromHostname('STUDIO.LOCAL'), 'STUDIO')
  assert.equal(macLabelFromHostname(''), 'Mac')
  assert.equal(macLabelFromHostname('x'.repeat(60) + '.local').length, 40)
  assert.notEqual(macLabelFromHostname('Joes-MacBook-Pro.local'), 'Mac')
})

test('computer names are trimmed and capped at 40 characters', () => {
  assert.equal(macLabel('  Front desk  '), 'Front desk')
  assert.equal(macLabel('   '), '')
  assert.equal(macLabel('a'.repeat(50)).length, 40)
})

test('a computer shows as name and fingerprint, or just the fingerprint', () => {
  assert.equal(computerLine({ label: 'Joes-MacBook-Pro', fingerprint: 'AB12-CD34' }), 'Joes-MacBook-Pro · AB12-CD34')
  assert.equal(computerLine({ label: '', fingerprint: 'AB12-CD34' }), 'AB12-CD34')
})

test('wait copy names owner or scout and emergency restore is the rare path', () => {
  assert.match(MEDIA_JOIN_WAIT, /owner or scout who already has it opens Brain/)
  assert.match(MEDIA_LOST_COPY, /no other computer that already has storage can open Brain/)
  assert.doesNotMatch(MEDIA_LOST_COPY, /remove/i)
})
