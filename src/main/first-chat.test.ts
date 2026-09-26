import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  agentsMdLooksFilled,
  contextNamesLookNew,
  firstChatWelcome,
  SEED_AGENTS_MD,
  shouldOfferFirstChat
} from '../shared/first-chat.ts'

const fixtureAgents = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../resources/fixtures/plyntr-brain/AGENTS.md'),
  'utf8'
)

test('a new brain is the one that still has TEMPLATE files', () => {
  assert.equal(contextNamesLookNew(['context/TEMPLATE-business-overview.md']), true)
  assert.equal(contextNamesLookNew(['context/TEMPLATE-business.md']), true)
  assert.equal(contextNamesLookNew(['context/business/TEMPLATE-voice.md']), true)
  assert.equal(contextNamesLookNew(['context/business/business-overview.md', 'AGENTS.md']), false)
  assert.equal(contextNamesLookNew([]), false)
})

test('the first chat welcome asks for the business and only that once', () => {
  const text = firstChatWelcome('sept-21-co')
  assert.match(text, /Welcome\. sept-21-co is on this computer/)
  assert.match(text, /What it does, who it is for, and what you sell/)
  assert.equal(text.includes('—'), false)
  assert.equal(firstChatWelcome('').includes('this brain'), true)
})

test('seed AGENTS.md from the Path B fixture is not filled', () => {
  assert.equal(agentsMdLooksFilled(fixtureAgents), false)
  assert.equal(agentsMdLooksFilled(SEED_AGENTS_MD), false)
  assert.equal(agentsMdLooksFilled(''), false)
  assert.equal(agentsMdLooksFilled('agency copy'), false)
  assert.equal(agentsMdLooksFilled(`${SEED_AGENTS_MD}\nWe sell sheds to homeowners.`), true)
})

test('first chat is only for the person filling a blank brain', () => {
  const templates = ['context/TEMPLATE-business.md']
  assert.equal(
    shouldOfferFirstChat({ relPaths: templates, agentsMd: fixtureAgents, markerPresent: false }),
    true
  )
  assert.equal(
    shouldOfferFirstChat({
      relPaths: templates,
      agentsMd: `${fixtureAgents}\nWe sell sheds to homeowners.`,
      markerPresent: false
    }),
    false
  )
  assert.equal(
    shouldOfferFirstChat({ relPaths: templates, agentsMd: fixtureAgents, markerPresent: true }),
    false
  )
  assert.equal(
    shouldOfferFirstChat({
      relPaths: ['context/business/business-overview.md'],
      agentsMd: fixtureAgents,
      markerPresent: false
    }),
    false
  )
  assert.equal(
    shouldOfferFirstChat({ relPaths: templates, agentsMd: fixtureAgents, markerPresent: false, role: 'team' }),
    false
  )
  assert.equal(
    shouldOfferFirstChat({ relPaths: templates, agentsMd: fixtureAgents, markerPresent: false, role: 'owner' }),
    true
  )
})
