import assert from 'node:assert/strict'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ME, SLOW_TURN_MS } from '../../shared/desk.ts'
import type { BotState, DeskBot, DeskCli, DeskMessage } from '../../shared/desk.ts'
import type { SpawnFn } from '../factory/opus.ts'
import { botFile } from './paths.ts'
import {
  CONDUCTOR_ENDS,
  PAGE_HOW,
  PAGE_SENTENCE,
  WORKER_ENDS,
  argvFor,
  childKey,
  compactPrompt,
  conductorHistory,
  conductorPrompt,
  createDeskRunner,
  workerPrompt
} from './runner.ts'
import type { RunnerDeps } from './runner.ts'
import { SEED_TEXT } from './seed.ts'
import { createDeskStore } from './store.ts'

// ---------- fakes ----------

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kills: (NodeJS.Signals | number | undefined)[] = []
  kill(sig?: NodeJS.Signals | number): boolean {
    this.kills.push(sig)
    setImmediate(() => this.emit('close', null, sig))
    return true
  }
  end(code: number, out = '', err = ''): void {
    if (out) this.stdout.emit('data', Buffer.from(out))
    if (err) this.stderr.emit('data', Buffer.from(err))
    this.emit('close', code, null)
  }
}

type Reply = { code: number; out?: string; err?: string } | 'hang'
type Call = { bin: string; args: string[]; opts: SpawnOptions; child: FakeChild }

/** Records every spawn. Reply n answers spawn n; 'hang' never closes until killed or ended by the test. */
function fakeSpawn(replies: Reply[] = []) {
  const calls: Call[] = []
  const spawn: SpawnFn = (bin, args, opts) => {
    const child = new FakeChild()
    calls.push({ bin, args, opts, child })
    const r = replies[calls.length - 1] ?? { code: 0, out: 'ok' }
    if (r !== 'hang') setImmediate(() => child.end(r.code, r.out, r.err))
    return child as unknown as ChildProcess
  }
  return { spawn, calls }
}

const ALL: DeskCli[] = ['grok', 'claude', 'gpt', 'cursor']

function depsFor(spawn: SpawnFn, installed: DeskCli[] = ALL): RunnerDeps {
  return {
    resolveBin: (cli) => (installed.includes(cli) ? `/fake/bin/${cli}` : null),
    binEnv: () => ({ PATH: '/fake/bin', HOME: '/fake/home', ANTHROPIC_API_KEY: 'k', ANTHROPIC_TRANSLATOR_API_KEY: 't' }),
    detect: () => ({ grok: installed.includes('grok'), claude: installed.includes('claude'), gpt: installed.includes('gpt'), cursor: installed.includes('cursor') }),
    spawn
  }
}

function bot(id: string, cli: DeskCli, model = 'default', effort = 'default'): DeskBot {
  const name = id[0].toUpperCase() + id.slice(1)
  return { id, name, cli, model, effort, description: `I am ${name}.`, file: `/brain/desk/bots/${id}.md` }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((r) => setImmediate(r))
  assert.ok(check(), 'condition never became true')
}

const BRAIN = '/Users/someone/agency-brain'
const PROMPT = 'You are Writer. Draft the Summit reply.'
const NEVER = ['--always-approve', '--bare', '--dangerously-skip-permissions', '--fallback-model', '--tools', '--dangerously-bypass-approvals-and-sandbox', '--force', '--yolo', '--approve-mcps']

// ---------- argv and spawn ----------

test('argvFor matches the table for each CLI, model and effort flags only when not default', () => {
  const grokDeny = ['--deny', 'Bash(*)', '--deny', 'Write(**)', '--deny', 'Edit(**)', '--deny', 'MCPTool(*)', '--deny', 'mcp__*']
  const grokBase = ['-p', PROMPT, '--cwd', BRAIN, '--permission-mode', 'plan', '--no-subagents', '--disable-web-search', '--output-format', 'plain', ...grokDeny]
  assert.deepEqual(argvFor({ cli: 'grok', model: 'default', effort: 'default' }, PROMPT, BRAIN), grokBase)
  assert.deepEqual(argvFor({ cli: 'grok', model: 'grok-4.7', effort: 'high' }, PROMPT, BRAIN), [...grokBase, '--model', 'grok-4.7', '--reasoning-effort', 'high'])

  const claudeBase = ['-p', PROMPT, '--permission-mode', 'plan', '--restricted', '--strict-mcp-config', '--output-format', 'text']
  assert.deepEqual(argvFor({ cli: 'claude', model: 'default', effort: 'default' }, PROMPT, BRAIN), claudeBase)
  assert.deepEqual(argvFor({ cli: 'claude', model: 'claude-opus-5-5', effort: 'low' }, PROMPT, BRAIN), [...claudeBase, '--model', 'claude-opus-5-5', '--effort', 'low'])

  const gptHead = ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-C', BRAIN]
  assert.deepEqual(argvFor({ cli: 'gpt', model: 'default', effort: 'high' }, PROMPT, BRAIN), [...gptHead, PROMPT])
  assert.deepEqual(argvFor({ cli: 'gpt', model: 'gpt-5.5', effort: 'high' }, PROMPT, BRAIN), [...gptHead, '-m', 'gpt-5.5', PROMPT])

  const cursorHead = ['-p', '--mode=ask', '--sandbox', 'enabled', '--trust', '--workspace', BRAIN, '--output-format', 'text']
  assert.deepEqual(argvFor({ cli: 'cursor', model: 'default', effort: 'high' }, PROMPT, BRAIN), [...cursorHead, PROMPT])
  assert.deepEqual(argvFor({ cli: 'cursor', model: 'sonnet-5', effort: 'high' }, PROMPT, BRAIN), [...cursorHead, '--model', 'sonnet-5', PROMPT])

  for (const cli of ALL) {
    const argv = argvFor({ cli, model: 'some-model', effort: 'high' }, PROMPT, BRAIN)
    for (const flag of NEVER) assert.ok(!argv.includes(flag), `${cli} argv has ${flag}`)
    const effortFlags = argv.filter((a) => a === '--effort' || a === '--reasoning-effort')
    assert.equal(effortFlags.length, cli === 'grok' || cli === 'claude' ? 1 : 0, `${cli} effort flag`)
  }
})

