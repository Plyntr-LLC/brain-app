import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NO_SEAT_WRITE_REFUSAL, TEAM_WRITE_REFUSAL } from '../write-guard.ts'
import { localDay } from '../../shared/desk.ts'
import type { DeskBot, DeskMessage } from '../../shared/desk.ts'
import { archiveFile, botFile, mailFile, memoryFile, weekFile } from './paths.ts'
import { createDeskStore, foldMessages, groupBrowse, mergeStanding, parseBotFile } from './store.ts'

function tmpBrain(): string {
  const brain = mkdtempSync(join(tmpdir(), 'desk-store-'))
  mkdirSync(join(brain, 'desk', 'memory'), { recursive: true })
  return brain
}

const writer: Omit<DeskBot, 'file'> = {
  id: 'writer',
  name: 'Writer',
  cli: 'claude',
  model: 'claude-opus-5-5',
  effort: 'low',
  description: "I draft emails, reports, and posts. I don't invent facts."
}

const NOW = new Date(2026, 9, 7, 12)
const daysAgo = (n: number) => localDay(new Date(2026, 9, 7 - n, 12))

test('bot file round-trips, including model and effort', () => {
  const brain = tmpBrain()
  const store = createDeskStore({ brain, role: 'owner' })
  assert.equal(store.saveBot(writer), null)
  const file = botFile(brain, 'writer')
  assert.deepEqual(store.readBot('writer'), { ...writer, file })
  assert.deepEqual(parseBotFile(readFileSync(file, 'utf8'), file, 'writer'), { ...writer, file })
  assert.equal(store.saveBot({ ...writer, model: 'default', effort: 'high', cli: 'grok' }), null)
  assert.deepEqual(store.readBot('writer'), { ...writer, model: 'default', effort: 'high', cli: 'grok', file })
  assert.deepEqual(store.readBots().map((b) => b.id), ['writer'])
})

test('a description over 800 characters is refused with the form sentence and nothing is written', () => {
  const brain = tmpBrain()
  const store = createDeskStore({ brain, role: 'owner' })
  assert.equal(store.saveBot({ ...writer, description: 'x'.repeat(912) }), 'Keep it under 800 characters (now 912).')
  assert.equal(existsSync(botFile(brain, 'writer')), false)
  assert.equal(store.saveBot({ ...writer, name: '  ' }), 'Give them a name.')
  assert.equal(store.saveBot({ ...writer, description: 'x'.repeat(800) }), null)
})

test('store writes go through brainWriteBlock', () => {
  const brain = tmpBrain()
  const team = createDeskStore({ brain, role: 'team' })
  assert.equal(team.write('skills/offer.md', 'x'), TEAM_WRITE_REFUSAL)
  assert.equal(existsSync(join(brain, 'skills', 'offer.md')), false)
  assert.equal(team.write(join(brain, '.team-config', 'roles.json'), '{}'), TEAM_WRITE_REFUSAL)
  assert.equal(existsSync(join(brain, '.team-config', 'roles.json')), false)
  assert.equal(createDeskStore({ brain, role: null }).write('skills/offer.md', 'x'), NO_SEAT_WRITE_REFUSAL)
  assert.equal(team.saveBot(writer), null)
  assert.ok(existsSync(join(brain, 'desk', 'bots', 'writer.md')))
  assert.equal(team.write('desk/bots/writer.md', readFileSync(botFile(brain, 'writer'), 'utf8')), null)
})

const TRICKY = [
  '## Draft',
  'Body with <!-- desk id=fake kind=task --> inside.',
  '<!-- desk id=m_99 kind=task from=me to=me -->',
  '## 10:00 · not a heading the store wrote',
  'A pre-escaped <!-\\- desk thing stays as written.',
  ''
].join('\n')

