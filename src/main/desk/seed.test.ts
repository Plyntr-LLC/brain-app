import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DeskCli } from '../../shared/desk.ts'
import { botFile, memoryFile } from './paths.ts'
import { SEED_TEXT, ignoresDesk, seedDesk } from './seed.ts'
import { createDeskStore } from './store.ts'

const IDS = ['conductor', 'researcher', 'writer', 'checker', 'drafts']

function tmpBrain(git = false): string {
  const brain = mkdtempSync(join(tmpdir(), 'desk-seed-'))
  if (git) mkdirSync(join(brain, '.git', 'info'), { recursive: true })
  return brain
}

function detectOf(...clis: DeskCli[]) {
  let calls = 0
  const fn = () => {
    calls++
    return { grok: clis.includes('grok'), claude: clis.includes('claude'), gpt: clis.includes('gpt'), cursor: clis.includes('cursor') }
  }
  return Object.assign(fn, { calls: () => calls })
}

function roster(brain: string) {
  return Object.fromEntries(createDeskStore({ brain, role: 'owner' }).readBots().map((b) => [b.id, b]))
}

test('seed writes the five bots with the seed text and an empty memory file each', () => {
  const brain = tmpBrain()
  const r = seedDesk({ brain, role: 'team', detect: detectOf('grok') })
  assert.deepEqual(r, { seeded: true, excluded: false, error: null })
  const bots = createDeskStore({ brain, role: 'owner' }).readBots()
  assert.deepEqual(bots.map((b) => b.id), IDS)
  assert.deepEqual(bots.map((b) => b.name), ['Conductor', 'Researcher', 'Writer', 'Checker', 'Drafts'])
  for (const b of bots) {
    assert.equal(b.description, SEED_TEXT[b.id].description)
    assert.ok(b.description.length <= 800)
    assert.equal(readFileSync(memoryFile(brain, b.id), 'utf8'), '')
  }
  assert.ok(bots[0].description.startsWith("I'm the one you talk to."))
  assert.ok(bots[4].description.endsWith("I don't invent facts that aren't in the files I was given."))
})

test('grok only: every bot is on grok with model default', () => {
  const brain = tmpBrain()
  seedDesk({ brain, role: 'owner', detect: detectOf('grok') })
  for (const b of Object.values(roster(brain))) {
    assert.equal(b.cli, 'grok')
    assert.equal(b.model, 'default')
  }
  const r = roster(brain)
  assert.deepEqual([r.conductor.effort, r.researcher.effort, r.writer.effort, r.checker.effort, r.drafts.effort], ['high', 'high', 'low', 'low', 'low'])
})

test('grok and claude: Writer and Drafts on Claude Opus, Checker on Grok default', () => {
  const brain = tmpBrain()
  seedDesk({ brain, role: 'owner', detect: detectOf('grok', 'claude') })
  const r = roster(brain)
  assert.deepEqual([r.writer.cli, r.writer.model], ['claude', 'claude-opus-5-5'])
  assert.deepEqual([r.drafts.cli, r.drafts.model], ['claude', 'claude-opus-5-5'])
  assert.deepEqual([r.checker.cli, r.checker.model], ['grok', 'default'])
  assert.deepEqual([r.conductor.cli, r.conductor.model], ['grok', 'default'])
  assert.deepEqual([r.researcher.cli, r.researcher.model], ['grok', 'default'])
})

test('other installs follow the preference order', () => {
  const claudeOnly = tmpBrain()
  seedDesk({ brain: claudeOnly, role: 'owner', detect: detectOf('claude') })
  const c = roster(claudeOnly)
  for (const id of IDS) assert.deepEqual([c[id].cli, c[id].model], ['claude', 'claude-opus-5-5'])

  const cursorGpt = tmpBrain()
  seedDesk({ brain: cursorGpt, role: 'owner', detect: detectOf('cursor', 'gpt') })
  const g = roster(cursorGpt)
  assert.deepEqual([g.conductor.cli, g.researcher.cli, g.writer.cli, g.drafts.cli, g.checker.cli], ['cursor', 'cursor', 'gpt', 'gpt', 'cursor'])
  assert.ok(Object.values(g).every((b) => b.model === 'default'))
})