test('every spawn: the table argv, cwd the brain, stdin ignore, no shell; claude env drops the Anthropic keys', async () => {
  for (const cli of ALL) {
    const { spawn, calls } = fakeSpawn([{ code: 0, out: 'hi' }])
    const runner = createDeskRunner(depsFor(spawn))
    const b = bot('writer', cli, 'm-1', 'high')
    const r = await runner.run({ bot: b, prompt: PROMPT, brain: BRAIN })
    assert.equal(r.status, 'ok')
    assert.equal(calls.length, 1)
    const c = calls[0]
    assert.equal(c.bin, `/fake/bin/${cli}`)
    assert.deepEqual(c.args, argvFor(b, PROMPT, BRAIN))
    assert.equal(c.opts.cwd, BRAIN, `${cli} cwd`)
    assert.equal(c.opts.shell, false)
    assert.equal((c.opts.stdio as unknown[])[0], 'ignore')
    if (cli === 'claude') {
      assert.equal(c.opts.env?.ANTHROPIC_API_KEY, undefined)
      assert.equal(c.opts.env?.ANTHROPIC_TRANSLATOR_API_KEY, undefined)
      assert.equal(c.opts.env?.PATH, '/fake/bin')
    } else {
      assert.equal(c.opts.env?.ANTHROPIC_API_KEY, 'k')
    }
  }
})

test('grok argv: each deny rule is its own exact item after --deny, no mcp(*), no --always-approve', async () => {
  const { spawn, calls } = fakeSpawn()
  await createDeskRunner(depsFor(spawn)).run({ bot: bot('researcher', 'grok', 'default', 'high'), prompt: PROMPT, brain: BRAIN })
  const argv = calls[0].args
  assert.equal(calls[0].opts.shell, false)
  for (const rule of ['Bash(*)', 'Write(**)', 'Edit(**)', 'MCPTool(*)', 'mcp__*']) {
    const i = argv.findIndex((a) => a === rule)
    assert.ok(i > 0, `missing ${rule}`)
    assert.ok(argv[i - 1] === '--deny', `${rule} is not after --deny`)
  }
  assert.ok(argv.every((a) => !a.includes('"') && !a.includes("'") || a === PROMPT))
  assert.ok(!argv.includes('mcp(*)'))
  assert.ok(!argv.includes('--always-approve'))
})

test('cursor argv ends with the prompt, is in ask mode, and never approves MCPs', async () => {
  const { spawn, calls } = fakeSpawn()
  await createDeskRunner(depsFor(spawn)).run({ bot: bot('checker', 'cursor', 'sonnet-5', 'high'), prompt: PROMPT, brain: BRAIN })
  const argv = calls[0].args
  assert.equal(argv[argv.length - 1], PROMPT)
  assert.ok(argv.includes('--mode=ask'))
  assert.ok(!argv.includes('--approve-mcps'))
})

test("the runner returns the child's text as printed and does not parse fences or import ai-cli.ts", async () => {
  const out = 'Here is the plan.\n\n```send\nto: writer\n\nThe notes are in.\n```\n'
  const { spawn } = fakeSpawn([{ code: 0, out }])
  const r = await createDeskRunner(depsFor(spawn)).run({ bot: bot('researcher', 'grok'), prompt: PROMPT, brain: BRAIN })
  assert.equal(r.status, 'ok')
  assert.equal(r.status === 'ok' && r.text, out.trim())
  const src = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8')
  const imports = src.split('\n').filter((l) => /^import\b/.test(l) || /^\} from /.test(l))
  assert.ok(imports.length > 0)
  assert.ok(imports.every((l) => !l.includes('ai-cli') && !l.includes('fences') && !l.includes('parseGrokLine')))
})

// ---------- child keys, stop, slow ----------

