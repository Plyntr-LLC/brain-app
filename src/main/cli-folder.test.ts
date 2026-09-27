import assert from 'node:assert/strict'
import test from 'node:test'
import { pickSeatForFolder, pickSeatForHqRepo, seatMatchesFolder } from './hq-folder.ts'
import { claudeModelsFromCache } from './claude-models.ts'
import { parseGrokModels } from './grok-models.ts'
import { spawn } from 'node:child_process'
import { formatClaudeOAuthUsage, formatClaudeStats, formatClaudeUsage } from './claude-usage.ts'
import { freeLocalPort, parseTunnelUrl, readyFromMetrics, stopChild, tunnelLogSaysUp } from './phone-lib.ts'
import {
  CLAUDE_DEFAULT_EFFORT,
  CLAUDE_DEFAULT_MODEL,
  keepClaudeModel,
  pickClaudeDefaultModel,
  resolveClaudeRun
} from '../shared/claude-defaults.ts'

test('Grok model lines keep the full id, including build-fast', () => {
  const models = parseGrokModels(`Available models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n`)
  assert.deepEqual(models.map((m) => m.id), ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6'])
})

test('Claude cache lists plan models, never Grok', () => {
  const models = claudeModelsFromCache(
    {
      cachedGrowthBookFeatures: {
        tengu_curious_tower_stateless_models: 'fable-5-1, opus-5, opus-4-8, sonnet-5'
      },
      additionalModelOptionsCache: [
        { value: 'claude-fable-5-1[1m]', label: 'Fable' }
      ]
    },
    {
      help: "Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5').",
      settingsModel: 'fable[1m]'
    }
  )
  assert.ok(models.length >= 4)
  assert.equal(
    models.some((m) => /^grok/i.test(m.id) || /grok/i.test(m.label)),
    false
  )
  assert.ok(models.some((m) => m.id.includes('fable')))
  assert.ok(models.some((m) => m.id.includes('opus')))
  assert.ok(models.some((m) => m.id.includes('sonnet')))
})

test('Claude help aliases are used when the plan cache is empty', () => {
  const models = claudeModelsFromCache(null, {
    help: "alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')"
  })
  assert.deepEqual(
    models.map((m) => m.id),
    ['fable', 'opus', 'sonnet']
  )
})

test('Claude Brain.app default is Opus 5.5 low, not Fable or the CLI settings model', () => {
  assert.equal(CLAUDE_DEFAULT_MODEL, 'claude-opus-5-5')
  assert.equal(CLAUDE_DEFAULT_EFFORT, 'low')
  assert.equal(resolveClaudeRun({}).model, 'claude-opus-5-5')
  assert.equal(resolveClaudeRun({}).effort, 'low')
  assert.equal(resolveClaudeRun({ model: 'fable[1m]', effort: 'high' }).model, 'fable[1m]')
  assert.equal(resolveClaudeRun({ model: 'fable[1m]', effort: 'high' }).effort, 'high')
  const listed = claudeModelsFromCache(
    {
      cachedGrowthBookFeatures: {
        tengu_curious_tower_stateless_models: 'fable-5-1, opus-5, opus-4-8, sonnet-5'
      },
      additionalModelOptionsCache: [{ value: 'claude-fable-5-1[1m]', label: 'Fable' }]
    },
    { settingsModel: 'fable[1m]' }
  )
  const picked = pickClaudeDefaultModel(listed)
  assert.ok(/opus-5/i.test(picked), picked)
  assert.equal(/fable/i.test(picked), false)
  const with55 = claudeModelsFromCache(
    {
      cachedGrowthBookFeatures: {
        tengu_curious_tower_stateless_models: 'fable-5-1, opus-5, opus-4-8',
        tengu_startup_announcements: [{ text: 'Opus 5.5 is now your default model' }]
      }
    },
    {}
  )
  assert.equal(pickClaudeDefaultModel(with55), 'claude-opus-5-5')
  assert.ok(with55.some((m) => m.id === 'claude-opus-5-5'))
  assert.equal(pickClaudeDefaultModel([{ id: 'opus' }, { id: 'sonnet' }]), 'opus')
  assert.equal(keepClaudeModel('fable[1m]', []), 'fable[1m]')
  assert.equal(keepClaudeModel('fable[1m]', listed), 'fable[1m]')
  assert.equal(keepClaudeModel(undefined, listed), picked)
  assert.equal(keepClaudeModel('claude-opus-5', []), 'claude-opus-5')
})

test('Claude /usage is the Claude account, never Grok', () => {
  const body = formatClaudeUsage(
    {
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'pro',
      email: 'ada@example.com',
      orgName: "ada@example.com's Organization"
    },
    '/tmp/brain'
  )
  assert.equal(body.includes('grok.com'), false)
  assert.equal(body.includes('Grok account'), false)
  assert.match(body, /Claude account/)
  assert.match(body, /Plan: Claude Pro/)
  assert.match(body, /ada@example\.com/)
  assert.match(body, /claude\.ai\/settings\/usage/)
  assert.match(body, /\/tmp\/brain/)
  assert.equal(formatClaudeUsage({ loggedIn: false }, '/tmp/brain'), 'Claude is not signed in on this Mac.')
})

test('Claude /usage stats-cache block is this Mac, never Grok', () => {
  const body = formatClaudeStats({
    lastComputedDate: '2026-07-16',
    totalSessions: 585,
    totalMessages: 120666,
    modelUsage: {
      'claude-opus-4-8': { inputTokens: 1200, outputTokens: 3400, cacheReadInputTokens: 5000, costUSD: 0 },
      'claude-fable-5': { inputTokens: 10, outputTokens: 20, costUSD: 1.5 }
    }
  })
  assert.match(body, /This Mac’s Claude Code cache/)
  assert.match(body, /Updated: 2026-07-16/)
  assert.match(body, /Sessions: 585/)
  assert.match(body, /Messages: 120,666/)
  assert.match(body, /claude-opus-4-8: in 1,200, out 3,400, cache read 5,000$/m)
  assert.match(body, /claude-fable-5: in 10, out 20, \$1\.50/)
  assert.equal(/grok/i.test(body), false)
  assert.equal(formatClaudeStats(null), '')
  assert.equal(formatClaudeStats({}), '')
})

test('HQ title follows the open folder, not the first other company seat', () => {
  const seats = [
    { id: 'jeen', mini_root: '/Users/me/Jeen-AI-Brain-test', brain_label: 'Jeen-AI-Brain-test' },
    { id: 'plyntr', mini_root: '/Users/me/agency-brain', brain_label: 'Plyntr' }
  ]
  assert.equal(pickSeatForFolder(seats, '/Users/me/agency-brain')?.brain_label, 'Plyntr')
  assert.equal(pickSeatForFolder(seats, '/Users/me/Jeen-AI-Brain-test')?.brain_label, 'Jeen-AI-Brain-test')
  assert.equal(pickSeatForFolder(seats, '/Users/me/agency-brain'), pickSeatForFolder(seats, '/Users/me/agency-brain/'))
  assert.equal(pickSeatForFolder(seats, '/Users/me/some-other-brain'), null)
  assert.equal(seatMatchesFolder({ mini_root: '/tmp/mini' }, '/tmp/mini/src'), true)
})

test('pickSeatForHqRepo only matches that HQ, never another company', () => {
  const seats = [
    { id: 'bible', mini_root: '/Users/me/Brains/bible-jj-ww', hq_repo: 'Plyntr-LLC/agency-brain' },
    { id: 'acme', mini_root: '/Users/me/Brains/acme-job', hq_repo: 'acme-org/acme-hq-brain' }
  ]
  assert.equal(pickSeatForHqRepo(seats, 'Plyntr-LLC/agency-brain')?.id, 'bible')
  assert.equal(pickSeatForHqRepo(seats, 'plyntr-llc/agency-brain')?.id, 'bible')
  assert.equal(pickSeatForHqRepo(seats, 'acme-org/acme-hq-brain')?.id, 'acme')
  assert.equal(pickSeatForHqRepo(seats, 'other/repo'), null)
  assert.equal(pickSeatForHqRepo(seats, ''), null)
})

test('Claude /usage account meter comes from the usage endpoint body, never Grok', () => {
  const usage = {
    five_hour: { utilization: 42, resets_at: '2026-09-27T21:00:00Z' },
    seven_day: { utilization: 12, resets_at: '2026-10-02T13:00:00Z' },
    extra_usage: { is_enabled: false }
  }
  const body = formatClaudeUsage({ loggedIn: true, subscriptionType: 'pro' }, '/tmp/brain', { usage }, { timeZone: 'America/New_York' })
  assert.match(body, /^Claude account\nPlan: Claude Pro/)
  assert.match(body, /Session \(5-hour\) used: 42%/)
  assert.match(body, /Weekly \(all models\) used: 12%/)
  assert.match(body, /Session resets: Sun, Sep 27, 5:00\sPM/)
  assert.match(body, /Credits left: 58%/)
  assert.match(body, /claude\.ai\/settings\/usage/)
  assert.equal(/grok\.com/i.test(body), false)
  const failed = formatClaudeUsage({ loggedIn: true, subscriptionType: 'pro' }, '/tmp/brain', { error: 'Claude answered 500.' })
  assert.match(failed, /Could not load the usage meter\. Claude answered 500\./)
  assert.match(failed, /Plan: Claude Pro/)
  assert.match(failed, /claude\.ai\/settings\/usage/)
  assert.deepEqual(formatClaudeOAuthUsage({ unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1790000000 } } }).slice(0, 1), [
    'Session (5-hour) used: 25%'
  ])
})