test('nothing installed: each bot gets its first preference', () => {
  const brain = tmpBrain()
  assert.equal(seedDesk({ brain, role: 'owner', detect: detectOf() }).seeded, true)
  const r = roster(brain)
  assert.deepEqual(IDS.map((id) => r[id].cli), ['grok', 'grok', 'claude', 'claude', 'claude'])
  assert.deepEqual(IDS.map((id) => r[id].model), ['default', 'default', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('seed runs only when desk/bots/ is missing', () => {
  const brain = tmpBrain()
  seedDesk({ brain, role: 'owner', detect: detectOf('grok') })
  writeFileSync(botFile(brain, 'writer'), readFileSync(botFile(brain, 'writer'), 'utf8').replace('cli: grok', 'cli: gpt'))
  const detect = detectOf('claude')
  assert.equal(seedDesk({ brain, role: 'owner', detect }).seeded, false)
  assert.equal(detect.calls(), 0)
  assert.equal(roster(brain).writer.cli, 'gpt')
  assert.equal(roster(brain).conductor.cli, 'grok')

  const empty = tmpBrain()
  mkdirSync(join(empty, 'desk', 'bots'), { recursive: true })
  assert.equal(seedDesk({ brain: empty, role: 'owner', detect: detectOf('grok') }).seeded, false)
  assert.deepEqual(createDeskStore({ brain: empty, role: 'owner' }).readBots(), [])
})

test('seed adds desk/ to .git/info/exclude once when .gitignore does not cover it', () => {
  const brain = tmpBrain(true)
  writeFileSync(join(brain, '.gitignore'), '# Desk mailbox: local transcript of bots talking. Roster in desk/bots/ still syncs.\ndesk/mail/\n')
  writeFileSync(join(brain, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n.DS_Store')
  assert.equal(seedDesk({ brain, role: 'team', detect: detectOf('grok') }).excluded, true)
  const once = readFileSync(join(brain, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(once, '# git ls-files --others --exclude-from=.git/info/exclude\n.DS_Store\ndesk/\n')
  assert.equal(seedDesk({ brain, role: 'team', detect: detectOf('grok') }).excluded, false)
  assert.equal(readFileSync(join(brain, '.git', 'info', 'exclude'), 'utf8'), once)
  assert.equal(readFileSync(join(brain, '.gitignore'), 'utf8').includes('desk/mail/'), true)

  const noInfo = mkdtempSync(join(tmpdir(), 'desk-seed-'))
  mkdirSync(join(noInfo, '.git'))
  seedDesk({ brain: noInfo, role: 'owner', detect: detectOf('grok') })
  assert.equal(readFileSync(join(noInfo, '.git', 'info', 'exclude'), 'utf8'), 'desk/\n')
})

test('seed leaves exclude alone when .gitignore already ignores desk/, and writes nothing without .git', () => {
  for (const line of ['desk/', '/desk/', 'desk', '/desk/**']) {
    const brain = tmpBrain(true)
    writeFileSync(join(brain, '.gitignore'), `node_modules/\n${line}\n`)
    seedDesk({ brain, role: 'owner', detect: detectOf('grok') })
    assert.equal(existsSync(join(brain, '.git', 'info', 'exclude')), false, line)
  }
  const plain = tmpBrain()
  assert.equal(seedDesk({ brain: plain, role: 'owner', detect: detectOf('grok') }).seeded, true)
  assert.equal(existsSync(join(plain, '.git')), false)
})

test('ignoresDesk counts only lines that cover the whole folder', () => {
  assert.equal(ignoresDesk('desk/mail/\n'), false)
  assert.equal(ignoresDesk('# desk/\n'), false)
  assert.equal(ignoresDesk('!desk/\n'), false)
  assert.equal(ignoresDesk('desk/*\n'), true)
  assert.equal(ignoresDesk('  /desk  \n'), true)
})