test("children are keyed desk:<botId>; the conductor's turn does not kill Writer's child", async () => {
  const { spawn, calls } = fakeSpawn(['hang', { code: 0, out: 'Writer is on it.' }])
  const runner = createDeskRunner(depsFor(spawn))
  assert.equal(childKey('writer'), 'desk:writer')
  const w = runner.run({ bot: bot('writer', 'claude'), prompt: 'w', brain: BRAIN })
  await until(() => calls.length === 1)
  assert.deepEqual(runner.keys(), ['desk:writer'])
  let during: string[] = []
  const c = await runner.run({ bot: bot('conductor', 'grok'), prompt: 'c', brain: BRAIN, onTry: () => (during = runner.keys()) })
  assert.deepEqual(during, ['desk:writer', 'desk:conductor'])
  assert.equal(c.status === 'ok' && c.text, 'Writer is on it.')
  assert.deepEqual(calls[0].child.kills, [])
  assert.equal(runner.running('writer'), true)
  assert.equal(runner.running('conductor'), false)
  calls[0].child.end(0, 'Draft.')
  assert.equal((await w).status, 'ok')
  assert.deepEqual(runner.keys(), [])
})

test('stop(botId) kills that child only; stopAll kills every recorded child', async () => {
  const { spawn, calls } = fakeSpawn(['hang', 'hang', 'hang'])
  const runner = createDeskRunner(depsFor(spawn))
  const w = runner.run({ bot: bot('writer', 'grok'), prompt: 'w', brain: BRAIN })
  await until(() => calls.length === 1)
  const c = runner.run({ bot: bot('conductor', 'grok'), prompt: 'c', brain: BRAIN })
  await until(() => calls.length === 2)
  const r = runner.run({ bot: bot('researcher', 'grok'), prompt: 'r', brain: BRAIN })
  await until(() => calls.length === 3)
  await assert.rejects(runner.run({ bot: bot('writer', 'grok'), prompt: 'again', brain: BRAIN }))
  assert.equal(calls.length, 3)

  assert.equal(runner.stop('writer'), true)
  assert.equal((await w).status, 'stopped')
  assert.deepEqual(calls[0].child.kills, ['SIGKILL'])
  assert.deepEqual(calls[1].child.kills, [])
  assert.deepEqual(calls[2].child.kills, [])
  assert.equal(runner.stop('writer'), false)

  assert.deepEqual(runner.stopAll().sort(), ['conductor', 'researcher'])
  assert.equal((await c).status, 'stopped')
  assert.equal((await r).status, 'stopped')
  assert.deepEqual(calls[1].child.kills, ['SIGKILL'])
  assert.deepEqual(calls[2].child.kills, ['SIGKILL'])
  assert.deepEqual(runner.keys(), [])
})

test('a slow turn signals every 10 minutes and is never killed; keep waiting resets the clock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { spawn, calls } = fakeSpawn(['hang'])
  const runner = createDeskRunner(depsFor(spawn))
  const slow: number[] = []
  const done = runner.run({ bot: bot('writer', 'grok'), prompt: 'w', brain: BRAIN, onSlow: (m) => slow.push(m) })
  await until(() => calls.length === 1)
  t.mock.timers.tick(SLOW_TURN_MS - 1)
  assert.deepEqual(slow, [])
  t.mock.timers.tick(1)
  assert.deepEqual(slow, [10])
  t.mock.timers.tick(5 * 60_000)
  assert.equal(runner.keepWaiting('writer'), true)
  t.mock.timers.tick(5 * 60_000)
  assert.deepEqual(slow, [10], 'keep waiting at 15 minutes moves the next signal to 25')
  t.mock.timers.tick(5 * 60_000)
  assert.deepEqual(slow, [10, 25])
  t.mock.timers.tick(SLOW_TURN_MS)
  assert.deepEqual(slow, [10, 25, 35], 'an ignored card still gets the next one 10 minutes later')
  assert.deepEqual(calls[0].child.kills, [])
  assert.equal(runner.running('writer'), true)
  calls[0].child.end(0, 'Done at last.')
  assert.equal((await done).status, 'ok')
  t.mock.timers.tick(SLOW_TURN_MS)
  assert.deepEqual(slow, [10, 25, 35])
})

// ---------- failures and fallback ----------

test('failures are typed: not-installed, not-signed-in, exited with the first stderr line, empty', async () => {
  const none = fakeSpawn()
  const a = await createDeskRunner(depsFor(none.spawn, [])).run({ bot: bot('writer', 'claude'), prompt: PROMPT, brain: BRAIN })
  assert.equal(none.calls.length, 0)
  assert.deepEqual(a, { status: 'failed', failure: 'not-installed', lastTry: { cli: 'claude', model: 'default' }, tries: [{ cli: 'claude', model: 'default', failure: 'not-installed' }] })

  for (const err of ['Error: not logged in. Run grok login.\n', 'Please sign in first', 'HTTP 401 Unauthorized', 'auth token expired']) {
    const f = fakeSpawn([{ code: 1, err }])
    const r = await createDeskRunner(depsFor(f.spawn, ['grok'])).run({ bot: bot('writer', 'grok'), prompt: PROMPT, brain: BRAIN })
    assert.equal(r.status === 'failed' && r.failure, 'not-signed-in', err)
    assert.deepEqual(r.lastTry, { cli: 'grok', model: 'default' })
  }

  const ex = fakeSpawn([{ code: 2, out: 'partial', err: '\n  segfault at 0x0\n    at frame 1\n' }])
  const e = await createDeskRunner(depsFor(ex.spawn, ['grok'])).run({ bot: bot('writer', 'grok'), prompt: PROMPT, brain: BRAIN })
  assert.equal(e.status === 'failed' && e.failure, 'exited')
  assert.equal(e.status === 'failed' && e.detail, 'segfault at 0x0')

  const em = fakeSpawn([{ code: 0, out: '  \n\n' }])
  const m = await createDeskRunner(depsFor(em.spawn, ['grok'])).run({ bot: bot('writer', 'grok'), prompt: PROMPT, brain: BRAIN })
  assert.equal(m.status === 'failed' && m.failure, 'empty')
  assert.equal(em.calls.length, 1)
})

