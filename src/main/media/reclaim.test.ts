import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  createBrainKey,
  createRecoveryKey,
  signWithSeed,
  wrapBrainKeyWithPassphrase,
  wrapBrainKeyWithRecovery
} from './keys.ts'
import { resetMediaCodeRate, postMediaBrainsClaim, postMediaEmailCode, postMediaInvite, postMediaInviteRedeem, postReclaimFinish, postReclaimStart } from './reclaim.ts'
import { memoryMediaStore, resetMemoryMediaStore } from './store.ts'

test('reclaim/start is 403 with no wrap for project, team, revoked, and stranger', () => {
  process.env.BRAIN_APP_DRY_RUN = '1'
  resetMemoryMediaStore()
  resetMediaCodeRate()
  const userData = '/tmp/reclaim-denies'
  const brainKey = createBrainKey()
  const recovery = createRecoveryKey()
  const pass = wrapBrainKeyWithPassphrase({
    brainKey,
    passphrase: 'correct horse battery staple',
    mediaBrainId: 'brainid01brainid01brainid'
  })
  const rec = wrapBrainKeyWithRecovery({
    brainKey,
    recoveryKey: recovery.raw,
    mediaBrainId: 'brainid01brainid01brainid'
  })
  const mem = memoryMediaStore(userData)
  mem.brains.push({
    id: 'brainid01brainid01brainid',
    plyntr_brain_id: 'brain-owner',
    hq_repo: 'plyntr/alpha-brain',
    folder: '/tmp/brain',
    bucket: 'bm-x',
    bucket_status: 'on',
    cap_bytes: 10,
    used_bytes: 0,
    reserved_bytes: 0,
    brain_key_version: 1,
    brain_rotation_pending: '',
    recovery_wrap: rec.wrap.toString('hex'),
    passphrase_wrap: pass.wrap.toString('hex'),
    passphrase_salt: pass.salt.toString('hex'),
    passphrase_proof: pass.proofPublicKey.toString('hex'),
    recovery_proof: rec.proofPublicKey.toString('hex'),
    created_by_email: 'owner@example.test',
    status: 'on',
    user_data: userData
  })
  mem.seats.push(
    {
      id: 's-proj',
      media_brain_id: 'brainid01brainid01brainid',
      email: 'proj@example.test',
      role: 'project',
      roots: ['projects/alpha/'],
      status: 'active',
      kind: 'pms'
    },
    {
      id: 's-team',
      media_brain_id: 'brainid01brainid01brainid',
      email: 'team@example.test',
      role: 'team',
      roots: [],
      status: 'active',
      kind: 'pms'
    },
    {
      id: 's-rev',
      media_brain_id: 'brainid01brainid01brainid',
      email: 'was-owner@example.test',
      role: 'owner',
      roots: [],
      status: 'revoked',
      kind: 'pms'
    }
  )
  const pub = randomBytes(32).toString('hex')
  for (const email of ['proj@example.test', 'team@example.test', 'was-owner@example.test', 'stranger@example.test']) {
    const minted = postMediaEmailCode({ userData, email })
    const start = postReclaimStart({
      userData,
      email,
      code: String(minted.code || ''),
      devicePublicKey: pub,
      mediaBrainId: 'brainid01brainid01brainid'
    })
    assert.equal(start.status, 403)
    assert.equal(start.body.passphrase_wrap, undefined)
  }
})

test('reclaim/finish refuses a brain-key signature and token reuse', () => {
  process.env.BRAIN_APP_DRY_RUN = '1'
  resetMemoryMediaStore()
  resetMediaCodeRate()
  const userData = '/tmp/reclaim-finish'
  const brainKey = createBrainKey()
  const recovery = createRecoveryKey()
  const pass = wrapBrainKeyWithPassphrase({
    brainKey,
    passphrase: 'correct horse battery staple',
    mediaBrainId: 'brainid01brainid01brainid'
  })
  const rec = wrapBrainKeyWithRecovery({
    brainKey,
    recoveryKey: recovery.raw,
    mediaBrainId: 'brainid01brainid01brainid'
  })
  const mem = memoryMediaStore(userData)
  mem.brains.push({
    id: 'brainid01brainid01brainid',
    plyntr_brain_id: 'brain-owner',
    hq_repo: 'plyntr/alpha-brain',
    folder: '/tmp/brain',
    bucket: 'bm-x',
    bucket_status: 'on',
    cap_bytes: 10,
    used_bytes: 0,
    reserved_bytes: 0,
    brain_key_version: 1,
    brain_rotation_pending: '',
    recovery_wrap: rec.wrap.toString('hex'),
    passphrase_wrap: pass.wrap.toString('hex'),
    passphrase_salt: pass.salt.toString('hex'),
    passphrase_proof: pass.proofPublicKey.toString('hex'),
    recovery_proof: rec.proofPublicKey.toString('hex'),
    created_by_email: 'owner@example.test',
    status: 'on',
    user_data: userData
  })
  mem.seats.push({
    id: 's-own',
    media_brain_id: 'brainid01brainid01brainid',
    email: 'owner@example.test',
    role: 'owner',
    roots: [],
    status: 'active',
    kind: 'pms'
  })
  const pub = randomBytes(32).toString('hex')
  const minted = postMediaEmailCode({ userData, email: 'owner@example.test' })
  const start = postReclaimStart({
    userData,
    email: 'owner@example.test',
    code: String(minted.code || ''),
    devicePublicKey: pub,
    mediaBrainId: 'brainid01brainid01brainid'
  })
  assert.equal(start.status, 200)
  const sig = signWithSeed(brainKey, Buffer.from(String(start.body.challenge), 'hex'))
  const bad = postReclaimFinish({
    userData,
    token: String(start.body.token),
    signature: sig.toString('hex'),
    kind: 'brain',
    devicePublicKey: pub
  })
  assert.equal(bad.status, 403)
  assert.equal(mem.devices.length, 0)
  const reuse = postReclaimFinish({
    userData,
    token: String(start.body.token),
    signature: sig.toString('hex'),
    devicePublicKey: pub
  })
  assert.equal(reuse.status, 403)
})