test('Phone tunnel log: only a registered edge connection counts as up', () => {
  const up = [
    '2026-09-27T13:46:04Z INF Registered tunnel connection connIndex=0 connection=5a22ffca-0c00-469c-afa4-2cd49c0e3846 event=0 ip=198.41.200.53 location=del05 protocol=quic',
    '{"level":"info","connIndex":1,"msg":"Registered tunnel connection","location":"sjc07","protocol":"quic"}',
    'INF Connection 3f2a9c1e-11aa-4b2c-9d0e-123456789abc registered connIndex=0 location=LAX'
  ]
  const notUp = [
    '2026-09-27T13:45:07Z INF Tunnel connection curve preferences: [X25519MLKEM768 CurveID(65074) CurveP256] connIndex=0 event=0 ip=198.41.192.47',
    '2026-09-27T13:45:07Z ERR Failed to dial a quic connection error="failed to dial to edge with quic: context canceled" connIndex=0 event=0 ip=198.41.192.47',
    'INF Unregistered tunnel connection connIndex=0 event=0 ip=198.41.200.53',
    'WRN Connection terminated error="control stream encountered a failure while serving" connIndex=0',
    'INF Retrying connection in up to 1s connIndex=0',
    'ERR failed to connect to origin: Connected to nothing',
    'INF Starting metrics server on 127.0.0.1:62217/metrics',
    ''
  ]
  for (const line of up) assert.equal(tunnelLogSaysUp(line), true, line)
  for (const line of notUp) assert.equal(tunnelLogSaysUp(line), false, line)
  assert.equal(tunnelLogSaysUp(`${notUp[0]}\n${up[0]}\n`), true)
})

