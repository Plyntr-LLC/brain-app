// Run: npx esbuild src/main/ads2ai.test.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/a.test.mjs && node --test /tmp/a.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { installStatus, myTeams, requestCode, resolveInvite, verifyCode } from './ads2ai.ts'

function withEnv(on: boolean, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const keep = { dry: process.env.BRAIN_APP_DRY_RUN, drive: process.env.BRAIN_APP_SETUP_DRIVE }
    if (on) {
      process.env.BRAIN_APP_DRY_RUN = '1'
      process.env.BRAIN_APP_SETUP_DRIVE = '1'
    } else {
      delete process.env.BRAIN_APP_DRY_RUN
      delete process.env.BRAIN_APP_SETUP_DRIVE
    }
    try {
      await fn()
    } finally {
      for (const [k, v] of [['BRAIN_APP_DRY_RUN', keep.dry], ['BRAIN_APP_SETUP_DRIVE', keep.drive]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }
}

test('the setup drive gets fixed Ads2AI answers and never fetches', withEnv(true, async () => {
  const real = globalThis.fetch
  let fetched = 0
  globalThis.fetch = (async () => {
    fetched++
    throw new Error('network')
  }) as typeof fetch
  try {
    const inv = await resolveInvite('AGNCYTST')
    assert.equal(inv.teamSlug, 'dry-agency')
    assert.equal(inv.member?.role, 'scout')
    await assert.rejects(resolveInvite('OTHER123'), /not found/)
    assert.deepEqual(await requestCode('ada@example.com'), { ok: true })
    await assert.rejects(requestCode('nobody@example.com'), /No Agency Brain account/)
    assert.equal((await verifyCode('ada@example.com', '246810')).token, 'dry-agency-token')
    await assert.rejects(verifyCode('ada@example.com', '111111'), /did not work/)
    assert.equal((await myTeams('dry-agency-token')).teams[0].slug, 'dry-agency')
    assert.deepEqual(await installStatus('dry-agency'), { installed: false })
    assert.equal(fetched, 0)
  } finally {
    globalThis.fetch = real
  }
}))

test('dry run alone (plain npm run dev) still reaches Ads2AI', withEnv(false, async () => {
  process.env.BRAIN_APP_DRY_RUN = '1'
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url))
    return new Response(JSON.stringify({ memberToken: 't', teamSlug: 'live' }), { status: 200 })
  }) as typeof fetch
  try {
    assert.equal((await resolveInvite('AGNCYTST')).teamSlug, 'live')
    assert.match(urls[0] || '', /invite-resolve\?token=AGNCYTST/)
  } finally {
    globalThis.fetch = real
  }
}))
