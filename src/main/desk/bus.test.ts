import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CONDUCTOR, ME } from '../../shared/desk.ts'
import type { DeskMessage } from '../../shared/desk.ts'
import { LATE_TEXT, createDeskBus, jobIsOpen } from './bus.ts'
import type { JobView, PostResult, Turn } from './bus.ts'
import { mailFile } from './paths.ts'
import { seedDesk } from './seed.ts'
import { createDeskStore } from './store.ts'
import type { NewDeskMessage } from './store.ts'

function setup() {
  const brain = mkdtempSync(join(tmpdir(), 'desk-bus-'))
  seedDesk({ brain, role: 'owner', detect: () => ({ grok: true, claude: false, gpt: false, cursor: false }) })
  const store = createDeskStore({ brain, role: 'owner' })
  const turns: Turn[] = []
  const bus = createDeskBus({ store, wake: (t) => void turns.push(t) })
  const last = (id: string) => turns.filter((t) => t.botId === id).at(-1) as Turn
  return { brain, store, bus, turns, last }
}

const person = (to: string, text: string, extra: Partial<NewDeskMessage> = {}): NewDeskMessage => ({ from: ME, to, kind: 'task', text, ...extra })
const send = (from: string, to: string, text: string, extra: Partial<NewDeskMessage> = {}): NewDeskMessage => ({ from, to, kind: 'send', text, ...extra })
const pack = (to: string, text: string): NewDeskMessage => ({ from: CONDUCTOR, to, kind: 'pack', text, pack: { why: 'It matters.', files: [], dropped: [] } })
const reply = (from: string, text: string): NewDeskMessage => ({ from, to: ME, kind: 'reply', text })
const report = (from: string, text: string): NewDeskMessage => ({ from, to: ME, kind: 'report', text, report: { seconds: 60 } })
const EMAIL = { replyTo: '', to: 'Brent <brent@example.com>', cc: '', subject: 'September numbers', body: 'They are in the note.', from: 'joe@example.com', sendable: true }
const emailTile = (from: string): NewDeskMessage => ({ from, to: ME, kind: 'email', text: '', email: EMAIL })
const stamp = (tile: DeskMessage, sent: 'yes' | 'no'): NewDeskMessage => ({
  from: tile.from,
  to: tile.to,
  kind: 'email',
  text: '',
  replaces: tile.id,
  email: { ...EMAIL, sent },
  ...(sent === 'yes' ? { actedAt: '2026-10-07T09:20:00.000Z' } : {})
})

function msgOf(r: PostResult): DeskMessage {
  assert.ok('msg' in r, `expected a stored message, got ${JSON.stringify(r)}`)
  return r.msg
}

const texts = (t: Turn) => t.batch.map((m) => m.text)

test('post appends a message and wakes only the to bot; a post to the conductor does not wake Researcher', () => {
  const { bus, turns, store } = setup()
  const r = bus.post(person('writer', 'Draft the Summit reply.'))
  assert.equal(r.status, 'queued')
  assert.equal(r.status === 'queued' && r.started, true)
  assert.deepEqual(turns.map((t) => t.botId), ['writer'])
  assert.deepEqual(texts(turns[0]), ['Draft the Summit reply.'])
  assert.equal(store.readMail().length, 1)
  bus.post(person('conductor', 'Where are we?'))
  assert.deepEqual(turns.map((t) => t.botId), ['writer', 'conductor'])
  assert.equal(bus.state('researcher').state, 'idle')
  assert.deepEqual(bus.queued('researcher'), [])
})

test('an unknown to returns the no-one sentence and writes nothing; a name resolves to the id', () => {
  const { bus, brain, turns } = setup()
  assert.deepEqual(bus.post(person('Designer', 'Make a logo.')), { status: 'error', error: "There's no one called Designer on the team." })
  assert.equal(existsSync(mailFile(brain)), false)
  assert.equal(turns.length, 0)
  const msg = msgOf(bus.post(person('WRITER', 'Hi.')))
  assert.equal(msg.to, 'writer')
  assert.equal(turns[0].botId, 'writer')
})

