import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DeskBot, DeskCli, DeskWelcome } from '../../shared/desk.ts'
import { botFile } from './paths.ts'
import { seedBots } from './seed.ts'
import { buildWelcome, deskGreeting, latestClient, readinessButton, starters } from './welcome.ts'

const TEAM_LINE =
  "I'm Conductor. You talk to me, and I hand the work to Researcher, Writer, Checker, and Drafts. They work in the background, so you can keep talking to me while they do. An email or a text shows up as the message itself, and you send it from there. Try one of these:"
const EVERYONE_GROK = 'Everyone is on Grok for now. You can give anyone a different model on the right.'
const GENERIC = ["What's in this brain?", 'Draft a short update for the team', 'What can the team do?']

function tmpBrain(): string {
  return mkdtempSync(join(tmpdir(), 'desk-welcome-'))
}

function clientDir(brain: string, name: string, at: number): void {
  const dir = join(brain, 'clients', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'notes.md'), 'notes\n')
  utimesSync(dir, at, at)
}

function detectOf(...clis: DeskCli[]) {
  let calls = 0
  const fn = () => {
    calls++
    return { grok: clis.includes('grok'), claude: clis.includes('claude'), gpt: clis.includes('gpt'), cursor: clis.includes('cursor') }
  }
  return Object.assign(fn, { calls: () => calls })
}

function team(brain: string, installed: DeskCli[], edit: Partial<Record<string, Partial<DeskBot>>> = {}): DeskBot[] {
  return seedBots(installed).map((b) => ({ ...b, file: botFile(brain, b.id), ...(edit[b.id] || {}) }))
}

const labels = (w: DeskWelcome) => w.starters.map((s) => s.label)

test('deskGreeting: Plyntr owner name only when the app email matches, first word only', () => {
  const plyntr = { email: 'joe@plyntr.com', name: 'Joe Wine' }
  assert.equal(deskGreeting({ email: 'joe@plyntr.com', appEmail: 'joe@plyntr.com' }, plyntr), 'Joe')
  assert.equal(deskGreeting({ appEmail: 'JOE@plyntr.com ' }, plyntr), 'Joe')
  assert.equal(deskGreeting({ email: 'jeen@example.com' }, null), null)
  assert.equal(deskGreeting({ appEmail: 'jeen@example.com' }, null), null)
  assert.equal(deskGreeting({ email: 'jeen@example.com', appEmail: 'jeen@example.com', appName: '' }, plyntr), null)
  assert.equal(deskGreeting(null, plyntr), null)
  assert.equal(deskGreeting(undefined, null), null)
})

test('deskGreeting: appName, else the account name when its email is the app email', () => {
  assert.equal(deskGreeting({ appEmail: 'jeen@example.com', appName: 'Jeen Park' }, { email: 'joe@plyntr.com', name: 'Joe Wine' }), 'Jeen')
  assert.equal(deskGreeting({ email: 'jeen@example.com', name: 'Jeen Park' }, null), 'Jeen')
  assert.equal(deskGreeting({ email: 'jeen@example.com', appEmail: 'jeen@example.com', name: 'Jeen Park' }, null), 'Jeen')
  assert.equal(deskGreeting({ email: 'other@example.com', appEmail: 'jeen@example.com', name: 'Jeen Park' }, null), null)
  assert.equal(deskGreeting({ email: 'joe@plyntr.com', appEmail: 'joe@plyntr.com', appName: 'Joseph W' }, { email: 'joe@plyntr.com', name: '' }), 'Joseph')
})

test('seed team on a grok-only Mac: full payload, everyone line, no readiness', () => {
  const brain = tmpBrain()
  clientDir(brain, 'mypuppies', 1_700_000_000)
  clientDir(brain, 'summit', 1_800_000_000)
  const detect = detectOf('grok')
  const w = buildWelcome({ brain, bots: team(brain, ['grok']), detect, greetingName: deskGreeting({ appEmail: 'joe@plyntr.com' }, { email: 'joe@plyntr.com', name: 'Joe Wine' }) })
  assert.deepEqual(w, {
    greetingName: 'Joe',
    greeting: `Hi Joe. ${TEAM_LINE}`,
    starters: [
      { label: 'Catch me up on Summit', fill: 'Catch me up on Summit' },
      { label: "Draft a reply to Summit's last note", fill: "Draft a reply to Summit's last note" },
      { label: 'What can the team do?', fill: 'What can the team do?' }
    ],
    readiness: [],
    composerDisabled: false,
    composerPlaceholder: 'Message Conductor',
    everyoneLine: EVERYONE_GROK
  })
  for (const k of ['greetingName', 'greeting', 'starters', 'readiness', 'composerDisabled', 'composerPlaceholder', 'everyoneLine'] as const) {
    assert.ok(k in w, k)
  }
  assert.equal(detect.calls(), 1)
})

