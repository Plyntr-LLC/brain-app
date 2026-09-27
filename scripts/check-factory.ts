import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Factory Slice 1 gate. Drives the real main-process modules (acp-session handleReq, factory
// lane boot against a fake grok binary, controller, run store) with electron stubbed, HOME and
// userData in tmp folders. No live Grok, no tunnel. Prints FACTORY_PASS only if every check passes.

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const esbuild = createRequire(join(rootRepo, 'package.json'))('esbuild') as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code: string }
}

const temp = mkdtempSync(join(tmpdir(), 'brain-factory-'))
const userData = join(temp, 'userData')
const home = join(temp, 'home')
mkdirSync(userData, { recursive: true })
mkdirSync(home, { recursive: true })
;(globalThis as { __userData?: string }).__userData = userData

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !/\.(ts|js|mjs|cjs|json)$/.test(spec)) {
      const base = resolvePath(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === 'stub:electron') {
      const source = `export const app = { getVersion: () => '0.0.0', getPath: () => globalThis.__userData, isPackaged: false }
export const BrowserWindow = { getAllWindows: () => globalThis.__brainWindows || [], fromWebContents: () => null }
export const clipboard = {}, dialog = {}, ipcMain = { handle() {}, on() {} }, Menu = {}, nativeImage = {}, shell = {}, Tray = class {}
export default { app, BrowserWindow }`
      return { format: 'module', shortCircuit: true, source }
    }
    if (url.startsWith('file:') && url.endsWith('.ts') && url.includes('/src/')) {
      const code = esbuild.transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' }).code
      return { format: 'module', shortCircuit: true, source: code }
    }
    return next(url, ctx)
  }
})

process.env.HOME = home
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.ANTHROPIC_API_KEY = 'fixture-not-a-real-key'
delete process.env.BRAIN_APP_DRY_RUN
const winSent: Record<string, unknown>[] = []
;(globalThis as { __brainWindows?: unknown }).__brainWindows = [
  { isDestroyed: () => false, webContents: { send: (_ch: string, p: Record<string, unknown>) => winSent.push(p) } }
]

function git(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Factory Check', '-c', 'user.email=factory@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function repo(name: string, files: Record<string, string>): string {
  const dir = join(temp, name)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 'Factory Check'])
  git(dir, ['config', 'user.email', 'factory@example.com'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

const brainA = repo('brain-a', { 'AGENTS.md': '# Brain A rules\n', 'skills/offer/SKILL.md': '# Offer\n' })
const brainB = repo('brain-b', { 'AGENTS.md': '# Brain B rules\n', 'skills/keep.md': 'keep\n' })
const pkg = JSON.stringify({ name: 'work', private: true, scripts: { typecheck: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } })
const work = repo('work', { 'package.json': pkg, 'src/footer.ts': 'export const footer = "Copyrigth 2026"\n' })
writeFileSync(join(userData, 'brains.json'), JSON.stringify({ active: brainA, rows: [{ path: brainA, name: 'A', slug: 'a' }, { path: brainB, name: 'B', slug: 'b' }] }))

const src = (p: string) => pathToFileURL(join(rootRepo, 'src', 'main', p)).href
const acp = (await import(src('acp-session.ts'))) as typeof import('../src/main/acp-session.ts')
const gargs = (await import(src('grok-args.ts'))) as typeof import('../src/main/grok-args.ts')
const store = (await import(src('factory/run-store.ts'))) as typeof import('../src/main/factory/run-store.ts')
const ctl = (await import(src('factory/controller.ts'))) as typeof import('../src/main/factory/controller.ts')
const gates = (await import(src('factory/gates.ts'))) as typeof import('../src/main/factory/gates.ts')
const { BRIEF_MAX } = (await import(src('factory/brief.ts'))) as typeof import('../src/main/factory/brief.ts')
const files = (await import(src('files.ts'))) as typeof import('../src/main/files.ts')
const persist = (await import(src('persist.ts'))) as typeof import('../src/main/persist.ts')
const phoneLib = (await import(src('phone-lib.ts'))) as typeof import('../src/main/phone-lib.ts')
const { realish, underPath } = (await import(src('factory/paths.ts'))) as typeof import('../src/main/factory/paths.ts')
store.setUserDataDir(() => userData)

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })

