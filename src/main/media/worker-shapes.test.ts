import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEDIA_BRAINS_PATH,
  MEDIA_CODES_EMAIL_PATH,
  MEDIA_INVITES_PATH,
  MEDIA_INVITES_REDEEM_PATH,
  MEDIA_RECLAIM_FINISH_PATH,
  MEDIA_RECLAIM_START_PATH,
  MEDIA_ROTATE_SCOPE_PATH,
  MEDIA_STATE_PATH,
  MEDIA_WRAPS_PATH,
  MEDIA_WRAP_PASSPHRASE_PATH,
  isDeviceRevokedBody,
  mediaErrorBody,
  reclaimStartHasSecrets,
  rotateDeviceWrap,
  type RotateScopeBody
} from './worker-shapes.ts'

test('Slice 5 worker error body is { error: device_revoked }', () => {
  assert.deepEqual(mediaErrorBody('device_revoked'), { error: 'device_revoked' })
  assert.equal(isDeviceRevokedBody({ error: 'device_revoked' }), true)
  assert.equal(isDeviceRevokedBody({ error: 'blocked' }), false)
  assert.equal(MEDIA_STATE_PATH, '/v1/media/state')
  assert.equal(MEDIA_WRAPS_PATH, '/v1/media/wraps')
  assert.equal(MEDIA_ROTATE_SCOPE_PATH, '/v1/media/rotate-scope')
})

test('Slice 6 reclaim and pms_ paths match the worker', () => {
  assert.equal(MEDIA_CODES_EMAIL_PATH, '/v1/media/codes/email')
  assert.equal(MEDIA_BRAINS_PATH, '/v1/media/brains')
  assert.equal(MEDIA_INVITES_PATH, '/v1/media/invites')
  assert.equal(MEDIA_INVITES_REDEEM_PATH, '/v1/media/invites/redeem')
  assert.equal(MEDIA_RECLAIM_START_PATH, '/v1/media/reclaim/start')
  assert.equal(MEDIA_RECLAIM_FINISH_PATH, '/v1/media/reclaim/finish')
  assert.equal(MEDIA_WRAP_PASSPHRASE_PATH, '/v1/media/wrap/passphrase')
  assert.equal(reclaimStartHasSecrets({ salt: 'aa', challenge: 'bb', token: 'mrc_x' }), false)
  assert.equal(reclaimStartHasSecrets({ token: 'pms_abc' }), true)
  assert.equal(reclaimStartHasSecrets({ token: 'pbt_abc' }), true)
  assert.equal(reclaimStartHasSecrets({ url: 'https://example.test/download' }), true)
})

test('rotate-scope POST body is worker camelCase', () => {
  const post: RotateScopeBody = {
    scopeId: 'scope-alpha',
    keyVersion: 1,
    dekWraps: [{ objectId: 'obj-1', dekWrap: 'aa', dekVersion: 2 }],
    wraps: [{ deviceId: 'KEEP-MAC1', ephPub: '11', nonce: '22', ciphertext: '33' }]
  }
  assert.deepEqual(Object.keys(post).sort(), ['dekWraps', 'keyVersion', 'scopeId', 'wraps'])
  assert.deepEqual(Object.keys(post.dekWraps[0]).sort(), ['dekVersion', 'dekWrap', 'objectId'])
  assert.deepEqual(Object.keys(post.wraps[0]).sort(), ['ciphertext', 'deviceId', 'ephPub', 'nonce'])
  const json = JSON.stringify(post)
  for (const snake of [
    'scope_id',
    'from_version',
    'to_version',
    'dek_wraps',
    'object_id',
    'dek_wrap',
    'dek_version',
    'device_id',
    'eph_pub',
    'key_version'
  ]) {
    assert.equal(json.includes(`"${snake}"`), false, snake)
  }
  assert.deepEqual(
    rotateDeviceWrap({
      device_id: 'KEEP-MAC1',
      scope: 'scope-alpha',
      key_version: 2,
      eph_pub: '11',
      nonce: '22',
      ciphertext: '33'
    }),
    { deviceId: 'KEEP-MAC1', ephPub: '11', nonce: '22', ciphertext: '33' }
  )
})