test('fallback: "model not found" starts the next pair with the same prompt; used names the winner; the bot file is unchanged', async () => {
  const brain = mkdtempSync(join(tmpdir(), 'desk-runner-'))
  const store = createDeskStore({ brain, role: 'owner' })
  assert.equal(store.saveBot({ id: 'writer', name: 'Writer', cli: 'claude', model: 'claude-opus-5-5', effort: 'low', description: SEED_TEXT.writer.description }), null)
  const before = readFileSync(botFile(brain, 'writer'), 'utf8')
  const writer = store.readBot('writer') as DeskBot
  const copy = { ...writer }

  const { spawn, calls } = fakeSpawn([{ code: 1, err: 'Error: model not found: claude-opus-5-5' }, { code: 0, out: 'Three bullets.' }])
  const tried: [string, number][] = []
  const r = await createDeskRunner(depsFor(spawn)).run({ bot: writer, prompt: PROMPT, brain, onTry: (p, i) => tried.push([`${p.cli}/${p.model}`, i]) })

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args, argvFor({ cli: 'claude', model: 'claude-opus-5-5', effort: 'low' }, PROMPT, brain))
  assert.ok(calls[0].args.includes('--effort'))
  assert.deepEqual(calls[1].args, argvFor({ cli: 'claude', model: 'default', effort: 'default' }, PROMPT, brain))
  assert.equal(calls[1].args[1], PROMPT)
  assert.ok(!calls[1].args.includes('--effort') && !calls[1].args.includes('--model'), 'the second try has no effort flag')
  assert.equal(calls[1].opts.cwd, brain)
  assert.deepEqual(tried, [['claude/claude-opus-5-5', 0], ['claude/default', 1]])
  assert.equal(r.status, 'ok')
  assert.equal(r.status === 'ok' && r.text, 'Three bullets.')
  assert.deepEqual(r.status === 'ok' && r.used, { cli: 'claude', model: 'default' })
  assert.deepEqual(r.lastTry, { cli: 'claude', model: 'default' })
  assert.equal(readFileSync(botFile(brain, 'writer'), 'utf8'), before)
  assert.deepEqual(writer, copy)
})

test('fallback: the first try that returns text has no used; a fifth spawn never happens', async () => {
  const one = fakeSpawn([{ code: 0, out: 'fine' }])
  const ok = await createDeskRunner(depsFor(one.spawn)).run({ bot: bot('writer', 'claude', 'claude-opus-5-5', 'low'), prompt: PROMPT, brain: BRAIN })
  assert.equal(ok.status === 'ok' && ok.used, undefined)

  const broke = Array.from({ length: 6 }, () => ({ code: 1, err: 'Error: rate limit reached, try later' }))
  const { spawn, calls } = fakeSpawn(broke)
  const r = await createDeskRunner(depsFor(spawn)).run({ bot: bot('writer', 'claude', 'claude-opus-5-5', 'low'), prompt: PROMPT, brain: BRAIN })
  assert.equal(calls.length, 4)
  assert.deepEqual(
    calls.map((c) => c.bin),
    ['/fake/bin/claude', '/fake/bin/claude', '/fake/bin/grok', '/fake/bin/cursor']
  )
  for (const c of calls.slice(1)) assert.ok(!c.args.includes('--effort') && !c.args.includes('--reasoning-effort'))
  assert.equal(r.status, 'failed')
  assert.equal(r.status === 'failed' && r.failure, 'exited')
  assert.equal(r.status === 'failed' && r.detail, 'Error: rate limit reached, try later')
  assert.deepEqual(r.lastTry, { cli: 'cursor', model: 'default' })
  assert.equal(r.tries.length, 4)
})

test('fallback: "disk full" is not a broken link, so there is no second try', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 1, err: 'disk full' }])
  const r = await createDeskRunner(depsFor(spawn)).run({ bot: bot('writer', 'claude', 'claude-opus-5-5'), prompt: PROMPT, brain: BRAIN })
  assert.equal(calls.length, 1)
  assert.equal(r.status === 'failed' && r.failure, 'exited')
  assert.equal(r.status === 'failed' && r.detail, 'disk full')
  assert.deepEqual(r.lastTry, { cli: 'claude', model: 'claude-opus-5-5' })
})