test('Phone tunnel /ready: 200 with a ready connection is up, 503 is not', () => {
  assert.equal(readyFromMetrics(200, '{"status":200,"readyConnections":1,"connectorId":"x"}'), true)
  assert.equal(readyFromMetrics(503, '{"status":503,"readyConnections":0,"connectorId":"x"}'), false)
  assert.equal(readyFromMetrics(200, '{"status":200,"readyConnections":0}'), false)
  assert.equal(readyFromMetrics(404, ''), false)
})

test('Quick tunnel URL parse is unchanged', () => {
  const log = 'INF |  https://upon-jewel-particles-damages.trycloudflare.com                                    |'
  assert.equal(parseTunnelUrl(log), 'https://upon-jewel-particles-damages.trycloudflare.com')
  assert.equal(parseTunnelUrl('https://brain-phone.plyntr.com'), null)
})

test('stopChild waits for exit and escalates past a child that ignores SIGTERM', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready')"], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  await new Promise((r) => child.stdout?.once('data', r))
  const t0 = Date.now()
  await stopChild(child, { graceMs: 150, killMs: 300, capMs: 3000 })
  assert.equal(child.signalCode, 'SIGKILL')
  assert.ok(Date.now() - t0 < 2500)
  await stopChild(child)
  await stopChild(null)
  const quick = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  await stopChild(quick)
  assert.equal(quick.signalCode, 'SIGTERM')
  assert.ok((await freeLocalPort()) > 0)
})