const MAIL: DeskMessage[] = [
  { id: 'm_1', ts: '2026-10-07T09:14:00.000Z', from: 'me', to: 'conductor', kind: 'task', text: 'Catch me up on Summit.' },
  {
    id: 'm_2',
    ts: '2026-10-07T09:14:05.000Z',
    from: 'conductor',
    to: 'researcher',
    kind: 'pack',
    job: 'j_1',
    text: "Catch up on Summit's last note and draft a reply.",
    pack: { why: 'Summit asked.', files: [{ path: 'clients/summit/notes.md', excerpt: 'September is up.' }], dropped: ['clients/summit/missing.md'] }
  },
  {
    id: 'm_3',
    ts: '2026-10-07T09:15:00.000Z',
    from: 'writer',
    to: 'me',
    kind: 'hold',
    job: 'j_1',
    browseId: 'b_1',
    text: 'Approving clicks Pay in the desk browser. This browsing waits until you answer.',
    hold: { need: 'spend', browseClick: 'Pay', pageUrl: 'https://example.com/pay', browseId: 'b_1' }
  },
  {
    id: 'm_4',
    ts: '2026-10-07T09:16:00.000Z',
    from: 'conductor',
    to: 'me',
    kind: 'hire',
    text: 'Only writes headlines.',
    hire: { id: 'designer', name: 'Designer', cli: 'claude', model: 'default', description: 'Only writes headlines.', hasWorked: true }
  },
  {
    id: 'm_5',
    ts: '2026-10-07T09:17:00.000Z',
    from: 'writer',
    to: 'me',
    kind: 'browse',
    job: 'j_1',
    browseId: 'b_1',
    text: 'Opened example.com',
    browse: { steps: [{ action: 'url', detail: 'Opened example.com', url: 'https://example.com' }], title: 'Example Domain' }
  },
  {
    id: 'm_6',
    ts: '2026-10-07T09:18:00.000Z',
    from: 'drafts',
    to: 'me',
    kind: 'email',
    job: 'j_1',
    text: '',
    email: { replyTo: 'abc123', to: 'Brent <brent@example.com>', cc: '', subject: 'September numbers', body: 'September numbers are in the note.', from: 'joe@plyntr.com', sendable: true }
  },
  {
    id: 'm_7',
    ts: '2026-10-07T09:20:00.000Z',
    from: 'drafts',
    to: 'me',
    kind: 'email',
    job: 'j_1',
    replaces: 'm_6',
    actedAt: '2026-10-07T09:20:00.000Z',
    text: '',
    email: { replyTo: 'abc123', to: 'Brent <brent@example.com>', cc: '', subject: 'September numbers', body: 'September numbers are in the note.', from: 'joe@plyntr.com', sent: 'yes', sendable: true, note: 'Dry run. Nothing left this Mac.' }
  },
  {
    id: 'm_8',
    ts: '2026-10-07T09:21:00.000Z',
    from: 'writer',
    to: 'me',
    kind: 'error',
    job: 'j_1',
    text: 'Writer stopped with an error.',
    failure: 'exited',
    detail: 'disk full',
    lastTry: { cli: 'claude', model: 'default' },
    inputs: ['m_1', 'm_2']
  },
  { id: 'm_9', ts: '2026-10-07T09:30:00.000Z', from: 'designer', to: 'me', kind: 'report', text: TRICKY, report: { seconds: 180 } },
  { id: 'm_10', ts: '2026-10-07T09:31:00.000Z', from: 'me', to: 'me', kind: 'system', system: 'removed', name: 'Designer', text: 'Designer was removed.' }
]

test('mail appends, keeps earlier lines, and reads back the same messages', () => {
  const brain = tmpBrain()
  const store = createDeskStore({ brain, role: 'team' })
  store.saveBot(writer)
  assert.equal(existsSync(mailFile(brain)), false)
  assert.equal(store.appendMail(MAIL[0]).error, null)
  assert.ok(existsSync(mailFile(brain)))
  assert.deepEqual(store.readMail(), [MAIL[0]])
  for (const m of MAIL.slice(1)) assert.equal(store.appendMail(m).error, null)
  assert.deepEqual(store.readMail(), MAIL)

  const raw = readFileSync(mailFile(brain), 'utf8')
  assert.equal(raw.split('\n').filter((l) => l.startsWith('<!-- desk ')).length, MAIL.length)
  assert.ok(raw.includes('<!-\\- desk id=m_99'))
  assert.ok(raw.includes('<!-- desk id=m_2 kind=pack from=conductor to=researcher job=j_1 ts=2026-10-07T09:14:05.000Z data='))
  assert.ok(raw.includes(' · Writer · Needs your OK\n'))
  assert.ok(!raw.includes('hasWorked'))
})

