import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldShowStorageAsk } from './media.ts'

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

test('storage-ask still skips team, project, keyless, and asked paths when routes are live', () => {
  assert.equal(shouldShowStorageAsk({ ...eligible, role: 'team' }), false)
  assert.equal(shouldShowStorageAsk({ ...eligible, role: 'project' }), false)
  assert.equal(shouldShowStorageAsk({ ...eligible, hasSeatToken: false }), false)
  assert.equal(shouldShowStorageAsk({ ...eligible, joe: true, hasSeatToken: false }), false)
  assert.equal(shouldShowStorageAsk({ ...eligible, storageOn: true }), false)
  assert.equal(shouldShowStorageAsk({ ...eligible, mediaAsked: true }), false)
})
