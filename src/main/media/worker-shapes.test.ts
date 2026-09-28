import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEDIA_ROTATE_SCOPE_PATH,
  MEDIA_STATE_PATH,
  MEDIA_WRAPS_PATH,
  isDeviceRevokedBody,
  mediaErrorBody
} from './worker-shapes.ts'

test('Slice 5 worker error body is { error: device_revoked }', () => {
  assert.deepEqual(mediaErrorBody('device_revoked'), { error: 'device_revoked' })
  assert.equal(isDeviceRevokedBody({ error: 'device_revoked' }), true)
  assert.equal(isDeviceRevokedBody({ error: 'blocked' }), false)
  assert.equal(MEDIA_STATE_PATH, '/v1/media/state')
  assert.equal(MEDIA_WRAPS_PATH, '/v1/media/wraps')
  assert.equal(MEDIA_ROTATE_SCOPE_PATH, '/v1/media/rotate-scope')
})