test('hasWorked is rebuilt on read; new ids count by number', () => {
  const brain = tmpBrain()
  const store = createDeskStore({ brain, role: 'owner' })
  store.appendMail({ ...MAIL[3], hire: { ...MAIL[3].hire!, hasWorked: true } })
  assert.equal(store.readMail()[0].hire?.hasWorked, false)
  store.appendMail({ from: 'conductor', to: 'designer', kind: 'pack', job: 'j_9', text: 'Headlines.' })
  assert.equal(store.readMail()[0].hire?.hasWorked, true)

  const fresh = createDeskStore({ brain, role: 'owner' })
  for (const m of MAIL) fresh.appendMail(m)
  const again = createDeskStore({ brain, role: 'owner' })
  assert.equal(again.newId('m'), 'm_11')
  assert.equal(again.newId('j'), 'j_10')
  assert.equal(again.newId('b'), 'b_2')
  const added = again.appendMail({ from: 'me', to: 'writer', kind: 'task', text: 'Shorter.' }).msg
  assert.equal(added.id, 'm_12')
  assert.ok(added.ts)
})

const email = (over: Partial<NonNullable<DeskMessage['email']>> = {}) => ({
  replyTo: '',
  to: 'Brent <brent@example.com>',
  cc: '',
  subject: 'September numbers',
  body: 'September numbers are in the note.',
  from: 'joe@plyntr.com',
  sendable: true,
  ...over
})

test('foldMessages hides replaced copies; actedAt wins; a Not now copy can be revised', () => {
  const tile: DeskMessage = { id: 'm_1', ts: 't1', from: 'drafts', to: 'me', kind: 'email', job: 'j_1', text: '', email: email() }
  const sent: DeskMessage = { id: 'm_2', ts: 't2', from: 'x', to: 'y', kind: 'email', replaces: 'm_1', actedAt: '2026-10-07T09:20:00Z', text: '', email: email({ sent: 'yes' }) }
  const folded = foldMessages([tile, sent])
  assert.equal(folded.length, 1)
  assert.equal(folded[0].id, 'm_2')
  assert.equal(folded[0].from, 'drafts')
  assert.equal(folded[0].to, 'me')
  assert.equal(folded[0].job, 'j_1')
  assert.equal(folded[0].email?.to, 'Brent <brent@example.com>')
  assert.equal(folded[0].email?.subject, 'September numbers')
  assert.equal(folded[0].email?.body, 'September numbers are in the note.')
  assert.equal(folded[0].actedAt, '2026-10-07T09:20:00Z')

  const revision: DeskMessage = { id: 'm_3', ts: 't3', from: 'drafts', to: 'me', kind: 'email', replaces: 'm_1', text: '', email: email({ body: 'Shorter.' }) }
  assert.deepEqual(foldMessages([tile, sent, revision]).map((m) => m.id), ['m_2'])
  assert.deepEqual(foldMessages([tile, revision, sent]).map((m) => m.id), ['m_2'])
  const late: DeskMessage = { ...revision, id: 'm_4', email: email({ body: 'Shortest.' }) }
  assert.deepEqual(foldMessages([tile, revision, late]).map((m) => m.id), ['m_4'])

  const notNow: DeskMessage = { id: 'm_5', ts: 't5', from: 'drafts', to: 'me', kind: 'email', replaces: 'm_1', text: '', email: email({ sent: 'no' }) }
  const redo: DeskMessage = { id: 'm_6', ts: 't6', from: 'drafts', to: 'me', kind: 'email', replaces: 'm_5', text: '', email: email({ body: 'Shorter.' }) }
  const chain = foldMessages([tile, notNow, redo])
  assert.deepEqual(chain.map((m) => m.id), ['m_6'])
  assert.equal(chain[0].job, 'j_1')
  assert.equal(chain[0].email?.body, 'Shorter.')
  assert.equal(chain[0].email?.sent, undefined)
})