test('no greeting name is "Hi."', () => {
  const brain = tmpBrain()
  const w = buildWelcome({ brain, bots: team(brain, ['grok']), detect: detectOf('grok'), greetingName: null })
  assert.equal(w.greetingName, null)
  assert.equal(w.greeting, `Hi. ${TEAM_LINE}`)
})

test('Writer on claude with grok-only detect: one readiness line, Use Grok for Writer, no everyone line', () => {
  const brain = tmpBrain()
  const bots = team(brain, ['grok'], { writer: { cli: 'claude', model: 'claude-opus-5-5' } })
  const w = buildWelcome({ brain, bots, detect: detectOf('grok'), greetingName: 'Joe' })
  assert.deepEqual(w.readiness, [{ botId: 'writer', text: "Writer uses Claude, which isn't on this Mac yet.", cli: 'grok', model: 'default' }])
  assert.equal(readinessButton(w.readiness[0].cli, 'Writer'), 'Use Grok for Writer')
  assert.equal(w.everyoneLine, null)
  assert.equal(w.composerDisabled, false)
})

test('claude and cursor installed, Writer on gpt: Use Claude for Writer', () => {
  const brain = tmpBrain()
  const bots = team(brain, ['claude', 'cursor'], { writer: { cli: 'gpt', model: 'default' } })
  const w = buildWelcome({ brain, bots, detect: detectOf('claude', 'cursor'), greetingName: null })
  assert.deepEqual(w.readiness, [{ botId: 'writer', text: "Writer uses ChatGPT, which isn't on this Mac yet.", cli: 'claude', model: 'default' }])
  assert.equal(readinessButton(w.readiness[0].cli, 'Writer'), 'Use Claude for Writer')
  assert.equal(w.everyoneLine, null)
})

test('with grok installed the button is Grok, the first other CLI in FALLBACK_ORDER', () => {
  const brain = tmpBrain()
  const bots = team(brain, ['grok', 'claude', 'cursor'], { writer: { cli: 'gpt', model: 'default' } })
  const w = buildWelcome({ brain, bots, detect: detectOf('cursor', 'claude', 'grok'), greetingName: null })
  assert.deepEqual(w.readiness, [{ botId: 'writer', text: "Writer uses ChatGPT, which isn't on this Mac yet.", cli: 'grok', model: 'default' }])
  assert.equal(readinessButton(w.readiness[0].cli, 'Writer'), 'Use Grok for Writer')
})

test('one readiness line per missing bot, in roster order, by screen name', () => {
  const brain = tmpBrain()
  const bots = team(brain, [], { checker: { name: 'Proofer' } })
  const w = buildWelcome({ brain, bots, detect: detectOf('cursor'), greetingName: null })
  assert.deepEqual(
    w.readiness.map((r) => [r.botId, r.text, r.cli, r.model]),
    [
      ['conductor', "Conductor uses Grok, which isn't on this Mac yet.", 'cursor', 'default'],
      ['researcher', "Researcher uses Grok, which isn't on this Mac yet.", 'cursor', 'default'],
      ['writer', "Writer uses Claude, which isn't on this Mac yet.", 'cursor', 'default'],
      ['checker', "Proofer uses Claude, which isn't on this Mac yet.", 'cursor', 'default'],
      ['drafts', "Drafts uses Claude, which isn't on this Mac yet.", 'cursor', 'default']
    ]
  )
  assert.equal(w.composerDisabled, false)
  assert.equal(w.composerPlaceholder, 'Message Conductor')
  assert.equal(w.everyoneLine, null)
})

test('no CLI installed: composer disabled with the exact placeholder, no readiness, no everyone line', () => {
  const brain = tmpBrain()
  const bots = team(brain, [], { writer: { description: 'I draft emails, reports, and posts in the house voice. Leave the rest out.' } })
  const w = buildWelcome({ brain, bots, detect: detectOf(), greetingName: 'Joe', thread: 'writer' })
  assert.equal(w.composerDisabled, true)
  assert.equal(w.composerPlaceholder, 'No model app is installed on this Mac.')
  assert.deepEqual(w.readiness, [])
  assert.equal(w.everyoneLine, null)
  assert.equal(w.greeting, "Hi Joe. I'm Writer. I draft emails, reports, and posts in the house voice.")
  assert.deepEqual(w.starters, [])
})