test('a wake takes only the oldest job by creation time, not by id or arrival', () => {
  const { bus, turns, last } = setup()
  bus.post(person('writer', 'Start.'))
  const first = last('writer')
  // Posted j_9, then j_10, then j_2. Created j_10 (09:00), j_9 (09:05), j_2 (09:10).
  bus.post(send('researcher', 'writer', 'nine', { job: 'j_9', ts: '2026-10-07T09:05:00.000Z' }))
  bus.post(send('checker', 'writer', 'ten', { job: 'j_10', ts: '2026-10-07T09:00:00.000Z' }))
  bus.post(send('researcher', 'writer', 'two', { job: 'j_2', ts: '2026-10-07T09:10:00.000Z' }))
  assert.equal(turns.length, 1)
  bus.endTurn('writer', first.id)
  assert.equal(last('writer').job, 'j_10')
  assert.deepEqual(texts(last('writer')), ['ten'])
  assert.deepEqual(bus.queued('writer').map((m) => m.job), ['j_9', 'j_2'])
  bus.endTurn('writer')
  assert.equal(last('writer').job, 'j_9')
  bus.endTurn('writer')
  assert.equal(last('writer').job, 'j_2')
  assert.deepEqual(bus.queued('writer'), [])
})

test('an idle Writer waiting on Checker keeps its one open job; a send on another job waits until that job closes', () => {
  const { bus, turns, last } = setup()
  const j1 = msgOf(bus.post(person('writer', 'Draft it.'))).job as string
  bus.post(send('writer', 'checker', 'Here is the draft.'))
  bus.endTurn('writer')
  assert.deepEqual(bus.state('writer'), { state: 'waiting-bot', on: 'checker' })
  assert.equal(last('checker').job, j1)

  const j2 = msgOf(bus.post(person('researcher', 'Find the September note.'))).job as string
  assert.notEqual(j2, j1)
  const before = turns.length
  const handoff = msgOf(bus.post(send('researcher', 'writer', 'Notes for a second piece.')))
  assert.equal(handoff.job, j2)
  assert.equal(turns.length, before)
  assert.deepEqual(bus.queued('writer').map((m) => m.id), [handoff.id])
  assert.equal(bus.openJob('writer'), j1)
  assert.equal(bus.state('writer').state, 'waiting-bot')

  bus.post(report('checker', 'Ready.'))
  assert.deepEqual(bus.endTurn('checker'), { job: j1, open: false })
  assert.equal(bus.isClosed(j1), true)
  assert.equal(last('writer').job, j2)
  assert.deepEqual(texts(last('writer')), ['Notes for a second piece.'])
  assert.equal(bus.openJob('writer'), j2)
})

test('a bot in waiting-you starts a turn for a person or the conductor; a worker send waits until the tile is answered', () => {
  const { bus, turns, last } = setup()
  const job = msgOf(bus.post(person('writer', 'Get a reply out to Brent.'))).job as string
  bus.post(send('writer', 'drafts', 'Put this on a tile.'))
  bus.endTurn('writer')
  const tile = msgOf(bus.post(emailTile('drafts')))
  assert.equal(tile.job, job)
  assert.deepEqual(bus.endTurn('drafts'), { job, open: true })
  assert.deepEqual(bus.state('drafts'), { state: 'waiting-you' })

  bus.post(person('writer', 'Tell Drafts to sign it from Joe.'))
  const before = turns.length
  const waiting = msgOf(bus.post(send('writer', 'drafts', 'Sign it from Joe.')))
  bus.endTurn('writer')
  assert.equal(waiting.job, job)
  assert.equal(turns.length, before)
  assert.deepEqual(bus.queued('drafts').map((m) => m.id), [waiting.id])

  bus.post(person('drafts', 'Shorter.'))
  assert.deepEqual(texts(last('drafts')), ['Shorter.'])
  assert.deepEqual(bus.queued('drafts').map((m) => m.id), [waiting.id])
  bus.post(reply('drafts', 'Trimmed it.'))
  bus.endTurn('drafts')
  assert.deepEqual(bus.state('drafts'), { state: 'waiting-you' })

  bus.post(person(CONDUCTOR, 'Have Drafts add the date.'))
  const viaConductor = msgOf(bus.post(send(CONDUCTOR, 'drafts', 'Add the date.')))
  assert.equal(viaConductor.job, job)
  assert.deepEqual(texts(last('drafts')), ['Add the date.'])
  bus.endTurn('drafts')
  bus.endTurn(CONDUCTOR)

  const count = turns.length
  const r = bus.answer(stamp(tile, 'yes'))
  assert.equal(r.status, 'queued')
  assert.equal(turns.length, count + 1)
  assert.deepEqual(last('drafts').batch.map((m) => m.id).sort(), [waiting.id, msgOf(r).id].sort())
})