test('fallback: stop during try 1 does not start try 2', async () => {
  const { spawn, calls } = fakeSpawn(['hang', { code: 0, out: 'should not run' }])
  const runner = createDeskRunner(depsFor(spawn))
  const done = runner.run({ bot: bot('writer', 'claude', 'claude-opus-5-5'), prompt: PROMPT, brain: BRAIN })
  await until(() => calls.length === 1)
  runner.stop('writer')
  const r = await done
  for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res))
  assert.equal(calls.length, 1)
  assert.equal(r.status, 'stopped')
  assert.deepEqual(r.lastTry, { cli: 'claude', model: 'claude-opus-5-5' })
})

test('fallback: try 1 not installed records not-installed without a spawn, then try 2 spawns another installed CLI', async () => {
  const { spawn, calls } = fakeSpawn([{ code: 0, out: 'Grok answered.' }])
  const r = await createDeskRunner(depsFor(spawn, ['grok'])).run({ bot: bot('writer', 'claude', 'claude-opus-5-5', 'low'), prompt: PROMPT, brain: BRAIN })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bin, '/fake/bin/grok')
  assert.ok(!calls[0].args.includes('--reasoning-effort'))
  assert.equal(calls[0].opts.cwd, BRAIN)
  assert.deepEqual(r.tries[0], { cli: 'claude', model: 'claude-opus-5-5', failure: 'not-installed' })
  assert.equal(r.status === 'ok' && r.text, 'Grok answered.')
  assert.deepEqual(r.status === 'ok' && r.used, { cli: 'grok', model: 'default' })
})

test('fallback: not-signed-in is a broken link, and the error names the CLI of the last try', async () => {
  const { spawn, calls } = fakeSpawn([
    { code: 1, err: 'API Error: model is overloaded' },
    { code: 1, err: 'Invalid API key. Please run /login' },
    { code: 1, err: 'Error: not signed in to Grok' }
  ])
  const r = await createDeskRunner(depsFor(spawn, ['claude', 'grok'])).run({ bot: bot('writer', 'claude', 'claude-opus-5-5'), prompt: PROMPT, brain: BRAIN })
  assert.equal(calls.length, 3)
  assert.equal(r.status === 'failed' && r.failure, 'not-signed-in')
  assert.deepEqual(r.lastTry, { cli: 'grok', model: 'default' })
})

// ---------- prompts ----------

const SEED_IDS = ['conductor', 'researcher', 'writer', 'checker', 'drafts']
const BOTS: DeskBot[] = SEED_IDS.map((id) => ({
  id,
  name: SEED_TEXT[id].name,
  cli: 'grok',
  model: 'default',
  effort: 'default',
  description: SEED_TEXT[id].description,
  file: `/brain/desk/bots/${id}.md`
}))
const [CONDUCTOR_BOT, , WRITER, , DRAFTS] = BOTS

let seq = 0
function msg(m: Partial<DeskMessage> & Pick<DeskMessage, 'kind' | 'from' | 'to'>): DeskMessage {
  seq++
  return { id: `m_${seq}`, ts: `2026-10-07T09:${String(seq % 60).padStart(2, '0')}:00Z`, text: '', ...m }
}

const SPEC = {
  assign: '```assign\nbot: researcher\ntask: <one paragraph>\nwhy: <one sentence>\nfiles:\n- clients/summit/notes.md\n```',
  send: '```send\nto: writer\nfiles:\n- clients/summit/notes.md\n\n<message, short. A blank line before it. A line that starts with "- " after that blank line is the message, not a file.>\n```',
  hold: '```hold\nneed: spend | ads\n\n<one sentence Joe must answer, after a blank line>\n```',
  email: '```email\nreply: <gmail message id, or empty when this is a new email>\nto: Brent <brent@example.com>\ncc:\nsubject: September numbers\n\nSeptember numbers are in the note.\n```',
  sms: '```sms\nto: Brent\nvia: iMessage\n\nThe September note is ready.\n```',
  remember: '```remember\n- <one line the bot should still know tomorrow>\n```',
  hire: '```hire\nname: Designer\ncli: claude\nmodel: default\neffort: low\n\n<description, after a blank line, plain sentences, 800 characters max>\n```',
  browse: ['url: https://example.com', 'click: Pricing', 'click: #3', 'type: Search | summit', 'press: Enter', 'scroll: down'].map((s) => '```browse\n' + s + '\n```')
}

const PAGE = { url: 'https://example.com/pricing', title: 'Pricing', text: 'Plans start at $49 a month.\nCancel any time.', controls: ['link Pricing', 'button Pricing', 'button Pay now'] }

function rosterLine(p: string): string {
  return p.split('\n').find((l) => l.startsWith('Your teammates:')) || ''
}

function ordered(p: string, parts: string[]): void {
  let at = -1
  for (const part of parts) {
    const i = p.indexOf(part, at + 1)
    assert.ok(i > at, `"${part.slice(0, 40)}" is out of order or missing`)
    at = i
  }
}

