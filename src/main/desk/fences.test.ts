import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeskBot } from '../../shared/desk.ts'
import { parseFences } from './fences.ts'

const F = '```'

function bot(id: string, name: string): DeskBot {
  return { id, name, cli: 'grok', model: 'default', effort: 'high', description: '', file: `/tmp/${id}.md` }
}

const bots = [bot('conductor', 'Conductor'), bot('researcher', 'Researcher'), bot('writer', 'Writer'), bot('checker', 'Checker'), bot('drafts', 'Drafts')]
const conductor = { from: 'conductor', bots }
const writer = { from: 'writer', bots }
const drafts = { from: 'drafts', bots }

const block = (tag: string, body: string) => `${F}${tag}\n${body}\n${F}`
const PARSE_FAILED = { system: 'parse-failed', text: "Writer's note didn't come through, so nothing was sent." }

test('conductor blocks: assign, hire, send, remember; prose is the rest', () => {
  const text = [
    'Researcher is on it.',
    block('assign', 'bot: Researcher\ntask: Catch up on Summit\'s last note\nand list what changed.\nwhy: Summit asked for numbers.\nfiles:\n- clients/summit/notes.md\n- `clients/summit/reports/sept.md`'),
    block('hire', 'name: Designer\ncli: claude\nmodel: default\neffort: low\n\nI only write headlines. I do not send anything.'),
    block('send', 'to: writer\nfiles:\n- clients/summit/notes.md\n\nKeep it under 100 words.'),
    block('remember', '- Joe wants bullets.\n- Summit is on the September plan.'),
    'More prose after.'
  ].join('\n\n')
  const p = parseFences(text, conductor)
  assert.equal(p.prose, 'Researcher is on it.\n\nMore prose after.')
  assert.deepEqual(p.assigns, [
    { bot: 'researcher', task: "Catch up on Summit's last note and list what changed.", why: 'Summit asked for numbers.', files: ['clients/summit/notes.md', 'clients/summit/reports/sept.md'] }
  ])
  assert.deepEqual(p.hire, { name: 'Designer', cli: 'claude', model: 'default', effort: 'low', description: 'I only write headlines. I do not send anything.' })
  assert.deepEqual(p.sends, [{ to: 'writer', files: ['clients/summit/notes.md'], text: 'Keep it under 100 words.' }])
  assert.deepEqual(p.remember, ['Joe wants bullets.', 'Summit is on the September plan.'])
  assert.deepEqual(p.flags, [])
  assert.ok(!p.prose.includes(F))
})

test('worker blocks: hold, email, sms, and every browse step', () => {
  const hold = parseFences(`Need a yes.\n\n${block('hold', 'need: spend\n\nSpend $40 on the Summit boost?')}`, writer)
  assert.deepEqual(hold.hold, { need: 'spend', text: 'Spend $40 on the Summit boost?' })
  assert.equal(hold.prose, 'Need a yes.')

  const email = parseFences(block('email', 'reply: 18c2f\nto: Brent <brent@example.com>\ncc:\nsubject: September numbers\n\nSeptember numbers are in the note.\n\n- Leads up 12%.'), drafts)
  assert.deepEqual(email.email, {
    replyTo: '18c2f',
    to: 'Brent <brent@example.com>',
    cc: '',
    subject: 'September numbers',
    body: 'September numbers are in the note.\n\n- Leads up 12%.'
  })

  const sms = parseFences(block('sms', 'to: Brent\nvia: iMessage\n\nThe September note is ready.'), drafts)
  assert.deepEqual(sms.sms, { to: 'Brent', via: 'iMessage', body: 'The September note is ready.' })
  assert.equal(parseFences(block('sms', 'to: Brent\nvia: whatsapp\n\nHi.'), drafts).sms?.via, 'WhatsApp')

  const step = (line: string) => parseFences(block('browse', line), writer).browse
  assert.deepEqual(step('url: https://example.com'), { action: 'url', detail: 'https://example.com', url: 'https://example.com' })
  assert.deepEqual(step('click: Pricing'), { action: 'click', detail: 'Pricing' })
  assert.deepEqual(step('click: #3'), { action: 'click', detail: '#3' })
  assert.deepEqual(step('type: Search | summit'), { action: 'type', detail: 'Search | summit', field: 'Search', text: 'summit' })
  assert.deepEqual(step('press: Enter'), { action: 'press', detail: 'Enter' })
  assert.deepEqual(step('scroll: down'), { action: 'scroll', detail: 'down' })
  assert.deepEqual(parseFences(block('browse', 'url: file:///etc/passwd'), writer).flags, [PARSE_FAILED])
})