test('two workers each waiting on the other: the newer job stops with the each-waiting line and the older send starts', () => {
  const { bus, store, last } = setup()
  const j1 = msgOf(bus.post(person('writer', 'Draft it.', { ts: '2026-10-07T09:00:00.000Z' }))).job as string
  const j2 = msgOf(bus.post(person('checker', 'Check the old one.', { ts: '2026-10-07T09:01:00.000Z' }))).job as string
  const toChecker = msgOf(bus.post(send('writer', 'checker', 'Look at mine.')))
  bus.post(send('checker', 'writer', 'Look at mine first.'))
  bus.endTurn('writer')
  assert.equal(bus.isClosed(j2), false)
  bus.endTurn('checker')

  const stopped = store.readMail().filter((m) => m.kind === 'stopped')
  assert.equal(stopped.length, 1)
  assert.equal(stopped[0].job, j2)
  assert.equal(stopped[0].from, 'checker')
  assert.equal(stopped[0].text, 'Stopped. Checker and Writer were each waiting on the other.')
  assert.deepEqual(stopped[0].inputs, [])
  assert.equal(bus.isClosed(j2), true)
  assert.deepEqual(bus.queued('writer'), [])
  assert.equal(last('checker').job, j1)
  assert.deepEqual(last('checker').batch.map((m) => m.id), [toChecker.id])
  assert.equal(bus.isClosed(j1), false)
})

test('an email tile whose visible copy is sent: no still holds its job open after a prose-only turn', () => {
  const { bus, last } = setup()
  const job = msgOf(bus.post(person('drafts', 'Text Brent the numbers.'))).job as string
  const tile = msgOf(bus.post(emailTile('drafts')))
  bus.endTurn('drafts')
  const no = bus.answer(stamp(tile, 'no'))
  assert.equal(no.status, 'queued')
  assert.equal(last('drafts').batch[0].email?.sent, 'no')
  assert.deepEqual(bus.unanswered(job).map((m) => m.id), [msgOf(no).id])
  bus.post(reply('drafts', 'Okay, holding it.'))
  assert.deepEqual(bus.endTurn('drafts'), { job, open: true })
  assert.equal(bus.isClosed(job), false)
  assert.deepEqual(bus.state('drafts'), { state: 'waiting-you' })
})

test('a post after the wake started waits for the next wake; a wake on an empty inbox does not call the turn function', () => {
  const { bus, turns, last } = setup()
  assert.equal(bus.wake('writer'), null)
  assert.equal(turns.length, 0)
  bus.post(person('writer', 'One.'))
  const first = last('writer')
  bus.post(person('writer', 'Two.'))
  assert.equal(turns.length, 1)
  assert.deepEqual(texts(first), ['One.'])
  assert.equal(bus.wake('writer'), null)
  bus.endTurn('writer')
  assert.equal(turns.length, 2)
  assert.deepEqual(texts(last('writer')), ['Two.'])
  assert.equal(last('writer').job, first.job)
  bus.endTurn('writer')
  assert.equal(bus.wake('writer'), null)
  assert.equal(turns.length, 2)
})