function conductorFixture() {
  const designer: DeskBot = { id: 'designer', name: 'Designer', cli: 'claude', model: 'default', effort: 'low', description: 'I write headlines only. I never write body copy.', file: '' }
  const bots = [...BOTS, designer]
  const states: BotState[] = [
    { id: 'researcher', state: 'idle' },
    { id: 'writer', state: 'working', since: '2026-10-07T09:00:00Z', task: 'Drafting the Summit reply', model: 'default' },
    { id: 'checker', state: 'waiting-bot', on: 'writer' },
    { id: 'drafts', state: 'waiting-you' },
    { id: 'designer', state: 'idle' }
  ]
  const long = 'Here are the three notes from clients/summit, plus the September numbers and the two open questions Brent asked about last week.'
  const mail = [
    msg({ kind: 'task', from: ME, to: 'conductor', text: 'Where are we on Summit?' }),
    msg({ kind: 'pack', from: 'conductor', to: 'researcher', job: 'j_1', text: 'Find the Summit notes.', pack: { why: 'Joe asked.', files: [{ path: 'clients/summit/notes.md', excerpt: 'SECRET EXCERPT TEXT' }], dropped: [] } }),
    msg({ kind: 'task', from: ME, to: 'writer', job: 'j_1', text: 'Keep it under 100 words.' }),
    msg({ kind: 'send', from: 'researcher', to: 'writer', job: 'j_1', text: long }),
    msg({ kind: 'report', from: 'checker', to: ME, job: 'j_1', text: 'Ready. Dates and numbers match the note.' }),
    msg({ kind: 'error', from: 'writer', to: ME, job: 'j_1', text: 'Writer stopped with an error.' }),
    msg({ kind: 'send', from: 'researcher', to: 'conductor', job: 'j_2', text: 'Need a second file for the Acme note.' })
  ]
  const fresh = msg({ kind: 'task', from: ME, to: 'conductor', text: 'Add a teammate who writes headlines.' })
  mail.push(fresh)
  const hold = msg({ kind: 'hold', from: 'drafts', to: ME, job: 'j_3', text: 'Raise the Summit budget to $60 a day.', hold: { need: 'spend' } })
  const p = conductorPrompt({ bot: CONDUCTOR_BOT, bots, states, memory: '## Standing\n- Joe likes short answers.', mail, batch: [fresh], holds: [hold] })
  return { p, long }
}

test('conductor prompt: memory, then the assign, hire, send, and remember examples exactly, then the ends sentence', () => {
  const { p } = conductorFixture()
  assert.ok(p.includes(SEED_TEXT.conductor.description))
  ordered(p, ['- Joe likes short answers.', SPEC.assign, SPEC.hire, SPEC.send, SPEC.remember, CONDUCTOR_ENDS])
  assert.ok(p.includes('You may end with assign, hire, send, or remember. You may not end with email, sms, hold, or browse.'))
  assert.ok(p.includes('That teammate uses the desk browser. You do not open the page yourself.'))
  for (const tag of ['```email', '```sms', '```hold', '```browse']) assert.ok(!p.includes(tag), `conductor prompt has ${tag}`)
})

test('conductor prompt: roster with first sentences and live states, open holds, and the filtered team history', () => {
  const { p, long } = conductorFixture()
  assert.ok(p.includes('- Designer (id designer): I write headlines only. Idle.'), 'a bot added mid-run is on the roster')
  assert.ok(!p.includes('I never write body copy.'))
  assert.ok(p.includes('Writer (id writer)'))
  assert.ok(p.includes('Working: Drafting the Summit reply'))
  assert.ok(p.includes('Waiting for Writer.'))
  assert.ok(p.includes('Waiting on Joe.'))
  assert.ok(!p.includes(SEED_TEXT.writer.description), 'the roster has first sentences, not whole descriptions')
  assert.ok(p.includes('Raise the Summit budget to $60 a day.'))
  assert.ok(p.includes('Where are we on Summit?'))
  assert.ok(p.includes('Ready. Dates and numbers match the note.'))
  assert.ok(p.includes('Writer stopped with an error.'))
  assert.ok(p.includes('Need a second file for the Acme note.'))
  assert.ok(!p.includes('Keep it under 100 words.'), 'a person message to a worker is left out')
  assert.ok(p.includes(`Researcher → Writer: ${long.slice(0, 80)}…`), 'a worker-to-worker send is the one-line handoff')
  assert.ok(!p.includes(long))
  assert.ok(!p.includes('SECRET EXCERPT TEXT'), 'history shows the briefing, not its excerpts')
  ordered(p, ['New for you:', 'Add a teammate who writes headlines.'])
  assert.equal(p.indexOf('Add a teammate who writes headlines.'), p.lastIndexOf('Add a teammate who writes headlines.'))
})

test('conductor history keeps the last 20 after leaving out person messages to workers', () => {
  const mail = Array.from({ length: 25 }, (_, i) => msg({ kind: 'task', from: ME, to: i % 5 === 0 ? 'writer' : 'conductor', text: `line ${i}` }))
  const h = conductorHistory(mail)
  assert.equal(h.length, 20)
  assert.ok(h.every((m) => m.to === 'conductor'))
  assert.equal(h[h.length - 1].text, 'line 24')
})

