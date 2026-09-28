import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUCKET_OFF,
  DEVICE_REVOKED,
  FINISH_REMOVE,
  NO_CAP,
  OVER_CAP,
  ROTATION_PENDING,
  markMediaRevoked,
  tryReserve,
  workerStateForDevice
} from './grants.ts'
import { memoryMediaStore, resetMemoryMediaStore, type MediaBrainRow, type MediaDeviceRow } from './store.ts'

function brain(): MediaBrainRow {
  return {
    id: 'brainid01brainid01brainid',
    plyntr_brain_id: 'brain-owner',
    folder: '/tmp/brain',
    bucket: 'bm-brainid01brainid01brainid',
    bucket_status: 'on',
    cap_bytes: 1000,
    used_bytes: 0,
    reserved_bytes: 0,
    brain_key_version: 1,
    brain_rotation_pending: '',
    recovery_wrap: '',
    passphrase_wrap: '',
    passphrase_salt: '',
    passphrase_proof: '',
    recovery_proof: '',
    created_by_email: 'owner@example.test',
    status: 'on',
    user_data: '/tmp/ud'
  }
}

test('tryReserve is atomic: two sizes over the cap get one reservation', () => {
  const row = brain()
  assert.equal(tryReserve(row, 600), 'ok')
  assert.equal(row.reserved_bytes, 600)
  assert.equal(tryReserve(row, 600), OVER_CAP)
  assert.equal(row.reserved_bytes, 600)
})

test('tryReserve refuses no cap, bucket off, and brain rotation pending', () => {
  const row = brain()
  row.cap_bytes = null
  assert.equal(tryReserve(row, 10), NO_CAP)
  row.cap_bytes = 1000
  row.bucket_status = 'off'
  assert.equal(tryReserve(row, 10), BUCKET_OFF)
  row.bucket_status = 'on'
  row.brain_rotation_pending = 'team@example.test'
  assert.equal(tryReserve(row, 10), ROTATION_PENDING)
})

test('project revoke deletes wraps, flags rotation, and state is 410', () => {
  const prev = process.env.BRAIN_APP_DRY_RUN
  process.env.BRAIN_APP_DRY_RUN = '1'
  resetMemoryMediaStore()
  try {
    const mem = memoryMediaStore('/tmp/a')
    const row = brain()
    mem.brains.push(row)
    mem.scopes.push({
      id: 'scope-alpha',
      media_brain_id: row.id,
      root: 'projects/alpha/',
      key_version: 1,
      escrow_wrap: '00',
      needs_rotation: false
    })
    const device: MediaDeviceRow = {
      id: 'ABCD-EFGH',
      media_brain_id: row.id,
      email: 'alpha-person@example.test',
      fingerprint: 'ABCD-EFGH',
      public_key: 'aa'.repeat(32),
      seat_kind: 'project',
      seat_id: 'seat-b',
      roots: ['projects/alpha/'],
      status: 'approved'
    }
    mem.devices.push(device)
    mem.wraps.push({
      id: 'w1',
      media_brain_id: row.id,
      scope: 'scope-alpha',
      key_version: 1,
      target: 'device',
      device_id: device.id,
      eph_pub: '11',
      nonce: '22',
      ciphertext: '33'
    })
    const out = markMediaRevoked({
      mem,
      mediaBrainId: row.id,
      email: 'alpha-person@example.test',
      proof: false
    })
    assert.equal(out.kind, 'project')
    assert.equal(device.status, 'revoked')
    assert.equal(mem.wraps.length, 0)
    assert.equal(mem.scopes[0].needs_rotation, true)
    assert.equal(row.brain_key_version, 1)
    const state = workerStateForDevice(device)
    assert.equal(state.status, 410)
    assert.equal(state.error, DEVICE_REVOKED)
  } finally {
    resetMemoryMediaStore()
    if (prev === undefined) delete process.env.BRAIN_APP_DRY_RUN
    else process.env.BRAIN_APP_DRY_RUN = prev
  }
})

test('full-brain revoke without proof blocks and does not 410', () => {
  const prev = process.env.BRAIN_APP_DRY_RUN
  process.env.BRAIN_APP_DRY_RUN = '1'
  resetMemoryMediaStore()
  try {
    const mem = memoryMediaStore('/tmp/a')
    const row = brain()
    mem.brains.push(row)
    const device: MediaDeviceRow = {
      id: 'KEEP-MAC1',
      media_brain_id: row.id,
      email: 'scout@example.test',
      fingerprint: 'KEEP-MAC1',
      public_key: 'bb'.repeat(32),
      seat_kind: 'full',
      seat_id: 'seat-full',
      roots: [],
      status: 'approved'
    }
    mem.devices.push(device)
    mem.wraps.push({
      id: 'w2',
      media_brain_id: row.id,
      scope: 'brain',
      key_version: 1,
      target: 'device',
      device_id: device.id,
      eph_pub: '11',
      nonce: '22',
      ciphertext: '33'
    })
    const out = markMediaRevoked({
      mem,
      mediaBrainId: row.id,
      email: 'scout@example.test',
      proof: false
    })
    assert.equal(out.kind, 'blocked')
    assert.equal(device.status, 'blocked')
    assert.equal(mem.wraps.length, 1)
    assert.equal(row.brain_key_version, 1)
    assert.equal(row.brain_rotation_pending, 'scout@example.test')
    assert.equal(out.detail.startsWith(FINISH_REMOVE), true)
    const state = workerStateForDevice(device)
    assert.equal(state.status, 401)
    assert.equal(state.error, undefined)
  } finally {
    resetMemoryMediaStore()
    if (prev === undefined) delete process.env.BRAIN_APP_DRY_RUN
    else process.env.BRAIN_APP_DRY_RUN = prev
  }
})