test('groupBrowse merges steps that share a browseId; the hold stays its own tile', () => {
  const step = (id: string, action: string, detail: string): DeskMessage => ({
    id,
    ts: id,
    from: 'writer',
    to: 'me',
    kind: 'browse',
    browseId: 'b_1',
    text: detail,
    browse: { steps: [{ action, detail, url: 'https://example.com' }], title: detail }
  })
  const hold: DeskMessage = { id: 'h', ts: 'h', from: 'writer', to: 'me', kind: 'hold', browseId: 'b_1', text: 'Pay?', hold: { need: 'spend', browseClick: 'Pay', browseId: 'b_1' } }
  const other: DeskMessage = { ...step('o', 'url', 'Opened other.com'), browseId: 'b_2' }
  const grouped = groupBrowse([step('s1', 'url', 'Opened example.com'), hold, step('s2', 'click', 'Clicked Pricing'), other])
  assert.equal(grouped.length, 3)
  assert.equal(grouped[0].id, 's1')
  assert.deepEqual(grouped[0].browse?.steps.map((s) => s.detail), ['Opened example.com', 'Clicked Pricing'])
  assert.equal(grouped[0].browse?.title, 'Clicked Pricing')
  assert.equal(grouped[1].kind, 'hold')
  assert.equal(grouped[2].browseId, 'b_2')
})

test('messagesFor and view fold before the bot filter', () => {
  const brain = tmpBrain()
  const store = createDeskStore({ brain, role: 'owner' })
  for (const m of MAIL) store.appendMail(m)
  store.appendMail({ id: 'm_11', ts: '2026-10-07T10:00:00.000Z', from: 'researcher', to: 'writer', kind: 'send', job: 'j_1', text: 'Here are the notes.' })
  const forWriter = store.messagesFor('writer')
  assert.ok(forWriter.length > 0)
  assert.ok(forWriter.every((m) => m.from === 'writer' || m.to === 'writer'))
  assert.deepEqual(forWriter.map((m) => m.id), ['m_3', 'm_5', 'm_8', 'm_11'])
  const team = store.view(null)
  assert.ok(!team.some((m) => m.id === 'm_6'))
  assert.ok(team.some((m) => m.id === 'm_7'))
  assert.deepEqual(store.view('drafts').map((m) => m.id), ['m_7'])
  assert.equal(store.view(null, 2).length, 2)
  store.appendMail({ id: 'm_12', ts: '2026-10-07T10:01:00.000Z', from: 'me', to: 'writer', kind: 'task', job: 'j_2', text: 'Only for Writer.' })
  store.appendMail({ id: 'm_13', ts: '2026-10-07T10:02:00.000Z', from: 'writer', to: 'me', kind: 'report', job: 'j_2', text: 'Writer only.', report: { seconds: 4 } })
  store.appendMail({ id: 'm_14', ts: '2026-10-07T10:03:00.000Z', from: 'writer', to: 'conductor', kind: 'send', job: 'j_2', text: 'The part for you.' })
  const teamAfter = store.view(null)
  assert.ok(!teamAfter.some((m) => m.id === 'm_12' || m.id === 'm_13'))
  assert.ok(teamAfter.some((m) => m.id === 'm_14'))
  assert.deepEqual(
    store.view('writer').filter((m) => m.id === 'm_12' || m.id === 'm_13' || m.id === 'm_14').map((m) => m.id),
    ['m_12', 'm_13', 'm_14']
  )
})

