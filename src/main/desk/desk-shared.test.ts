import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FALLBACK_ATTEMPTS,
  PAY_HOLD,
  PAY_REFUSE,
  botHire,
  botIdFromName,
  descriptionError,
  fallbackChain,
  isoWeek,
  payCheck,
  resolveBot
} from '../../shared/desk.ts'
import type { DeskBot, DeskCli, DeskSendResult, DeskWelcome, PageAdapter } from '../../shared/desk.ts'

const ALL: DeskCli[] = ['grok', 'claude', 'gpt', 'cursor']

function bot(over: Partial<DeskBot> = {}): DeskBot {
  return { id: 'writer', name: 'Writer', cli: 'claude', model: 'claude-opus-5-5', effort: 'low', description: 'I draft.', file: '/tmp/writer.md', ...over }
}

test('fallbackChain: picked pair, same CLI on default, then the others in order, at most four', () => {
  const chain = fallbackChain(bot(), ALL)
  assert.deepEqual(chain, [
    { cli: 'claude', model: 'claude-opus-5-5' },
    { cli: 'claude', model: 'default' },
    { cli: 'grok', model: 'default' },
    { cli: 'cursor', model: 'default' }
  ])
  assert.equal(chain.length, FALLBACK_ATTEMPTS)
})

test('fallbackChain: model already default has no same-CLI default step', () => {
  assert.deepEqual(fallbackChain(bot({ model: 'default' }), ALL), [
    { cli: 'claude', model: 'default' },
    { cli: 'grok', model: 'default' },
    { cli: 'cursor', model: 'default' },
    { cli: 'gpt', model: 'default' }
  ])
})

test('fallbackChain: try 1 stays when its CLI is missing; later steps skip missing CLIs', () => {
  assert.deepEqual(fallbackChain(bot(), ['grok', 'gpt']), [
    { cli: 'claude', model: 'claude-opus-5-5' },
    { cli: 'grok', model: 'default' },
    { cli: 'gpt', model: 'default' }
  ])
  assert.deepEqual(fallbackChain(bot(), []), [{ cli: 'claude', model: 'claude-opus-5-5' }])
  const chain = fallbackChain(bot({ cli: 'cursor', model: 'composer-2' }), ALL)
  assert.equal(new Set(chain.map((p) => `${p.cli}/${p.model}`)).size, chain.length)
  assert.deepEqual(chain[0], { cli: 'cursor', model: 'composer-2' })
})

test('payCheck: whole words; hold wins over refuse', () => {
  assert.equal(payCheck('Pay now'), 'hold')
  assert.equal(payCheck('Submit'), 'refuse')
  assert.equal(payCheck('Save'), 'hold')
  assert.equal(payCheck('payment'), null)
  assert.equal(payCheck('Place order'), 'hold')
  assert.equal(payCheck('Complete purchase'), 'hold')
  assert.equal(payCheck('Send message'), 'refuse')
  assert.equal(payCheck('Post'), 'refuse')
  assert.equal(payCheck('Apply'), 'hold')
  assert.equal(payCheck('Pricing'), null)
  assert.equal(payCheck('Submit and pay'), 'hold')
})

test('PAY_HOLD and PAY_REFUSE lists', () => {
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  assert.ok(words('Pay now').some((w) => (PAY_HOLD as readonly string[]).includes(w)))
  assert.ok(!words('payment').some((w) => (PAY_HOLD as readonly string[]).includes(w)))
  assert.ok((PAY_REFUSE as readonly string[]).includes('submit'))
  assert.ok(!(PAY_REFUSE as readonly string[]).includes('pay'))
})

test('isoWeek is stable for a known Thursday and across the year turn', () => {
  assert.equal(isoWeek(new Date(2026, 9, 8, 12)), '2026-W41')
  assert.equal(isoWeek(new Date(2026, 9, 8, 0, 1)), '2026-W41')
  assert.equal(isoWeek(new Date(2026, 9, 8, 23, 59)), '2026-W41')
  assert.equal(isoWeek(new Date(2026, 0, 1, 12)), '2026-W01')
  assert.equal(isoWeek(new Date(2027, 0, 1, 12)), '2026-W53')
  assert.equal(isoWeek(new Date(2024, 11, 30, 12)), '2025-W01')
})

test('resolveBot matches id or name, any case', () => {
  const bots = [bot(), bot({ id: 'designer-2', name: 'Designer 2' }), bot({ id: 'designer', name: 'Designer' })]
  for (const s of ['writer', 'Writer', 'WRITER', ' writer ']) assert.equal(resolveBot(bots, s)?.id, 'writer')
  assert.equal(resolveBot(bots, 'Designer')?.id, 'designer')
  assert.equal(resolveBot(bots, 'Designer 2')?.id, 'designer-2')
  assert.equal(resolveBot(bots, 'Nobody'), null)
  assert.equal(resolveBot(bots, ''), null)
})

test('botIdFromName: slug, clash on id or name, keeps counting', () => {
  const none = { ids: [], names: [] }
  assert.equal(botIdFromName('Ad Checker', none), 'ad-checker')
  assert.equal(botIdFromName('Ad-Checker', none), 'ad-checker')
  assert.equal(botIdFromName('  Ad -- Checker!! ', none), 'ad-checker')
  const ad = { ids: ['ad-checker'], names: ['Ad Checker'] }
  assert.equal(botIdFromName('Ad Checker', ad), 'ad-checker-2')
  assert.equal(botIdFromName('Ad-Checker', ad), 'ad-checker-2')
  assert.equal(botIdFromName('Designer', { ids: ['designer'], names: ['Designer'] }), 'designer-2')
  assert.equal(botIdFromName('Scribe', { ids: ['writer'], names: ['scribe'] }), 'scribe-2')
  assert.equal(botIdFromName('Designer', { ids: ['designer', 'designer-2'], names: ['Designer'] }), 'designer-3')
  assert.equal(botIdFromName('Designer', { ids: ['designer'], names: ['Designer', 'Designer 2'] }), 'designer-3')
  assert.deepEqual(botHire('Designer', { ids: ['designer'], names: ['Designer', 'Designer 2'] }), { id: 'designer-3', name: 'Designer 3' })
  assert.deepEqual(botHire('Designer', { ids: ['designer'], names: ['Designer'] }), { id: 'designer-2', name: 'Designer 2' })
  assert.deepEqual(botHire('Designer', none), { id: 'designer', name: 'Designer' })
})

test('descriptionError is the form sentence', () => {
  assert.equal(descriptionError('x'.repeat(800)), null)
  assert.equal(descriptionError('x'.repeat(912)), 'Keep it under 800 characters (now 912).')
})

test('DeskWelcome, DeskSendResult, and PageAdapter with submitFor are exported', async () => {
  const welcome: DeskWelcome = {
    greetingName: null,
    greeting: 'Hi.',
    starters: [],
    readiness: [],
    composerDisabled: false,
    composerPlaceholder: 'Message Conductor',
    everyoneLine: null
  }
  const sent: DeskSendResult = { ok: true, dryRun: true, note: 'Dry run. Nothing left this Mac.' }
  const page: PageAdapter = {
    goto: async () => {},
    snapshot: async () => ({ url: '', title: '', text: '', controls: [], hasPassword: false }),
    click: async () => {},
    type: async () => {},
    submit: async () => {},
    submitFor: async (i) => ({ index: i + 1, name: 'Search' }),
    scroll: async () => {}
  }
  assert.equal(welcome.greeting, 'Hi.')
  assert.equal(sent.ok, true)
  assert.deepEqual(await page.submitFor(2), { index: 3, name: 'Search' })
})