test('the 11th send is held; continueJob delivers it as 1 of the next 10; the 21st is held; stopJob drops it and closes the job', () => {
  const { bus, store } = setup()
  const job = msgOf(bus.post(person('researcher', 'Dig in.'))).job as string
  const pairs: [string, string][] = [
    ['researcher', 'writer'],
    ['writer', 'researcher'],
    ['researcher', CONDUCTOR]
  ]
  for (let i = 1; i <= 10; i++) {
    const [from, to] = pairs[(i - 1) % 3]
    assert.equal(bus.post(send(from, to, `send ${i}`, { job })).status, 'queued')
  }
  assert.equal(bus.sends(job), 10)
  const held = bus.post(send('writer', 'researcher', 'send 11', { job }))
  assert.equal(held.status, 'held')
  assert.equal(msgOf(held).system, 'loop')
  assert.equal(msgOf(held).from, 'writer')
  assert.equal(msgOf(held).text, 'Writer and Researcher have passed this back and forth 10 times.')
  assert.equal(store.readMail().some((m) => m.text === 'send 11'), false)
  assert.equal(bus.checkJob(job).open, true)

  const delivered = bus.continueJob(job)
  assert.deepEqual(delivered.map((m) => m.text), ['send 11'])
  assert.equal(bus.sends(job), 11)
  assert.deepEqual(bus.queued('researcher').at(-1)?.text, 'send 11')
  for (let i = 12; i <= 20; i++) assert.equal(bus.post(send('researcher', 'writer', `send ${i}`, { job })).status, 'queued')
  assert.equal(bus.post(send('writer', 'researcher', 'send 21', { job })).status, 'held')

  const { msg, bots } = bus.stopJob(job)
  assert.equal(msg?.kind, 'stopped')
  assert.equal(msg?.text, 'Stopped.')
  assert.deepEqual(msg?.inputs, [])
  assert.deepEqual([...bots].sort(), [CONDUCTOR, 'researcher', 'writer'].sort())
  assert.equal(bus.isClosed(job), true)
  assert.equal(store.readMail().some((m) => m.text === 'send 21'), false)
  assert.deepEqual(bus.queued('researcher'), [])
  assert.deepEqual(bus.continueJob(job), [])
  assert.equal(bus.post(send('writer', 'researcher', 'one more', { job })).status, 'late')
})

test('a report closes the job, waiting-bot does not hold it, a later send is late, and the next send starts a new count', () => {
  const { bus, turns, store } = setup()
  const job = msgOf(bus.post(person('writer', 'Draft it.'))).job as string
  bus.post(send('writer', 'checker', 'Draft attached.'))
  bus.endTurn('writer')
  assert.deepEqual(bus.state('writer'), { state: 'waiting-bot', on: 'checker' })
  assert.equal(msgOf(bus.post(report('checker', 'Ready to send.'))).job, job)
  assert.deepEqual(bus.endTurn('checker'), { job, open: false })
  assert.equal(bus.isClosed(job), true)
  assert.deepEqual(bus.state('writer'), { state: 'idle' })
  assert.equal(bus.openJob('writer'), undefined)

  const count = turns.length
  const late = bus.post(send('writer', 'checker', 'One more thing.', { job }))
  assert.equal(late.status, 'late')
  assert.equal(msgOf(late).system, 'late')
  assert.equal(msgOf(late).from, ME)
  assert.equal(msgOf(late).text, LATE_TEXT)
  assert.equal(turns.length, count)
  assert.equal(store.readMail().some((m) => m.text === 'One more thing.'), false)

  const next = msgOf(bus.post(person('writer', 'New piece.'))).job as string
  assert.notEqual(next, job)
  assert.equal(msgOf(bus.post(send('writer', 'checker', 'New draft.'))).job, next)
  assert.equal(bus.sends(next), 1)
})

