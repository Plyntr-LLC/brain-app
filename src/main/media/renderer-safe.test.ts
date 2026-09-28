import assert from 'node:assert/strict'
import test from 'node:test'
import { RENDERER_UNSAFE, assertRendererSafe } from './renderer-safe.ts'

test('renderer-safe allows status-shaped objects', () => {
  assert.deepEqual(
    assertRendererSafe({
      routes: true,
      on: false,
      hasSeatToken: true,
      fingerprint: 'ABCD-EFGH',
      detail: 'On this computer.'
    }),
    {
      routes: true,
      on: false,
      hasSeatToken: true,
      fingerprint: 'ABCD-EFGH',
      detail: 'On this computer.'
    }
  )
})

test('renderer-safe refuses tokens and wraps', () => {
  assert.throws(() => assertRendererSafe({ token: 'x' }), (err: Error) => err.message === RENDERER_UNSAFE)
  assert.throws(() => assertRendererSafe({ wrap: 'x' }), (err: Error) => err.message === RENDERER_UNSAFE)
  assert.throws(() => assertRendererSafe({ dek: 'x' }), (err: Error) => err.message === RENDERER_UNSAFE)
  assert.throws(() => assertRendererSafe('pbt_secret'), (err: Error) => err.message === RENDERER_UNSAFE)
  assert.throws(() => assertRendererSafe('pms_secret'), (err: Error) => err.message === RENDERER_UNSAFE)
  assert.throws(() => assertRendererSafe({ url: 'https://x.r2.cloudflarestorage.com/o/1' }), (err: Error) => err.message === RENDERER_UNSAFE)
  assert.doesNotThrow(() => assertRendererSafe({ href: 'brain-media://3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90' }))
})