test('worker prompt: roster line, then the send, remember, browse, email, sms, and hold examples exactly, then the PAGE and ends lines', () => {
  const p = workerPrompt({ bot: WRITER, bots: BOTS, memory: '- Joe wants bullets.', mail: [], job: 'j_1' })
  const line = rosterLine(p)
  ordered(p, [line, SPEC.send, SPEC.remember, ...SPEC.browse, SPEC.email, SPEC.sms, SPEC.hold, PAGE_HOW, WORKER_ENDS])
  for (const s of ['click: #3', 'type: Search | summit', 'press: Enter', 'scroll: down', 'url: https://example.com', 'click: Pricing']) assert.ok(p.includes(s), s)
  assert.ok(p.includes("The PAGE block lists the page's controls as numbered lines. Click one by its name or by its number, like #3."))
  assert.ok(p.includes('You may end with send, remember, browse, email, sms, or hold. You may not end with assign or hire.'))
  assert.ok(p.includes('subject: September numbers\n\nSeptember numbers are in the note.'), 'a real blank line before the email body')
  assert.ok(p.includes('```email'))
  assert.ok(!p.includes('```assign'))
  assert.ok(!p.includes('```hire'))
  const { p: c } = conductorFixture()
  assert.ok(c.includes('```assign'))
  assert.ok(!c.includes('```email'))
})

test("first-turn worker prompt: description, memory, roster line, pack paths and excerpts, and the task; no other bot's description", () => {
  const team = msg({ kind: 'task', from: ME, to: 'conductor', text: 'Catch me up on Summit.' })
  const pack = msg({
    kind: 'pack',
    from: 'conductor',
    to: 'writer',
    job: 'j_1',
    text: "Draft three bullets from Summit's newest note.",
    pack: { why: 'Joe wants bullets.', files: [{ path: 'clients/summit/notes.md', excerpt: 'September spend was $4,200.\nLeads were up 12%.' }], dropped: ['clients/summit/missing.md'] }
  })
  const p = workerPrompt({ bot: WRITER, bots: BOTS, memory: '## Standing\n- Joe wants bullets, not a long email.', mail: [team, pack], job: 'j_1', batch: [pack] })
  for (const s of [SEED_TEXT.writer.description, '- Joe wants bullets, not a long email.', 'clients/summit/notes.md', 'September spend was $4,200.\nLeads were up 12%.', "Draft three bullets from Summit's newest note.", 'Why: Joe wants bullets.']) {
    assert.ok(p.includes(s), s)
  }
  const line = rosterLine(p)
  for (const b of BOTS.filter((x) => x.id !== 'writer')) assert.ok(line.includes(`${b.name} (id ${b.id})`), b.id)
  assert.ok(!line.includes('(id writer)'))
  for (const b of BOTS.filter((x) => x.id !== 'writer')) assert.ok(!p.includes(b.description), `has ${b.id}'s description`)
  assert.ok(!p.includes('Catch me up on Summit.'), 'the team thread is not in a worker prompt')
})

test("later-turn worker prompt: description, roster line, memory, and only this job's messages to and from the bot", () => {
  const mail = [
    msg({ kind: 'task', from: ME, to: 'conductor', text: 'Team thread sentence.' }),
    msg({ kind: 'pack', from: 'conductor', to: 'writer', job: 'j_1', text: 'Draft the Summit reply.', pack: { why: 'Brent asked.', files: [{ path: 'clients/summit/notes.md', excerpt: 'Spend was $4,200.' }], dropped: [] } }),
    msg({ kind: 'send', from: 'researcher', to: 'writer', job: 'j_1', text: 'Here are the three notes.' }),
    msg({ kind: 'send', from: 'writer', to: 'checker', job: 'j_1', text: 'Draft is ready for a look.' }),
    msg({ kind: 'send', from: 'researcher', to: 'checker', job: 'j_1', text: 'Checker only note.' }),
    msg({ kind: 'send', from: 'researcher', to: 'writer', job: 'j_2', text: 'Unrelated thing for later.' }),
    msg({ kind: 'task', from: ME, to: 'checker', job: 'j_1', text: 'Joe to Checker directly.' })
  ]
  const back = msg({ kind: 'send', from: 'checker', to: 'writer', job: 'j_1', text: 'Fix the date in bullet two.' })
  mail.push(back)
  const p = workerPrompt({ bot: WRITER, bots: BOTS, memory: '- Joe wants bullets.', mail, job: 'j_1', batch: [back] })
  for (const s of [SEED_TEXT.writer.description, '- Joe wants bullets.', 'Draft the Summit reply.', 'Spend was $4,200.', 'Here are the three notes.', 'Draft is ready for a look.']) {
    assert.ok(p.includes(s), s)
  }
  assert.ok(rosterLine(p).includes('Checker (id checker)'))
  for (const s of ['Team thread sentence.', 'Checker only note.', 'Unrelated thing for later.', 'Joe to Checker directly.']) assert.ok(!p.includes(s), s)
  ordered(p, ['This job so far:', 'Here are the three notes.', 'New for you:', 'Fix the date in bullet two.'])
})