test('a bot thread greets as that bot, and the team thread still greets as Conductor', () => {
  const brain = tmpBrain()
  const bots = team(brain, ['grok'], { writer: { description: 'I draft emails, reports, and posts in the house voice. Leave the rest out.' } })
  const writer = buildWelcome({ brain, bots, detect: detectOf('grok'), greetingName: 'Joe', thread: 'writer' })
  assert.equal(writer.greeting, "Hi Joe. I'm Writer. I draft emails, reports, and posts in the house voice.")
  assert.equal(writer.greeting.includes("I'm Conductor"), false)
  assert.equal(writer.greeting.includes('hand the work'), false)
  assert.deepEqual(writer.starters, [])
  const teamThread = buildWelcome({ brain, bots, detect: detectOf('grok'), greetingName: 'Joe' })
  assert.equal(teamThread.greeting, `Hi Joe. ${TEAM_LINE}`)
  assert.equal(teamThread.starters.length, 3)
})

test('placeholder names the open thread: team is Conductor, a bot thread is that bot', () => {
  const brain = tmpBrain()
  const bots = team(brain, ['grok'])
  const at = (thread?: string | null) => buildWelcome({ brain, bots, detect: detectOf('grok'), greetingName: null, thread }).composerPlaceholder
  assert.equal(at(), 'Message Conductor')
  assert.equal(at(null), 'Message Conductor')
  assert.equal(at('conductor'), 'Message Conductor')
  assert.equal(at('writer'), 'Message Writer')
})

test('everyone line needs one shared CLI that is the only installed one', () => {
  const brain = tmpBrain()
  const allGrok = team(brain, ['grok'])
  assert.equal(buildWelcome({ brain, bots: allGrok, detect: detectOf('grok', 'claude'), greetingName: null }).everyoneLine, null)
  const allClaude = allGrok.map((b) => ({ ...b, cli: 'claude' as DeskCli }))
  const w = buildWelcome({ brain, bots: allClaude, detect: detectOf('claude'), greetingName: null })
  assert.equal(w.everyoneLine, 'Everyone is on Claude for now. You can give anyone a different model on the right.')
  assert.deepEqual(w.readiness, [])
  const allGpt = allGrok.map((b) => ({ ...b, cli: 'gpt' as DeskCli }))
  assert.equal(buildWelcome({ brain, bots: allGpt, detect: detectOf('gpt'), greetingName: null }).everyoneLine, 'Everyone is on ChatGPT for now. You can give anyone a different model on the right.')
})

test('starters: no clients folder, or no client folders in it, gives the generic three', () => {
  const brain = tmpBrain()
  assert.equal(latestClient(brain), null)
  assert.deepEqual(starters(brain).map((s) => s.label), GENERIC)
  mkdirSync(join(brain, 'clients', '_mcc'), { recursive: true })
  mkdirSync(join(brain, 'clients', '.archive'), { recursive: true })
  writeFileSync(join(brain, 'clients', 'schedule.md'), 'x\n')
  assert.equal(latestClient(brain), null)
  const w = buildWelcome({ brain, bots: team(brain, ['grok']), detect: detectOf('grok'), greetingName: null })
  assert.deepEqual(labels(w), GENERIC)
  assert.deepEqual(w.starters.map((s) => s.fill), GENERIC)
})

test('starters: the most recently changed client folder, in title case', () => {
  const brain = tmpBrain()
  clientDir(brain, 'martins-garage', 1_900_000_000)
  clientDir(brain, 'summit', 1_800_000_000)
  clientDir(brain, 'gutter_iq', 1_700_000_000)
  utimesSync(join(brain, 'clients'), 1_600_000_000, 1_600_000_000)
  assert.equal(latestClient(brain), 'martins-garage')
  assert.deepEqual(labels(buildWelcome({ brain, bots: [], detect: detectOf('grok'), greetingName: null })), [
    'Catch me up on Martins Garage',
    "Draft a reply to Martins Garage's last note",
    'What can the team do?'
  ])
  utimesSync(join(brain, 'clients', 'gutter_iq'), 2_000_000_000, 2_000_000_000)
  assert.deepEqual(starters(brain).map((s) => s.fill), ['Catch me up on Gutter Iq', "Draft a reply to Gutter Iq's last note", 'What can the team do?'])
})