test('a send body that starts with "- " after the blank line is the message, not a file', () => {
  const p = parseFences(block('send', 'to: Checker\nfiles:\n- drafts/summit.md\n\n- Leads up 12%.\n- Spend flat.'), writer)
  assert.deepEqual(p.sends, [{ to: 'checker', files: ['drafts/summit.md'], text: '- Leads up 12%.\n- Spend flat.' }])
})

test('send, hold, hire, email, or sms with no blank line before the body is a parse failure', () => {
  const cases: [string, string, { from: string; bots: DeskBot[] }][] = [
    ['send', 'to: checker\nLooks good.', writer],
    ['hold', 'need: spend\nSpend $40?', writer],
    ['email', 'to: Brent\nsubject: Hi\nBody.', writer],
    ['sms', 'to: Brent\nvia: iMessage\nHi.', writer],
    ['hire', 'name: Designer\ncli: claude\nI only write headlines.', conductor]
  ]
  for (const [tag, body, who] of cases) {
    const p = parseFences(`Before.\n\n${block(tag, body)}\n\nAfter.`, who)
    const name = who.from === 'conductor' ? 'Conductor' : 'Writer'
    assert.deepEqual(p.flags, [{ system: 'parse-failed', text: `${name}'s note didn't come through, so nothing was sent.` }], tag)
    assert.equal(p.prose, 'Before.\n\nAfter.')
    assert.deepEqual([p.sends, p.assigns, p.remember], [[], [], []])
    assert.equal(p.hold ?? p.email ?? p.sms ?? p.hire ?? p.browse, null)
  }
})

test('a malformed block returns the prose plus one parse failure; nothing else from that turn is applied', () => {
  const text = `Here you go.\n\n${block('send', 'to: checker\n\nReady.')}\n\n${block('remember', '- Keep it short.')}\n\n${F}email\nto: Brent\n\nNever closed.`
  const p = parseFences(text, writer)
  assert.equal(p.prose, 'Here you go.')
  assert.deepEqual(p.flags, [PARSE_FAILED])
  assert.deepEqual(p.sends, [])
  assert.deepEqual(p.remember, [])
  assert.ok(!p.prose.includes('Never closed'))
  assert.deepEqual(parseFences(block('assign', 'task: no bot named'), conductor).flags[0].system, 'parse-failed')
})

test('a fence tagged text, or any other tag, stays in the prose', () => {
  const text = `Draft below.\n\n${block('text', 'Hi Brent,\nSeptember is up.')}\n\n${block('ts', 'const x = 1')}`
  const p = parseFences(text, drafts)
  assert.equal(p.prose, text)
  assert.equal(p.sms, null)
  assert.deepEqual(p.flags, [])
  const nested = parseFences(`${F}text\n${block('send', 'to: writer\n\nhi')}\n`, drafts)
  assert.deepEqual(nested.sends, [])
})

test('a worker assign or hire is flagged and not applied; no file comes back for it', () => {
  const p = parseFences(
    `${block('assign', 'bot: checker\ntask: Check it.\nwhy: Ready.')}\n${block('hire', 'name: Designer\ncli: claude\n\nHeadlines.')}`,
    writer
  )
  assert.deepEqual(p.assigns, [])
  assert.deepEqual(p.sends, [])
  assert.equal(p.hire, null)
  assert.deepEqual(p.flags, [
    { system: 'worker-assign', text: 'Only the conductor can hand work to someone else.' },
    { system: 'worker-hire', text: 'Only the conductor can add a teammate.' }
  ])
})

test('a hire over 800 characters or with an unknown cli is a parse failure', () => {
  const long = parseFences(block('hire', `name: Designer\ncli: claude\n\n${'x'.repeat(801)}`), conductor)
  assert.equal(long.hire, null)
  assert.deepEqual(long.flags, [{ system: 'parse-failed', text: "Conductor's note didn't come through, so nothing was sent." }])
  const cli = parseFences(block('hire', 'name: Designer\ncli: gemini\n\nHeadlines.'), conductor)
  assert.equal(cli.hire, null)
  assert.equal(cli.flags[0].system, 'parse-failed')
  assert.equal(parseFences(block('hire', `name: Designer\ncli: claude\n\n${'x'.repeat(800)}`), conductor).hire?.description.length, 800)
})

test('conductor tiles are flagged conductor-tile', () => {
  const p = parseFences(`${block('email', 'to: Brent\nsubject: Hi\n\nBody.')}\n${block('browse', 'url: https://example.com')}`, conductor)
  assert.equal(p.email, null)
  assert.equal(p.browse, null)
  assert.deepEqual(p.flags, [{ system: 'conductor-tile', text: 'Only a teammate puts that on a tile.' }])
})