type Sent = { id: number | string; result?: unknown; error?: { code: number; message: string } }
type Ev = { kind: string; title?: string; path?: string; data?: string; options?: { id: string; label: string }[] }
function fakePool(lane: 'chat' | 'factory', cwd: string, factory?: { brainPath: string; workRepo: string }) {
  const sent: Sent[] = []
  const events: Ev[] = []
  const tab = {
    tabId: `tab-${lane}`,
    sessionId: `sess-${lane}`,
    promptId: null,
    appTools: [],
    text: '',
    alwaysApprove: lane === 'chat',
    factory,
    onEvent: (ev: Ev) => events.push(ev)
  }
  const pool = {
    kind: 'grok' as const,
    lane,
    cwd,
    boot: Promise.resolve(),
    tabs: new Map([[tab.tabId, tab]]),
    bySid: new Map([[tab.sessionId, tab.tabId]]),
    rpc: {
      reply: (id: number | string, result: unknown) => sent.push({ id, result }),
      error: (id: number | string, code: number, message: string) => sent.push({ id, error: { code, message } })
    }
  }
  return { pool, tab, sent, events }
}
const req = (id: number, method: string, params: Record<string, unknown>) => ({ jsonrpc: '2.0' as const, id, method, params })
const permOpts = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
]
const outcome = (s: Sent | undefined) => (s?.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome

// 2. Deny push: a factory-pool permission ask with git push gets reject_once.
{
  const f = fakePool('factory', brainA, { brainPath: brainA, workRepo: work })
  acp.handleReq(f.pool as never, req(1, 'session/request_permission', { sessionId: 'sess-factory', toolCall: { title: 'Run git push origin main', kind: 'execute', rawInput: { command: 'git push origin main' } }, options: permOpts }))
  check('2 factory git push ask is replied reject_once', outcome(f.sent[0])?.optionId === 'reject_once', JSON.stringify(f.sent))
  for (const cmd of ['gh pr create', 'npx wrangler deploy', 'npm publish', 'vercel --prod', 'fly deploy']) {
    const g = fakePool('factory', brainA, { brainPath: brainA, workRepo: work })
    acp.handleReq(g.pool as never, req(2, 'session/request_permission', { sessionId: 'sess-factory', toolCall: { title: 'Run command', kind: 'execute', rawInput: { command: cmd } }, options: permOpts }))
    check(`2 factory "${cmd}" ask is rejected`, outcome(g.sent[0])?.optionId === 'reject_once')
  }
}

// 3. Factory write to the work repo by absolute path, while cwd is the brain.
{
  const f = fakePool('factory', brainA, { brainPath: brainA, workRepo: work })
  const target = join(work, 'src', 'a.ts')
  acp.handleReq(f.pool as never, req(3, 'fs/write_text_file', { sessionId: 'sess-factory', path: target, content: 'export const a = 1\n' }))
  check('3 factory fs/write_text_file to the work repo replies {}', JSON.stringify(f.sent[0]?.result) === '{}', JSON.stringify(f.sent))
  check('3 the work repo file exists', existsSync(target) && readFileSync(target, 'utf8') === 'export const a = 1\n')
  const args = gargs.grokFactoryAcpArgs(brainA, true)
  check('3 grokFactoryAcpArgs has --cwd <brain>', args[0] === '--cwd' && args[1] === brainA)
  execFileSync('/bin/rm', ['-f', target])
}

// 4. Factory write to <brain>/AGENTS.md is refused and the file is unchanged.
{
  const f = fakePool('factory', brainA, { brainPath: brainA, workRepo: work })
  const before = readFileSync(join(brainA, 'AGENTS.md'), 'utf8')
  acp.handleReq(f.pool as never, req(4, 'fs/write_text_file', { sessionId: 'sess-factory', path: join(brainA, 'AGENTS.md'), content: 'hijacked\n' }))
  check('4 factory write to brain AGENTS.md returns an error', !!f.sent[0]?.error && f.sent[0].error.message === gates.BRAIN_WRITE_REFUSAL, JSON.stringify(f.sent))
  check('4 brain AGENTS.md is unchanged', readFileSync(join(brainA, 'AGENTS.md'), 'utf8') === before)
  const u = fakePool('factory', brainA, { brainPath: brainA, workRepo: work })
  acp.handleReq(u.pool as never, req(5, 'fs/write_text_file', { sessionId: 'unknown', path: join(brainA, 'notes.md'), content: 'x' }))
  check('4 factory write with an unknown session is refused in the brain', !!u.sent[0]?.error && !existsSync(join(brainA, 'notes.md')))
  const edit = fakePool('factory', brainA, { brainPath: brainA, workRepo: work })
  acp.handleReq(edit.pool as never, req(6, 'session/request_permission', { sessionId: 'sess-factory', toolCall: { title: 'Edit AGENTS.md', kind: 'edit', rawInput: { path: join(brainA, 'AGENTS.md') } }, options: permOpts }))
  check('4 factory edit ask on the brain is auto-rejected', outcome(edit.sent[0])?.optionId === 'reject_once')
}

// 8. Separate pool from Chat.
{
  check('8 factory pool key differs from chat key for the same cwd', acp.poolKey('grok', brainA, 'factory') !== acp.poolKey('grok', brainA) && acp.poolKey('grok', brainA) === 'grok:' + brainA)
  const fp = acp.sessionNewParams('grok', brainA, 'factory')
  const cp = acp.sessionNewParams('grok', brainA)
  check('8 factory session/new has no yoloMode', !JSON.stringify(fp).includes('yoloMode'), JSON.stringify(fp))
  check('8 chat session/new keeps yoloMode', (cp._meta as { yoloMode?: boolean }).yoloMode === true)
  check('8 grokFactoryAcpArgs has no --always-approve and its own socket', !gargs.grokFactoryAcpArgs(brainA, true).includes('--always-approve') && gargs.grokFactoryAcpArgs(brainA, true).includes(gargs.grokFactorySocket()) && gargs.grokFactorySocket() !== gargs.grokLeaderSocket())
}

// 9. Factory permission asks are never auto-answered.
{
  const f = fakePool('factory', brainA, { brainPath: brainA, workRepo: work })
  acp.handleReq(f.pool as never, req(9, 'session/request_permission', { sessionId: 'sess-factory', toolCall: { title: 'Edit src/footer.ts', kind: 'edit', rawInput: { path: join(work, 'src', 'footer.ts') } }, options: permOpts }))
  check('9 factory ask with a known tab does not reply', f.sent.length === 0, JSON.stringify(f.sent))
  check('9 factory ask emits a permission event', f.events.some((e) => e.kind === 'permission' && e.title === 'Edit src/footer.ts'))
  const u = fakePool('factory', brainA, { brainPath: brainA, workRepo: work })
  acp.handleReq(u.pool as never, req(10, 'session/request_permission', { sessionId: 'nobody', toolCall: { title: 'Edit', kind: 'edit' }, options: permOpts }))
  check('9 factory ask with an unknown session is cancelled, never allowed', outcome(u.sent[0])?.outcome === 'cancelled' && !JSON.stringify(u.sent).includes('allow_once'), JSON.stringify(u.sent))
  const c = fakePool('chat', brainA)
  acp.handleReq(c.pool as never, req(11, 'session/request_permission', { sessionId: 'sess-chat', toolCall: { title: 'Edit' }, options: permOpts }))
  check('9 chat always-approve is unchanged (auto allow)', outcome(c.sent[0])?.optionId === 'allow_once')
}

// 10. Chat ACP writes outside its folder like Terminal; team paths in any brain stay guarded.
{
  const out = join(temp, 'elsewhere', 'out.md')
  const c = fakePool('chat', brainA)
  acp.handleReq(c.pool as never, req(20, 'fs/write_text_file', { sessionId: 'sess-chat', path: out, content: 'outside\n' }))
  check('10 chat write outside the folder replies {}', JSON.stringify(c.sent[0]?.result) === '{}', JSON.stringify(c.sent))
  acp.handleReq(c.pool as never, req(21, 'fs/read_text_file', { sessionId: 'sess-chat', path: out }))
  check('10 chat read of that file returns its content', (c.sent[1]?.result as { content?: string } | undefined)?.content === 'outside\n')
  acp.handleReq(c.pool as never, req(22, 'fs/write_text_file', { sessionId: 'sess-chat', path: 'relative/out.md', content: 'x' }))
  acp.handleReq(c.pool as never, req(23, 'fs/read_text_file', { sessionId: 'sess-chat', path: 'AGENTS.md' }))
  check('10 relative paths are refused', !!c.sent[2]?.error && !!c.sent[3]?.error && !existsSync(join(brainA, 'relative')))
  acp.handleReq(c.pool as never, req(24, 'fs/write_text_file', { sessionId: 'sess-chat', path: join(brainB, 'skills', 'a.md'), content: 'x' }))
  check('10 no-seat write to <brain B>/skills is refused (guard uses the target brain)', !!c.sent[4]?.error && !existsSync(join(brainB, 'skills', 'a.md')), JSON.stringify(c.sent[4]))
  symlinkSync(join(brainB, 'skills'), join(brainA, 'linked-skills'))
  acp.handleReq(c.pool as never, req(25, 'fs/write_text_file', { sessionId: 'sess-chat', path: join(brainA, 'linked-skills', 'b.md'), content: 'x' }))
  check('10 a symlink in brain A pointing at brain B skills does not bypass the guard', !!c.sent[5]?.error && !existsSync(join(brainB, 'skills', 'b.md')))
  execFileSync('/bin/rm', ['-f', join(brainA, 'linked-skills')])
  acp.handleReq(c.pool as never, req(26, 'fs/write_text_file', { sessionId: 'sess-chat', path: join(brainA, 'clients', 'acme.md'), content: 'ok\n' }))
  check('10 chat can still write the rest of its own brain', JSON.stringify(c.sent[6]?.result) === '{}')
  execFileSync('/bin/rm', ['-rf', join(brainA, 'clients')])
  let threw = false
  try {
    files.writeSafe(brainA, out, 'x')
  } catch {
    threw = true
  }
  check('10 files.ts writeSafe outside the brain still throws', threw)
  let readThrew = false
  try {
    files.readSafe(brainA, out)
  } catch {
    readThrew = true
  }
  check('10 files.ts readSafe outside the brain still throws', readThrew)
}

// Controller unit with a fake driver: tripwire, upgrade click, lock, resume after restart.
type Call = { fn: string; o?: Record<string, unknown> }
const calls: Call[] = []
const events: { runId: string; kind: string; run?: { phase: string } }[] = []
let promptPlan: (o: { text: string }) => Promise<void> = async () => {}
ctl.configureFactory({
  driver: {
    warm: async (o) => {
      calls.push({ fn: 'warm', o })
      return { sessionId: o.resumeId || 'grok-sess-' + calls.length }
    },
    prompt: async (o) => {
      calls.push({ fn: 'prompt', o: { text: o.text, tabId: o.tabId } })
      await promptPlan(o)
      return ''
    },
    cancel: (tabId) => void calls.push({ fn: 'cancel', o: { tabId } }),
    close: (tabId) => void calls.push({ fn: 'close', o: { tabId } })
  },
  emit: (e) => void events.push(e as never),
  env: (r) => gates.factoryEnv({ ...process.env }, gates.ensureShims(store.factoryShimDir())),
  runScript: async () => ({ code: 0, out: 'ok' })
})

// 5. Tripwire: T0 task that edits 2 files trips, tier stays T0 until the click.
{
  promptPlan = async () => {
    writeFileSync(join(work, 'src', 'footer.ts'), 'export const footer = "Copyright 2026"\n')
    writeFileSync(join(work, 'src', 'header.ts'), 'export const header = "Hi"\n')
  }
  const res = ctl.startRun({ task: 'fix typo in footer', workRepo: work, brainPath: brainA })
  check('5 start T0 run', res.ok && res.run.tier === 'T0', JSON.stringify(res))
  const id = res.ok ? res.run.id : ''
  const after = await ctl.settle(id)
  check('5 two files on T0 trips to upgrade', after?.phase === 'upgrade' && after.tripwire?.suggest === 'T1', JSON.stringify(after?.tripwire))
  check('5 tier is unchanged after the trip', after?.tier === 'T0' && store.loadRun(id)?.tier === 'T0')
  const second = ctl.startRun({ task: 'another change', workRepo: join(work, 'src'), brainPath: brainA })
  check('7 a second run on the same repo is refused with the running title', !second.ok && second.error.includes('fix typo in footer'), JSON.stringify(second))
  let prompts = calls.filter((c) => c.fn === 'prompt').length
  promptPlan = async () => {}
  ctl.decideRun(id, 'upgrade')
  const up = await ctl.settle(id)
  check('5 decide upgrade moves to T1 and on to review', up?.tier === 'T1' && up.phase === 'review', JSON.stringify({ phase: up?.phase, tier: up?.tier, error: up?.error }))
  const selfCheck = calls.filter((c) => c.fn === 'prompt').slice(prompts)
  check('5 T1 runs one self-check turn with phase review', selfCheck.length === 1 && /Role: self-check\. Tier: T1\. Phase: review\./.test(String(selfCheck[0]?.o?.text)))
  check('5 review shows the diff', !!up?.diff?.includes('Copyright 2026'))
  const briefs = calls.filter((c) => c.fn === 'prompt').map((c) => String(c.o?.text))
  check('brief is at most 1,200 characters and carries role, tier, phase, work repo', briefs.every((b) => b.length <= BRIEF_MAX && /Role: /.test(b) && /Tier: T[01]/.test(b) && /Phase: /.test(b) && b.includes(work)))
  const done = ctl.commitRunNow(id)
  check('commit click commits in the work repo and records the sha', done.phase === 'done' && !!done.commitSha && git(work, ['rev-parse', 'HEAD']).trim() === done.commitSha)
  check('commit leaves the work repo clean and never adds a remote', git(work, ['status', '--porcelain']).trim() === '' && git(work, ['remote']).trim() === '')
  check('7 lock is released after done', store.activeRunFor(work) === null)
  prompts = 0
}

// 6. Resume after restart: build in flight, drop memory, restore paused with the same tier, repo, session, lock.
{
  let release: () => void = () => {}
  promptPlan = () =>
    new Promise<void>((r) => {
      release = r
    })
  const res = ctl.startRun({ task: 'fix typo in footer again', workRepo: work, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  await new Promise((r) => setTimeout(r, 50))
  const inFlight = store.loadRun(id)
  check('6 run saved in build with a grok session', inFlight?.phase === 'build' && !!inFlight.grokSessionId, JSON.stringify(inFlight?.phase))
  ctl.dropMemory()
  const back = ctl.restoreRun(id)
  check(
    '6 restore gives paused with same tier, work repo, grok session, lock held',
    back?.phase === 'paused' && back.tier === inFlight?.tier && back.workRepo === inFlight?.workRepo && back.grokSessionId === inFlight?.grokSessionId && store.holdsLock(work, id),
    JSON.stringify(back)
  )
  const warmsBefore = calls.filter((c) => c.fn === 'warm').length
  promptPlan = async () => {
    writeFileSync(join(work, 'src', 'footer.ts'), 'export const footer = "Copyright 2027"\n')
  }
  ctl.resumeRun(id)
  const resumed = await ctl.settle(id)
  const warm = calls.filter((c) => c.fn === 'warm').slice(warmsBefore)[0]
  check('6 resume re-warms with session/load of the saved grok session id', warm?.o?.resumeId === inFlight?.grokSessionId)
  const lastPrompt = calls.filter((c) => c.fn === 'prompt').at(-1)
  check('6 resume resends the phase brief', /Phase: build\./.test(String(lastPrompt?.o?.text)))
  check('6 resumed T0 run reaches review', resumed?.phase === 'review', JSON.stringify({ phase: resumed?.phase, error: resumed?.error }))
  release()
  const gone = ctl.abandonRun(id)
  check('7 abandon releases the lock', gone.phase === 'abandoned' && store.activeRunFor(work) === null)
  git(work, ['checkout', '--', '.'])
}

// Dirty work repo refuses start; critical risk needs a click.
{
  writeFileSync(join(work, 'scratch.txt'), 'dirty')
  const dirty = ctl.startRun({ task: 'fix typo', workRepo: work, brainPath: brainA })
  check('dirty work repo refuses start', !dirty.ok && dirty.error.startsWith('This repo has uncommitted changes.'))
  execFileSync('/bin/rm', ['-f', join(work, 'scratch.txt')])
  const crit = ctl.startRun({ task: 'fix the stripe checkout total', workRepo: work, brainPath: brainA })
  check('critical risk needs Proceed at T1', !crit.ok && !!crit.needsProceed && store.activeRunFor(work) === null)
}

// 3, 4, 8 end to end through the real factory lane, against a fake grok binary (no live Grok).
{
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(temp, 'fake-grok.jsonl')
  const plan = join(temp, 'fake-plan.json')
  process.env.FAKE_GROK_LOG = log
  process.env.FAKE_GROK_PLAN = plan
  writeFileSync(
    join(bin, 'grok'),
    `#!/usr/bin/env node
const fs = require('fs')
const log = (o) => fs.appendFileSync(process.env.FAKE_GROK_LOG, JSON.stringify(o) + '\\n')
const argv = process.argv.slice(2)
log({ argv, path0: (process.env.PATH || '').split(':')[0], anthropic: 'ANTHROPIC_API_KEY' in process.env })
if (argv[0] === 'agent' && argv[1] === 'leader') {
  const sock = argv[argv.indexOf('--leader-socket') + 1]
  fs.writeFileSync(sock, '')
  process.on('SIGTERM', () => { try { fs.unlinkSync(sock) } catch {} ; process.exit(0) })
  setInterval(() => {}, 1000)
} else {
  let buf = ''
  let next = 1000
  const waiting = new Map()
  const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n')
  const ask = (method, params) => new Promise((r) => { const id = next++; waiting.set(id, r); send({ id, method, params }) })
  async function onMsg(m) {
    if (m.id != null && !m.method) { const r = waiting.get(m.id); waiting.delete(m.id); if (r) r(m); return }
    log({ method: m.method, params: m.params })
    if (m.id == null) return
    if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] } })
    if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 'fake-sess-1' } })
    if (m.method === 'session/load') return send({ id: m.id, result: { sessionId: m.params.sessionId } })
    if (m.method === 'session/prompt') {
      const steps = JSON.parse(fs.readFileSync(process.env.FAKE_GROK_PLAN, 'utf8'))
      for (const s of steps) {
        if (s.write) log({ step: 'write', path: s.write, reply: await ask('fs/write_text_file', { sessionId: m.params.sessionId, path: s.write, content: s.content }) })
        if (s.native) fs.writeFileSync(s.native, s.content)
        if (s.perm) log({ step: 'perm', title: s.perm.title, reply: await ask('session/request_permission', { sessionId: m.params.sessionId, toolCall: s.perm, options: ${JSON.stringify(permOpts)} }) })
        if (s.say) send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: s.say } } } })
      }
      return send({ id: m.id, result: { stopReason: 'end_turn' } })
    }
    send({ id: m.id, result: {} })
  }
  process.stdin.on('data', (d) => { buf += d; const parts = buf.split('\\n'); buf = parts.pop(); for (const l of parts) if (l.trim()) onMsg(JSON.parse(l)) })
}
`
  )
  chmodSync(join(bin, 'grok'), 0o755)
  const footer = join(work, 'src', 'footer.ts')
  writeFileSync(
    plan,
    JSON.stringify([
      { write: footer, content: 'export const footer = "Copyright 2026!"\n' },
      { write: join(brainA, 'AGENTS.md'), content: 'hijacked\n' },
      { native: join(brainA, 'AGENTS.md'), content: '# Brain A rules\nnative tool write\n' },
      { perm: { title: 'Run git push origin main', kind: 'execute', rawInput: { command: 'git push origin main' } } },
      { perm: { title: 'Run npm run typecheck', kind: 'execute', rawInput: { command: 'npm run typecheck' } } },
      { say: 'Fixed the typo.' }
    ])
  )
  const streamed: { kind: string; ev?: { kind: string; requestId?: string } }[] = []
  let decided = ''
  ctl.configureFactory({
    driver: {
      warm: (o) => acp.factoryWarm(o),
      prompt: (o) => acp.factoryPrompt(o),
      cancel: (t) => void acp.factoryCancel(t),
      close: (t) => acp.factoryClose(t)
    },
    emit: (e) => {
      if (e.kind !== 'stream') return
      streamed.push(e as never)
      if (e.ev.kind === 'permission') {
        const runId = e.runId
        setTimeout(() => {
          decided = acp.acpDecidePermission('factory-' + runId, 'allowOnce') ? 'allowOnce' : 'failed'
        }, 20)
      }
    },
    env: (r) => gates.factoryEnv({ ...process.env }, gates.ensureShims(store.factoryShimDir())),
    runScript: async () => ({ code: 0, out: 'ok' })
  })
  const res = ctl.startRun({ task: 'fix typo in footer', workRepo: work, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  check('e2e start', res.ok, JSON.stringify(res))
  const end = await ctl.settle(id)
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []
  const acpBoot = lines.find((l) => Array.isArray(l.argv) && (l.argv as string[]).includes('stdio')) as { argv: string[]; path0: string; anthropic: boolean } | undefined
  const leaderBoot = lines.find((l) => Array.isArray(l.argv) && (l.argv as string[])[1] === 'leader') as { argv: string[]; path0: string; anthropic: boolean } | undefined
  const newParams = lines.find((l) => l.method === 'session/new')?.params as Record<string, unknown> | undefined
  const prompt = lines.find((l) => l.method === 'session/prompt')?.params as { prompt?: { text?: string }[] } | undefined
  check('8 e2e factory argv: --cwd brain, no --always-approve, factory socket', !!acpBoot && acpBoot.argv[1] === brainA && !acpBoot.argv.includes('--always-approve') && acpBoot.argv.includes(gargs.grokFactorySocket()), JSON.stringify(acpBoot?.argv))
  check('8 e2e factory leader runs on leader-brain-factory.sock', !!leaderBoot && leaderBoot.argv.includes(gargs.grokFactorySocket()))
  check('8 e2e captured session/new has no yoloMode and cwd is the brain', !!newParams && !JSON.stringify(newParams).includes('yoloMode') && newParams.cwd === brainA, JSON.stringify(newParams))
  check('e2e factory children get shims first and no ANTHROPIC_API_KEY', !!acpBoot && acpBoot.path0 === store.factoryShimDir() && !acpBoot.anthropic && !!leaderBoot && !leaderBoot.anthropic && leaderBoot.path0 === store.factoryShimDir())
  check('e2e brief reaches Grok with role, tier, phase', /Role: builder\. Tier: T0\. Phase: build\./.test(String(prompt?.prompt?.[0]?.text)))
  const writes = lines.filter((l) => l.step === 'write') as { path: string; reply: { result?: unknown; error?: unknown } }[]
  check('3 e2e Grok edits the work repo by absolute path', JSON.stringify(writes[0]?.reply?.result) === '{}' && readFileSync(footer, 'utf8').includes('Copyright 2026!'), JSON.stringify(writes[0]))
  const perms = lines.filter((l) => l.step === 'perm') as { title: string; reply: { result?: { outcome?: { optionId?: string; outcome?: string } } } }[]
  check('2 e2e git push ask is rejected', perms[0]?.reply?.result?.outcome?.optionId === 'reject_once', JSON.stringify(perms[0]))
  check('9 e2e ordinary ask waits for the card, then gets the person\'s answer', perms[1]?.reply?.result?.outcome?.optionId === 'allow_once' && decided === 'allowOnce' && streamed.some((s) => s.ev?.kind === 'permission'))
  check('4 e2e ACP write to brain AGENTS.md was refused', !!writes[1]?.reply?.error)
  check('4 e2e audit shows the native brain write (not reverted)', !!end?.audit?.brain.includes('AGENTS.md') && readFileSync(join(brainA, 'AGENTS.md'), 'utf8').includes('native tool write'), JSON.stringify(end?.audit))
  check('3 e2e run reaches review with the work repo edit', end?.phase === 'review' && !!end.audit?.work.some((w) => w.path === 'src/footer.ts'), JSON.stringify({ phase: end?.phase, error: end?.error, audit: end?.audit }))
  check('e2e Grok text streams to the Factory tab', streamed.some((s) => s.ev?.kind === 'text'))
  const acct = await acp.acpGrokAccount(brainA)
  check('Chat /usage never picks the factory pool', (acct as { starting?: boolean }).starting === true && (await acp.acpGrokReady(brainA, 50)) === false)
  const done = ctl.commitRunNow(id)
  check('e2e commit on click', done.phase === 'done' && git(work, ['log', '-1', '--format=%s']).trim() === 'fix typo in footer')
  acp.acpKillAll()
  await new Promise((r) => setTimeout(r, 200))
  check('acpKillAll stops the factory leader', !existsSync(gargs.grokFactorySocket()))
  git(brainA, ['checkout', '--', '.'])
}

// 12. Store only under userData; neither repo sees it.
{
  check('12 factoryDir is under userData, not the brain or work repo', underPath(realish(userData), realish(store.factoryDir())) && !underPath(realish(brainA), realish(store.factoryDir())) && !underPath(realish(work), realish(store.factoryDir())))
  check('12 brain and work repo git status are clean after runs', git(work, ['status', '--porcelain']).trim() === '' && git(brainA, ['status', '--porcelain']).trim() === '', git(brainA, ['status', '--porcelain']))
}

// Persist keeps the factory tab and runId; phone never lists it.
{
  persist.saveChats({ cwd: brainA, active: 'f1', tabs: [{ id: 'c1', type: 'chat', title: 'Grok' }, { id: 'f1', type: 'factory', title: 'Factory', runId: 'run-abc123' }], messages: {} })
  const back = persist.loadChats(brainA)
  check('persist keeps the factory tab and runId', back?.tabs.some((t) => t.type === 'factory' && t.runId === 'run-abc123') === true)
  check('phone never lists factory tabs', phoneLib.isPhoneChatTab({ type: 'factory' }) === false)
  const page = readFileSync(join(rootRepo, 'src/main/phone-page.ts'), 'utf8')
  check('phone page filters factory tabs too', /t\.type !== 'factory'/.test(page))
}

const pass = results.every((r) => r.ok)
const out = [...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok || !r.detail ? '' : `  ${r.detail}`}`), '', pass ? 'FACTORY_PASS' : 'FACTORY_FAIL'].join('\n')
writeFileSync(join(temp, 'out.txt'), out)
console.log(out)
console.log(`\nartifact: ${join(temp, 'out.txt')}`)
process.exit(pass ? 0 : 1)
