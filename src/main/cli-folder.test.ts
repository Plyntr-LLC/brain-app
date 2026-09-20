import assert from 'node:assert/strict'
import test from 'node:test'
import { pickSeatForFolder, seatMatchesFolder } from './hq-folder.ts'
import { claudeModelsFromCache } from './claude-models.ts'

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