test('a person message to a worker with no open job gets a new job id; to the conductor it has none', () => {
  const { bus, store } = setup()
  const toWriter = msgOf(bus.post(person('writer', 'Draft it.')))
  assert.match(toWriter.job || '', /^j_\d+$/)
  const toConductor = msgOf(bus.post(person(CONDUCTOR, 'Where are we?')))
  assert.equal(toConductor.job, undefined)
  assert.equal(store.readMail().find((m) => m.id === toConductor.id)?.job, undefined)
  assert.equal(msgOf(bus.post(person('writer', 'Also this.'))).job, toWriter.job)
})

test('a conductor wake with two person messages and sends from an older and a newer job takes both person messages and the older send', () => {
  const { bus, last } = setup()
  bus.post(person(CONDUCTOR, 'Kick off.'))
  const t0 = last(CONDUCTOR)
  const older = msgOf(bus.post(pack('researcher', 'Find the notes.'))).job as string
  const newer = msgOf(bus.post(pack('writer', 'Draft the update.'))).job as string
  bus.post(person(CONDUCTOR, 'Two.'))
  bus.post(person(CONDUCTOR, 'Three.'))
  // The newer job's send arrives first.
  const fromNewer = msgOf(bus.post(send('writer', CONDUCTOR, 'Question on the update.')))
  assert.equal(msgOf(bus.post(send('researcher', CONDUCTOR, 'Found two notes.'))).job, older)
  assert.equal(fromNewer.job, newer)
  bus.endTurn(CONDUCTOR, t0.id)
  assert.deepEqual(texts(last(CONDUCTOR)), ['Two.', 'Three.', 'Found two notes.'])
  assert.equal(last(CONDUCTOR).job, older)
  assert.deepEqual(bus.queued(CONDUCTOR).map((m) => m.id), [fromNewer.id])
  bus.endTurn(CONDUCTOR)
  assert.deepEqual(texts(last(CONDUCTOR)), ['Question on the update.'])
  assert.equal(last(CONDUCTOR).job, newer)
})

test('a worker send to the conductor and a reply with no send or assign closes the job; the queued assign then starts', () => {
  const { bus, last } = setup()
  bus.post(person(CONDUCTOR, 'Catch me up on Summit.'))
  const j1 = msgOf(bus.post(pack('researcher', 'Find the Summit notes.'))).job as string
  bus.endTurn(CONDUCTOR)
  bus.post(person(CONDUCTOR, 'Also find the September invoice.'))
  const j2 = msgOf(bus.post(pack('researcher', 'Find the September invoice.'))).job as string
  bus.endTurn(CONDUCTOR)
  assert.equal(last('researcher').job, j1)
  assert.deepEqual(bus.queued('researcher').map((m) => m.job), [j2])

  bus.post(send('researcher', CONDUCTOR, 'Which client folder?'))
  bus.endTurn('researcher')
  assert.equal(last(CONDUCTOR).job, j1)
  assert.equal(bus.sends(j1), 1)
  assert.deepEqual(bus.state('researcher'), { state: 'waiting-bot', on: CONDUCTOR })
  assert.equal(msgOf(bus.post(reply(CONDUCTOR, 'clients/summit.'))).job, j1)
  assert.deepEqual(bus.endTurn(CONDUCTOR), { job: j1, open: false })
  assert.equal(bus.isClosed(j1), true)
  assert.equal(last('researcher').job, j2)
  assert.equal(last('researcher').batch[0].kind, 'pack')
})