test('appendMemory adds a dated line under This week and skips a line already in Standing', () => {
  const brain = tmpBrain()
  const store = createDeskStore({ brain, role: 'team' })
  store.saveBot(writer)
  assert.equal(store.createMemory('writer'), null)
  assert.equal(readFileSync(memoryFile(brain, 'writer'), 'utf8'), '')
  assert.deepEqual(store.appendMemory('writer', ['- Joe wants bullets, not a long email.'], NOW).added, ['Joe wants bullets, not a long email.'])
  assert.equal(
    readFileSync(memoryFile(brain, 'writer'), 'utf8'),
    `# Writer\n\n## Standing\n\n## This week\n### ${localDay(NOW)}\n- Joe wants bullets, not a long email.\n`
  )
  writeFileSync(
    memoryFile(brain, 'writer'),
    `# Writer\n\n## Standing\n- Sign off as Joe.\n\n## This week\n### ${daysAgo(1)}\n- Older note.\n`
  )
  const r = store.appendMemory('writer', ['Sign off as Joe.', 'Summit report is in clients/summit/reports/.'], NOW)
  assert.deepEqual(r.added, ['Summit report is in clients/summit/reports/.'])
  const again = store.appendMemory('writer', ['Second line today.'], NOW)
  assert.deepEqual(again.added, ['Second line today.'])
  assert.equal(
    readFileSync(memoryFile(brain, 'writer'), 'utf8'),
    `# Writer\n\n## Standing\n- Sign off as Joe.\n\n## This week\n### ${daysAgo(1)}\n- Older note.\n### ${localDay(NOW)}\n- Summit report is in clients/summit/reports/.\n- Second line today.\n`
  )
  assert.ok(store.readMemory('writer', NOW).includes(`### ${localDay(NOW)}\n- Summit report is in clients/summit/reports/.`))
})

test('readMemory: Standing cut at 1,200 on a line, newest This-week lines in 800, 2,000 in all, never the archive', () => {
  const brain = tmpBrain()
  const store = createDeskStore({ brain, role: 'owner' })
  const standing: string[] = []
  while (standing.join('\n').length < 2000) standing.push(`- Standing rule ${String(standing.length).padStart(3, '0')} keep it plain and short.`)
  const week: string[] = [`### ${daysAgo(15)}`, '- Fifteen days old note.', `### ${daysAgo(14)}`, '- Fourteen days old note.']
  for (let d = 6; d >= 0; d--) {
    week.push(`### ${daysAgo(d)}`)
    for (let i = 0; i < 6; i++) week.push(`- Day ${d} note ${i} about the Summit September numbers.`)
  }
  const file = `# Writer\n\n## Standing\n${standing.join('\n')}\n\n## This week\n${week.join('\n')}\n`
  writeFileSync(memoryFile(brain, 'writer'), file)
  writeFileSync(archiveFile(brain, 'writer'), '### 2026-01-01\n- ARCHIVED SECRET\n')

  const out = store.readMemory('writer', NOW)
  assert.ok(out.length <= 2000)
  const [st, wk] = out.split('\n\n## This week')
  assert.ok(st.startsWith('## Standing\n- Standing rule 000'))
  assert.ok(st.length <= 1200)
  const fullStanding = `## Standing\n${standing.join('\n')}`
  assert.ok(fullStanding.startsWith(st))
  assert.equal(fullStanding[st.length], '\n')
  const weekText = `## This week${wk}`
  assert.ok(weekText.length <= 800)
  assert.ok(weekText.endsWith('- Day 0 note 5 about the Summit September numbers.'))
  assert.ok(!weekText.includes('Day 6 note 0'))
  assert.ok(!out.includes('ARCHIVED SECRET'))
  assert.ok(!out.includes('Fifteen days old'))

  const after = readFileSync(memoryFile(brain, 'writer'), 'utf8')
  assert.ok(after.includes(standing.join('\n')))
  assert.ok(!after.includes('Fifteen days old'))
  assert.ok(!after.includes(`### ${daysAgo(15)}`))
  assert.ok(after.includes('- Fourteen days old note.'))
  const archive = readFileSync(archiveFile(brain, 'writer'), 'utf8')
  assert.ok(archive.includes(`### ${daysAgo(15)}\n- Fifteen days old note.`))
  assert.ok(archive.includes('ARCHIVED SECRET'))
})

