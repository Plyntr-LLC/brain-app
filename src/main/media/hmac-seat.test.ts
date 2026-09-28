import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HMAC_KIND,
  PBT_ON_PROJECT,
  assertHmacProjectToken,
  mintProjectHmacToken,
  normalizeMediaRoot,
  rootsOverlap,
  verifyProjectHmacToken
} from './hmac-seat.ts'

test('HMAC project token is not pbt_ and round-trips roots', () => {
  const prev = process.env.BRAIN_SYNC_SEAT_TOKEN_KEY
  process.env.BRAIN_SYNC_SEAT_TOKEN_KEY = 'check-media-seat-key'
  try {
    const token = mintProjectHmacToken({
      seat_id: 'seat-b',
      email: 'alpha-person@example.test',
      hq_repo: 'plyntr/alpha-brain',
      device_id: 'devb',
      roots: ['projects/alpha/']
    })
    assert.equal(token.startsWith('pbt_'), false)
    assert.equal(token.startsWith('pms_'), false)
    assert.equal(token.includes('.'), true)
    const verified = verifyProjectHmacToken(token)
    assert.equal(verified.ok, true)
    if (!verified.ok) return
    assert.equal(verified.payload.kind, HMAC_KIND)
    assert.deepEqual(verified.payload.roots, ['projects/alpha/'])
    assert.equal(verified.payload.email, 'alpha-person@example.test')
    assert.throws(() => assertHmacProjectToken('pbt_owner_slice2'), (err: Error) => err.message === PBT_ON_PROJECT)
  } finally {
    if (prev === undefined) delete process.env.BRAIN_SYNC_SEAT_TOKEN_KEY
    else process.env.BRAIN_SYNC_SEAT_TOKEN_KEY = prev
  }
})

test('HMAC verify fails with the wrong secret', () => {
  const prev = process.env.BRAIN_SYNC_SEAT_TOKEN_KEY
  process.env.BRAIN_SYNC_SEAT_TOKEN_KEY = 'one'
  try {
    const token = mintProjectHmacToken({
      seat_id: 's',
      email: 'a@b.test',
      hq_repo: 'org/repo',
      device_id: 'd',
      roots: ['beta']
    })
    process.env.BRAIN_SYNC_SEAT_TOKEN_KEY = 'two'
    const verified = verifyProjectHmacToken(token)
    assert.equal(verified.ok, false)
  } finally {
    if (prev === undefined) delete process.env.BRAIN_SYNC_SEAT_TOKEN_KEY
    else process.env.BRAIN_SYNC_SEAT_TOKEN_KEY = prev
  }
})

test('normalizeMediaRoot and overlap', () => {
  assert.equal(normalizeMediaRoot('alpha'), 'projects/alpha/')
  assert.equal(normalizeMediaRoot('projects/alpha'), 'projects/alpha/')
  assert.equal(rootsOverlap(['projects/alpha/'], 'projects/alpha/'), true)
  assert.equal(rootsOverlap(['projects/beta/'], 'projects/alpha/'), false)
})

test('brain-sync tokens.js verifySeatToken accepts minted HMAC tokens', async () => {
  const prev = process.env.BRAIN_SYNC_SEAT_TOKEN_KEY
  process.env.BRAIN_SYNC_SEAT_TOKEN_KEY = 'check-media-seat-key'
  try {
    const token = mintProjectHmacToken({
      seat_id: 'seat-b',
      email: 'alpha-person@example.test',
      hq_repo: 'plyntr/alpha-brain',
      device_id: 'devb',
      roots: ['projects/alpha/']
    })
    const { pathToFileURL } = await import('node:url')
    const { join } = await import('node:path')
    const tokens = (await import(
      pathToFileURL(join(process.cwd(), 'vendor/brain-sync/src/tokens.js')).href
    )) as {
      verifySeatToken: (
        token: string,
        secret: string
      ) => Promise<{ ok: boolean; payload?: { kind?: string; email?: string; hq_repo?: string; roots?: string[] } }>
    }
    const verified = await tokens.verifySeatToken(token, 'check-media-seat-key')
    assert.equal(verified.ok, true)
    assert.equal(verified.payload?.kind, HMAC_KIND)
    assert.equal(verified.payload?.email, 'alpha-person@example.test')
    assert.equal(verified.payload?.hq_repo, 'plyntr/alpha-brain')
    assert.deepEqual(verified.payload?.roots, ['projects/alpha/'])
  } finally {
    if (prev === undefined) delete process.env.BRAIN_SYNC_SEAT_TOKEN_KEY
    else process.env.BRAIN_SYNC_SEAT_TOKEN_KEY = prev
  }
})