test('the close rule: a running turn, a queued message, and an unanswered tile or hold keep a job open; nothing else does', () => {
  const live = ['writer', 'drafts']
  const view = (over: Partial<JobView>): JobView => ({ running: [], queued: [], mail: [], live, ...over })
  const tile: DeskMessage = { id: 'm_1', ts: '', from: 'drafts', to: ME, kind: 'email', text: '', job: 'j_1', email: EMAIL }
  const hold: DeskMessage = { id: 'm_2', ts: '', from: 'writer', to: ME, kind: 'hold', text: 'Spend $40?', job: 'j_1', hold: { need: 'spend' } }
  const no: DeskMessage = { ...tile, id: 'm_3', replaces: 'm_1', email: { ...EMAIL, sent: 'no' } }
  const yes: DeskMessage = { ...tile, id: 'm_4', replaces: 'm_3', email: { ...EMAIL, sent: 'yes' }, actedAt: '2026-10-07T09:20:00.000Z' }
  const holdNo: DeskMessage = { ...hold, id: 'm_5', replaces: 'm_2', hold: { need: 'spend', answer: 'no' } }

  assert.equal(jobIsOpen('j_1', view({})), false)
  assert.equal(jobIsOpen('j_1', view({ running: [{ botId: 'writer', job: 'j_1' }] })), true)
  assert.equal(jobIsOpen('j_1', view({ running: [{ botId: 'writer', job: 'j_2' }] })), false)
  assert.equal(jobIsOpen('j_1', view({ queued: [{ job: 'j_1' }] })), true)
  assert.equal(jobIsOpen('j_1', view({ mail: [tile] })), true)
  assert.equal(jobIsOpen('j_1', view({ mail: [tile, no] })), true)
  assert.equal(jobIsOpen('j_1', view({ mail: [tile, no, yes] })), false)
  assert.equal(jobIsOpen('j_1', view({ mail: [hold] })), true)
  assert.equal(jobIsOpen('j_1', view({ mail: [hold, holdNo] })), false)
  assert.equal(jobIsOpen('j_1', view({ mail: [tile], live: ['writer'] })), false)
  assert.equal(jobIsOpen('j_2', view({ mail: [tile, hold], queued: [{ job: 'j_1' }] })), false)

  // Through the bus: waiting-bot does not hold a job open.
  const { bus, last } = setup()
  const job = msgOf(bus.post(person('writer', 'Draft it.'))).job as string
  bus.post(send('writer', 'checker', 'Check my math.'))
  bus.endTurn('writer')
  assert.deepEqual(bus.state('writer'), { state: 'waiting-bot', on: 'checker' })
  bus.post(reply('checker', 'Math is fine.'))
  assert.deepEqual(bus.endTurn('checker'), { job, open: false })
  assert.deepEqual(bus.state('writer'), { state: 'idle' })

  // A hold keeps the job open past the turn; once answered, the job closes when that wake ends.
  const spend = msgOf(bus.post(person('writer', 'Boost the budget.'))).job as string
  const h = msgOf(bus.post({ from: 'writer', to: ME, kind: 'hold', text: 'Spend $40 more this week?', hold: { need: 'spend' } }))
  assert.equal(h.job, spend)
  assert.deepEqual(bus.endTurn('writer'), { job: spend, open: true })
  assert.deepEqual(bus.state('writer'), { state: 'waiting-you' })
  assert.equal(bus.checkJob(spend).open, true)
  const answered = bus.answer({ from: 'writer', to: ME, kind: 'hold', text: h.text, replaces: h.id, hold: { need: 'spend', answer: 'yes' }, actedAt: '2026-10-07T09:30:00.000Z' })
  assert.equal(answered.status, 'queued')
  assert.equal(msgOf(answered).job, spend)
  assert.equal(bus.checkJob(spend).open, true)
  assert.equal(last('writer').batch[0].hold?.answer, 'yes')
  assert.deepEqual(bus.endTurn('writer'), { job: spend, open: false })
  assert.equal(bus.checkJob(spend).open, false)
})

