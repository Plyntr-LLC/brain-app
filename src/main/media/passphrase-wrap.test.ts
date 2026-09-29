import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrainKey, unwrapBrainKeyWithPassphrase, wrapBrainKeyWithPassphrase } from './keys.ts'
import { sealedPassphraseWrap } from './passphrase-wrap.ts'

const PASS = 'willow canyon maple velvet lantern quartz'
const ID = 'a0b5f9811a0da111794c019aca012bef'

test('combined wrap hex and nonce+ciphertext+tag both unwrap the brain key', () => {
  const brainKey = createBrainKey()
  const made = wrapBrainKeyWithPassphrase({ brainKey, passphrase: PASS, mediaBrainId: ID })
  const sealed = made.wrap
  const base = { salt: made.salt.toString('hex'), N: made.N, r: made.r, p: made.p }
  const combined = sealedPassphraseWrap({ ...base, wrap: sealed.toString('hex') })
  const split = sealedPassphraseWrap({
    ...base,
    nonce: sealed.subarray(0, 12).toString('hex'),
    ciphertext: sealed.subarray(12, sealed.length - 16).toString('hex'),
    tag: sealed.subarray(sealed.length - 16).toString('hex')
  })
  assert.equal(combined.equals(sealed), true)
  assert.equal(split.equals(sealed), true)
  const opened = unwrapBrainKeyWithPassphrase({
    wrap: { salt: made.salt, N: made.N, r: made.r, p: made.p, wrap: split, proofPublicKey: Buffer.alloc(0) },
    passphrase: PASS,
    mediaBrainId: ID
  })
  assert.equal(opened.equals(brainKey), true)
})

test('empty or malformed wraps give an empty blob', () => {
  assert.equal(sealedPassphraseWrap(undefined).length, 0)
  assert.equal(sealedPassphraseWrap({ salt: 'aa', N: 1, r: 8, p: 1 }).length, 0)
  assert.equal(sealedPassphraseWrap({ wrap: 'not hex' }).length, 0)
  assert.equal(sealedPassphraseWrap({ nonce: 'aa' }).length, 0)
  assert.equal(sealedPassphraseWrap({ wrap: '', nonce: 'aabb', ciphertext: 'cc', tag: 'dd' }).toString('hex'), 'aabbccdd')
})
