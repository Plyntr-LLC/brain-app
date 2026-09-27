import assert from 'node:assert/strict'
import test from 'node:test'
import { MAIL_FAILED, sendCodesEverywhere, sendCodesOrProjectFallback, tryCodeEverywhere } from './code-fanout.ts'
import { CODE_NOT_LIVE, CODE_UNREACHABLE, GONE_BRAIN_CODE } from '../shared/plyntr-org-copy.ts'

test('sends to every system at once and reports each one that mailed', async () => {
  const started: string[] = []
  const out = await sendCodesEverywhere({
    ads2ai: async () => {
      started.push('ads2ai')
      return true
    },
    'hq-sync': async () => {
      started.push('hq-sync')
      throw new Error('That email is not on a project.')
    },
    plyntr: async () => {
      started.push('plyntr')
      return true
    }
  })
  assert.deepEqual(out.sent, ['ads2ai', 'plyntr'])
  assert.equal(started.length, 3)
})

test('a slow system does not hold the others past the timeout', async () => {
  const t0 = Date.now()
  const out = await sendCodesEverywhere({
    ads2ai: () => new Promise<boolean>(() => {}),
    plyntr: async () => true
  }, 50)
  // ads2ai never answers; withTimeout caps it, so the fan-out still resolves with plyntr.
  assert.deepEqual(out.sent, ['plyntr'])
  assert.ok(Date.now() - t0 < 1000)
})

test('no live system gives the fresh-invite line; all offline gives the connection line', async () => {
  await assert.rejects(
    sendCodesEverywhere({ ads2ai: async () => { throw new Error('No account') }, plyntr: async () => { throw new Error('not added') } }),
    { message: CODE_NOT_LIVE }
  )
  await assert.rejects(
    sendCodesEverywhere({ ads2ai: async () => { throw new TypeError('fetch failed') }, plyntr: async () => { throw new Error('timed out') } }),
    { message: CODE_UNREACHABLE }
  )
  await assert.rejects(sendCodesEverywhere({ plyntr: async () => false }), { message: MAIL_FAILED })
})

test('a system that always answers ok does not count as a place the address is on', async () => {
  await assert.rejects(
    sendCodesEverywhere({ 'hq-sync': async () => null, ads2ai: async () => { throw new Error('No account') } }),
    { message: CODE_NOT_LIVE }
  )
  const out = await sendCodesEverywhere({ 'hq-sync': async () => null, plyntr: async () => true })
  assert.deepEqual(out.sent, ['plyntr'])
})

test('a code tries each system and shows the gone-brain line instead of not found', async () => {
  assert.equal(await tryCodeEverywhere([async () => { throw new Error('not found') }, async () => 'ok']), 'ok')
  await assert.rejects(
    tryCodeEverywhere([
      async () => { throw new Error('not found') },
      async () => { throw new Error(GONE_BRAIN_CODE) },
      async () => { throw new Error('not found') }
    ]),
    { message: GONE_BRAIN_CODE }
  )
})

test('a new Mac still asks project sync when Agency Brain and Plyntr both miss', async () => {
  let project = 0
  const out = await sendCodesOrProjectFallback(
    {
      ads2ai: async () => {
        throw new Error('No account')
      },
      plyntr: async () => {
        throw new Error('not added')
      }
    },
    async () => {
      project += 1
    }
  )
  assert.deepEqual(out.sent, ['hq-sync'])
  assert.equal(out.hedge, true)
  assert.equal(project, 1)
})