test('conductor job ids: the reply stays on the incoming job and a send joins the receiver’s open job', () => {
  const { bus, last } = setup()
  bus.post(person(CONDUCTOR, 'Start both.'))
  const j1 = msgOf(bus.post(pack('researcher', 'Find the notes.'))).job as string
  const j2 = msgOf(bus.post(pack('writer', 'Draft the update.'))).job as string
  bus.endTurn(CONDUCTOR)

  bus.post(send('researcher', CONDUCTOR, 'Tell Writer the notes are in clients/summit/.'))
  bus.endTurn('researcher')
  assert.equal(last(CONDUCTOR).job, j1)
  const toWriter = msgOf(bus.post(send(CONDUCTOR, 'writer', 'The notes are in clients/summit/.')))
  assert.equal(toWriter.job, j2)
  assert.equal(bus.sends(j2), 1)
  assert.equal(bus.sends(j1), 1)
  assert.equal(msgOf(bus.post(reply(CONDUCTOR, 'Passed it to Writer.'))).job, j1)
  assert.deepEqual(bus.endTurn(CONDUCTOR), { job: j1, open: false })
  assert.equal(bus.isClosed(j1), true)
  assert.equal(bus.isClosed(j2), false)

  // A conductor turn on a job, sending to a worker with no open job, gives the send that job.
  bus.post(send('writer', CONDUCTOR, 'Who should check this?'))
  assert.equal(last(CONDUCTOR).job, j2)
  const toChecker = msgOf(bus.post(send(CONDUCTOR, 'checker', 'Please check Writer’s draft.')))
  assert.equal(toChecker.job, j2)
  assert.equal(last('checker').job, j2)
  bus.endTurn(CONDUCTOR)

  // A conductor turn of only person messages: no job on the reply; a send to a worker with no open job starts one.
  bus.post(person(CONDUCTOR, 'Ask Drafts for a text to Brent.'))
  assert.equal(last(CONDUCTOR).job, undefined)
  assert.equal(msgOf(bus.post(reply(CONDUCTOR, 'Asking Drafts.'))).job, undefined)
  const toDrafts = msgOf(bus.post(send(CONDUCTOR, 'drafts', 'Text Brent that the note is ready.')))
  assert.ok(toDrafts.job && ![j1, j2].includes(toDrafts.job))
  assert.equal(last('drafts').job, toDrafts.job)
})

test('restart: an unanswered email reopens its job with Drafts waiting on you; a stamped one does not', () => {
  const { bus, store, brain } = setup()
  const job = msgOf(bus.post(person('drafts', 'Email Brent.'))).job as string
  const tile = msgOf(bus.post(emailTile('drafts')))
  bus.endTurn('drafts')
  bus.answer(stamp(tile, 'no'))
  bus.endTurn('drafts')
  const done = msgOf(bus.post(person('checker', 'Check the deck.'))).job as string
  bus.post(report('checker', 'Deck is fine.'))
  bus.endTurn('checker')

  const turns: Turn[] = []
  const again = createDeskBus({ store: createDeskStore({ brain, role: 'owner' }), wake: (t) => void turns.push(t) })
  assert.deepEqual(again.state('drafts'), { state: 'waiting-you' })
  assert.equal(again.openJob('drafts'), job)
  assert.equal(again.isClosed(job), false)
  assert.deepEqual(again.queued('drafts'), [])
  assert.deepEqual(again.running(), [])
  assert.equal(again.isClosed(done), true)
  assert.equal(again.post(send('checker', 'writer', 'Late.', { job: done })).status, 'late')

  const visible = again.unanswered(job)[0]
  const r = again.answer(stamp(visible, 'yes'))
  assert.equal(r.status === 'queued' && r.started, true)
  assert.equal(turns[0].botId, 'drafts')
  again.endTurn('drafts')
  assert.equal(again.isClosed(job), true)

  const third = createDeskBus({ store, wake: () => {} })
  assert.equal(third.isClosed(job), true)
  assert.deepEqual(third.state('drafts'), { state: 'idle' })
})

test('endTurn with a stale turn id does nothing', () => {
  const { bus, last } = setup()
  bus.post(person('writer', 'One.'))
  const first = last('writer')
  bus.post(person('writer', 'Two.'))
  bus.endTurn('writer', first.id)
  const second = last('writer')
  assert.notEqual(second.id, first.id)
  assert.deepEqual(bus.endTurn('writer', first.id), { open: false })
  assert.equal(bus.turnOf('writer')?.id, second.id)
})