test('POST /v1/media/brains {email,code} mints pms_ and refuses a used code', () => {
  process.env.BRAIN_APP_DRY_RUN = '1'
  resetMemoryMediaStore()
  resetMediaCodeRate()
  const userData = '/tmp/brains-claim'
  const minted = postMediaEmailCode({ userData, email: 'keyless@example.test' })
  const claim = postMediaBrainsClaim({
    userData,
    email: 'keyless@example.test',
    code: String(minted.code || '')
  })
  assert.equal(claim.status, 200)
  assert.equal(String(claim.seatToken || '').startsWith('pms_'), true)
  const reuse = postMediaBrainsClaim({
    userData,
    email: 'keyless@example.test',
    code: String(minted.code || '')
  })
  assert.equal(reuse.status, 401)
  const bad = postMediaBrainsClaim({ userData, email: 'keyless@example.test', code: 'NOPE' })
  assert.equal(bad.status, 401)
})

test('brains claim is 409 exists when that email already has a media brain', () => {
  process.env.BRAIN_APP_DRY_RUN = '1'
  resetMemoryMediaStore()
  resetMediaCodeRate()
  const userData = '/tmp/brains-exists'
  const mem = memoryMediaStore(userData)
  mem.brains.push({
    id: 'brainid01brainid01brainid',
    plyntr_brain_id: 'brain-owner',
    hq_repo: 'plyntr/alpha-brain',
    folder: '/tmp/brain',
    bucket: 'bm-x',
    bucket_status: 'on',
    cap_bytes: 10,
    used_bytes: 0,
    reserved_bytes: 0,
    brain_key_version: 1,
    brain_rotation_pending: '',
    recovery_wrap: 'aa',
    passphrase_wrap: 'bb',
    passphrase_salt: 'cc',
    passphrase_proof: 'dd',
    recovery_proof: 'ee',
    created_by_email: 'owner@example.test',
    status: 'on',
    user_data: userData
  })
  const minted = postMediaEmailCode({ userData, email: 'owner@example.test' })
  const claim = postMediaBrainsClaim({
    userData,
    email: 'owner@example.test',
    code: String(minted.code || '')
  })
  assert.equal(claim.status, 409)
  assert.equal(claim.body.media_brain_id, 'brainid01brainid01brainid')
  assert.equal(claim.seatToken, undefined)
})

test('media invites and redeem are pms_ only', () => {
  process.env.BRAIN_APP_DRY_RUN = '1'
  resetMemoryMediaStore()
  resetMediaCodeRate()
  const userData = '/tmp/media-invites'
  const mem = memoryMediaStore(userData)
  mem.brains.push({
    id: 'brainid01brainid01brainid',
    plyntr_brain_id: 'brain-owner',
    hq_repo: 'plyntr/alpha-brain',
    folder: '/tmp/brain',
    bucket: 'bm-x',
    bucket_status: 'on',
    cap_bytes: 10,
    used_bytes: 0,
    reserved_bytes: 0,
    brain_key_version: 1,
    brain_rotation_pending: '',
    recovery_wrap: 'aa',
    passphrase_wrap: 'bb',
    passphrase_salt: 'cc',
    passphrase_proof: 'dd',
    recovery_proof: 'ee',
    created_by_email: 'owner@example.test',
    status: 'on',
    user_data: userData
  })
  const refused = postMediaInvite({
    userData,
    mediaBrainId: 'brainid01brainid01brainid',
    email: 'friend@example.test',
    builderRole: 'owner',
    pmsBrain: false
  })
  assert.equal(refused.status, 403)
  const minted = postMediaInvite({
    userData,
    mediaBrainId: 'brainid01brainid01brainid',
    email: 'friend@example.test',
    builderRole: 'owner',
    pmsBrain: true
  })
  assert.equal(minted.status, 200)
  const redeemed = postMediaInviteRedeem({
    userData,
    email: 'friend@example.test',
    code: String(minted.code || '')
  })
  assert.equal(redeemed.status, 200)
  assert.equal(String(redeemed.seatToken || '').startsWith('pms_'), true)
  const reuse = postMediaInviteRedeem({
    userData,
    email: 'friend@example.test',
    code: String(minted.code || '')
  })
  assert.equal(reuse.status, 410)
})