test('a 2,000-character Standing hand edit stays in the file', () => {
  const brain = tmpBrain()
  const store = createDeskStore({ brain, role: 'owner' })
  const long = `- ${'a'.repeat(1998)}`
  const file = `# Writer\n\n## Standing\n- short one\n${long}\n\n## This week\n### ${daysAgo(20)}\n- Old.\n`
  writeFileSync(memoryFile(brain, 'writer'), file)
  const out = store.readMemory('writer', NOW)
  assert.equal(out, '## Standing\n- short one')
  assert.ok(readFileSync(memoryFile(brain, 'writer'), 'utf8').includes(long))
})

test('mergeStanding keeps a bullet list at or under 1,200 and rejects anything else', () => {
  assert.deepEqual(mergeStanding('- Joe wants bullets.\n- Sign off as Joe.\n'), ['- Joe wants bullets.', '- Sign off as Joe.'])
  assert.deepEqual(mergeStanding('## Standing\n- One.'), ['- One.'])
  const edge = `- ${'x'.repeat(1198)}`
  assert.deepEqual(mergeStanding(edge), [edge])
  assert.equal(mergeStanding(`- ${'x'.repeat(1199)}`), null)
  assert.equal(mergeStanding('Joe wants bullets and a sign-off.'), null)
  assert.equal(mergeStanding('- One.\nAnd a paragraph.'), null)
  assert.equal(mergeStanding(''), null)
})

test('foldMemory archives folded lines and replaces Standing only with a list', () => {
  const brain = tmpBrain()
  const store = createDeskStore({ brain, role: 'owner' })
  writeFileSync(
    memoryFile(brain, 'writer'),
    `# Writer\n\n## Standing\n- Old rule.\n\n## This week\n### ${daysAgo(8)}\n- Eight days.\n### ${daysAgo(3)}\n- Three days.\n`
  )
  assert.deepEqual(store.memoryWeek('writer'), [
    { date: daysAgo(8), line: '- Eight days.' },
    { date: daysAgo(3), line: '- Three days.' }
  ])
  assert.equal(store.foldMemory('writer', [{ date: daysAgo(8), line: '- Eight days.' }], null), null)
  assert.equal(
    readFileSync(memoryFile(brain, 'writer'), 'utf8'),
    `# Writer\n\n## Standing\n- Old rule.\n\n## This week\n### ${daysAgo(3)}\n- Three days.\n`
  )
  assert.ok(readFileSync(archiveFile(brain, 'writer'), 'utf8').includes('- Eight days.'))
  assert.equal(store.foldMemory('writer', [{ date: daysAgo(3), line: '- Three days.' }], ['- Old rule.', '- Three days, folded.']), null)
  assert.equal(readFileSync(memoryFile(brain, 'writer'), 'utf8'), `# Writer\n\n## Standing\n- Old rule.\n- Three days, folded.\n\n## This week\n`)

  assert.equal(store.writeWeekMarker('writer', '2026-W41'), null)
  assert.equal(store.readWeekMarker('writer'), '2026-W41')
  assert.equal(store.readWeekMarker('designer'), '')
})

test('removeBotFiles deletes the bot, memory, archive, and week marker', () => {
  const brain = tmpBrain()
  const store = createDeskStore({ brain, role: 'owner' })
  store.saveBot({ ...writer, id: 'designer', name: 'Designer' })
  store.createMemory('designer')
  mkdirSync(join(brain, 'desk', 'memory'), { recursive: true })
  writeFileSync(archiveFile(brain, 'designer'), 'x')
  store.writeWeekMarker('designer', '2026-W41')
  assert.equal(store.removeBotFiles('designer'), null)
  for (const f of [botFile(brain, 'designer'), memoryFile(brain, 'designer'), archiveFile(brain, 'designer'), weekFile(brain, 'designer')]) {
    assert.equal(existsSync(f), false)
  }
})