test("revision prompt includes the unsent tile's subject and body and the person's change", () => {
  const tile = msg({
    kind: 'email',
    from: 'drafts',
    to: ME,
    job: 'j_3',
    email: { replyTo: '18c2', to: 'Brent <brent@example.com>', cc: '', subject: 'September numbers', body: 'Hi Brent,\nSeptember spend was $4,200 and leads were up.', from: 'joe@plyntr.com', sent: 'no', sendable: true }
  })
  const shorter = msg({ kind: 'task', from: ME, to: 'drafts', job: 'j_3', text: 'shorter' })
  const p = workerPrompt({ bot: DRAFTS, bots: BOTS, memory: '', mail: [tile, shorter], job: 'j_3', batch: [shorter], tile })
  assert.ok(p.includes('Subject: September numbers'))
  assert.ok(p.includes('Hi Brent,\nSeptember spend was $4,200 and leads were up.'))
  assert.ok(p.includes('replaces the unsent one'))
  ordered(p, ['New for you:', 'shorter'])
})

test('browse follow-up: the PAGE sentence, the latest page text, and the numbered controls, from the argument', () => {
  const p = workerPrompt({ bot: WRITER, bots: BOTS, memory: '', mail: [], job: 'j_4', page: PAGE, steps: 2 })
  ordered(p, [PAGE_SENTENCE, 'PAGE', '1. link Pricing', '2. button Pricing', '3. button Pay now', 'Plans start at $49 a month.\nCancel any time.', 'END PAGE'])
  assert.ok(p.includes('Browser steps used: 2 of 8.'))
  assert.ok(!p.includes("Couldn't find"))

  const missing = workerPrompt({ bot: WRITER, bots: BOTS, memory: '', mail: [], job: 'j_4', page: PAGE, refusal: { refused: 'missing', name: 'Pricing' } })
  for (const s of ["Couldn't find Pricing.", PAGE_SENTENCE, 'Plans start at $49 a month.', '1. link Pricing']) assert.ok(missing.includes(s), s)

  const twice = workerPrompt({ bot: WRITER, bots: BOTS, memory: '', mail: [], job: 'j_4', page: PAGE, refusal: { refused: 'ambiguous', name: 'Pricing' } })
  for (const s of ['Pricing matched 2 things.', PAGE_SENTENCE, 'Plans start at $49 a month.', '3. button Pay now']) assert.ok(twice.includes(s), s)

  const last = workerPrompt({ bot: WRITER, bots: BOTS, memory: '', mail: [], job: 'j_4', page: PAGE, steps: 8 })
  assert.ok(last.includes('Do not add a browse block.'))
  assert.ok(last.includes('Plans start at $49 a month.'))
})

test('sign-in and Not now wakes are their exact sentences with no PAGE block', () => {
  const signIn = workerPrompt({ bot: WRITER, bots: BOTS, memory: '', mail: [], job: 'j_4', page: PAGE, wake: 'sign-in' })
  assert.ok(signIn.split('\n').includes('Writer needs you to sign in, in the desk browser.'))
  const no = workerPrompt({ bot: WRITER, bots: BOTS, memory: '', mail: [], job: 'j_4', page: PAGE, wake: 'no' })
  assert.ok(no.split('\n').includes('Joe said no.'))
  for (const p of [signIn, no]) {
    assert.ok(!p.includes(PAGE_SENTENCE))
    assert.ok(!p.includes('END PAGE'))
    assert.ok(!p.includes('Plans start at $49 a month.'))
  }
})

test('compactPrompt contains the standing bullet and the folded line', () => {
  const p = compactPrompt(['- Joe wants bullets, not a long email.'], [{ date: '2026-09-29', line: "- Summit's September note is in clients/summit/reports/." }])
  assert.ok(p.includes('Joe wants bullets, not a long email.'))
  assert.ok(p.includes("Summit's September note is in clients/summit/reports/."))
  assert.ok(p.includes('1,200 characters'))
  const fromText = compactPrompt('## Standing\n- Joe wants bullets, not a long email.\n', [{ date: '2026-09-29', line: '- Old line.' }])
  assert.ok(fromText.includes('- Joe wants bullets, not a long email.'))
  assert.ok(!fromText.includes('## Standing'))
})

test('no prompt the runner builds contains "<blank line>"', () => {
  const tile = msg({ kind: 'email', from: 'drafts', to: ME, job: 'j_3', email: { replyTo: '', to: 'Brent', cc: '', subject: 'S', body: 'B', from: '', sendable: true } })
  const prompts = [
    conductorFixture().p,
    workerPrompt({ bot: WRITER, bots: BOTS, memory: '', mail: [], job: 'j_1' }),
    workerPrompt({ bot: DRAFTS, bots: BOTS, memory: '', mail: [tile], job: 'j_3', tile }),
    workerPrompt({ bot: WRITER, bots: BOTS, memory: '', mail: [], job: 'j_4', page: PAGE, refusal: { refused: 'missing', name: 'Pricing' } }),
    compactPrompt(['- a'], [{ date: '2026-09-29', line: '- b' }])
  ]
  for (const p of prompts) assert.ok(!p.includes('<blank line>'))
})