test('one tile per turn; browse wins over a tile; one browse; three sends', () => {
  const two = parseFences(`${block('email', 'to: Brent\nsubject: One\n\nFirst.')}\n${block('email', 'to: Brent\nsubject: Two\n\nSecond.')}`, drafts)
  assert.equal(two.email?.subject, 'One')
  assert.deepEqual(two.flags, [{ system: 'extra-tile', text: 'One tile per turn. The rest was left out.' }])

  const mixed = parseFences(`${block('email', 'to: Brent\nsubject: One\n\nFirst.')}\n${block('hold', 'need: spend\n\nSpend $40?')}`, drafts)
  assert.equal(mixed.email?.subject, 'One')
  assert.equal(mixed.hold, null)
  assert.deepEqual(mixed.flags, [{ system: 'extra-tile', text: 'One tile per turn. The rest was left out.' }])

  const browseTile = parseFences(`${block('email', 'to: Brent\nsubject: One\n\nFirst.')}\n${block('browse', 'url: https://example.com')}`, writer)
  assert.equal(browseTile.email, null)
  assert.equal(browseTile.browse?.action, 'url')
  assert.deepEqual(browseTile.flags, [{ system: 'extra-tile', text: 'One tile per turn. The rest was left out.' }])

  const twoBrowse = parseFences(`${block('browse', 'url: https://example.com')}\n${block('browse', 'click: Pricing')}`, writer)
  assert.equal(twoBrowse.browse?.action, 'url')
  assert.deepEqual(twoBrowse.flags, [{ system: 'extra-tile', text: 'One browser step per turn.' }])

  const sends = [1, 2, 3, 4].map((n) => block('send', `to: checker\n\nNote ${n}.`)).join('\n')
  const four = parseFences(sends, writer)
  assert.deepEqual(four.sends.map((s) => s.text), ['Note 1.', 'Note 2.', 'Note 3.'])
  assert.deepEqual(four.flags, [{ system: 'extra-tile', text: 'Three handoffs per turn. The rest was left out.' }])

  const assigns = [1, 2, 3, 4].map((n) => block('assign', `bot: writer\ntask: Task ${n}.\nwhy: Because.`)).join('\n')
  const fourAssigns = parseFences(assigns, conductor)
  assert.equal(fourAssigns.assigns.length, 3)
  assert.deepEqual(fourAssigns.flags, [{ system: 'extra-tile', text: 'Three handoffs per turn. The rest was left out.' }])
})

test('a hold for anything but spend or ads is bad-hold', () => {
  const p = parseFences(block('hold', 'need: send\n\nSend the email?'), writer)
  assert.equal(p.hold, null)
  assert.deepEqual(p.flags, [{ system: 'bad-hold', text: 'Put the email or the text on a tile.' }])
  assert.equal(parseFences(block('hold', 'need: ads\n\nPause the Summit campaign?'), writer).hold?.need, 'ads')
})

test('an email or sms with a replaces: line returns no replaces value', () => {
  const e = parseFences(block('email', 'replaces: m_7\nreply:\nto: Brent\nsubject: Hi\n\nBody.'), drafts).email
  assert.ok(e)
  assert.equal('replaces' in e, false)
  assert.equal(e.replyTo, '')
  const s = parseFences(block('sms', 'to: Brent\nreplaces: m_7\nvia: iMessage\n\nHi.'), drafts).sms
  assert.ok(s)
  assert.equal('replaces' in s, false)
  assert.equal(s.to, 'Brent')
})

test('bot and to resolve by name or id; an unknown bot is flagged and dropped', () => {
  const p = parseFences(`${block('send', 'to: WRITER\n\nHi.')}\n${block('send', 'to: Designer\n\nHi.')}`, { from: 'researcher', bots })
  assert.deepEqual(p.sends.map((s) => s.to), ['writer'])
  assert.deepEqual(p.flags, [{ system: 'unknown-bot', text: "There's no one called Designer on the team." }])
  const a = parseFences(block('assign', 'bot: Nobody\ntask: Do it.\nwhy: Because.'), conductor)
  assert.deepEqual(a.assigns, [])
  assert.deepEqual(a.flags, [{ system: 'unknown-bot', text: "There's no one called Nobody on the team." }])
})

test('remember keeps at most 20 lines', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `- Line ${i}.`).join('\n')
  assert.equal(parseFences(block('remember', lines), writer).remember.length, 20)
})
