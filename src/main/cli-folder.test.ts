import assert from 'node:assert/strict'
import test from 'node:test'
import { pickSeatForFolder, pickSeatForHqRepo, seatMatchesFolder } from './hq-folder.ts'
import { claudeModelsFromCache } from './claude-models.ts'
import { parseGrokModels } from './grok-models.ts'
import { formatClaudeUsage } from './claude-usage.ts'
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
