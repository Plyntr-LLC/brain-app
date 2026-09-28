import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Factory Slice 1 + Slice 2 + Slice 3 gate. Drives the real main-process modules (acp-session handleReq,
// factory lane boot against a fake grok binary, controller, run store) with electron stubbed, HOME
// and userData in tmp folders. Fake claude, stubbed voice, bare tmp remote. No live Grok, no live
// Claude, no Doppler, no tunnel. Prints FACTORY_PASS only if every check passes.

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

const realHome = process.env.HOME || ''
process.env.HOME = home
// Never find this Mac's real grok or claude: only the fakes under the tmp HOME.
process.env.PATH = String(process.env.PATH || '')
  .split(':')
  .filter((d) => d && !(realHome && d.startsWith(realHome)) && !/\.(grok|local|claude)\b/.test(d))
  .join(':')
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.ANTHROPIC_API_KEY = 'fixture-not-a-real-key'
process.env.ANTHROPIC_TRANSLATOR_API_KEY = 'fixture-not-a-real-key'
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
const profiles = (await import(src('factory/profile.ts'))) as typeof import('../src/main/factory/profile.ts')
const aicli = (await import(src('ai-cli.ts'))) as typeof import('../src/main/ai-cli.ts')
const resolver = (await import(src('factory/resolve-repo.ts'))) as typeof import('../src/main/factory/resolve-repo.ts')
const tripwire = (await import(src('factory/tripwire.ts'))) as typeof import('../src/main/factory/tripwire.ts')
store.setUserDataDir(() => userData)

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })

type Sent = { id: number | string; result?: unknown; error?: { code: number; message: string } }
type Ev = { kind: string; title?: string; path?: string; data?: string; options?: { id: string; label: string }[] }
function fakePool(lane: 'chat' | 'factory', cwd: string, factory?: { brainPath: string; workRepo: string; runThrough?: boolean }) {
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
let promptPlan: (o: { text: string; tabId?: string }) => Promise<void | string> = async () => {}
let triageBin: string | null = null
const scriptRuns: string[] = []
type VoiceCall = { bin: string; args: string[]; body: string }
const voiceCalls: VoiceCall[] = []
let voiceCode = 0
const fakeDeps: Parameters<typeof ctl.configureFactory>[0] = {
  driver: {
    warm: async (o) => {
      calls.push({ fn: 'warm', o })
      return { sessionId: o.resumeId || 'grok-sess-' + calls.length }
    },
    prompt: async (o) => {
      calls.push({ fn: 'prompt', o: { text: o.text, tabId: o.tabId } })
      const out = await promptPlan(o)
      return typeof out === 'string' ? out : ''
    },
    cancel: (tabId) => void calls.push({ fn: 'cancel', o: { tabId } }),
    close: (tabId) => void calls.push({ fn: 'close', o: { tabId } }),
    setEffort: async (tabId, effort) => void calls.push({ fn: 'effort', o: { tabId, effort } })
  },
  emit: (e) => void events.push(e as never),
  env: (r) => gates.factoryEnv({ ...process.env }, gates.ensureShims(store.factoryShimDir())),
  runScript: async (_r, script) => {
    scriptRuns.push(script)
    return { code: 0, out: 'ok' }
  },
  grokBin: () => triageBin,
  spawnVoice: ((bin: string, args: string[]) => {
    const file = String(args.find((a) => a.startsWith('--file=')) || '').slice(7)
    voiceCalls.push({ bin, args, body: existsSync(file) ? readFileSync(file, 'utf8') : '' })
    if (bin !== 'doppler') throw new Error('voice stub expected doppler')
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(voiceCode === 0 ? 'APPROVE\n' : 'REJECT: reads like an ad\n'))
      child.emit('close', voiceCode)
    }, 5)
    return child as never
  }) as never,
  voiceCheckPath: self
}
ctl.configureFactory(fakeDeps)

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
  check('brief is at most 1,200 characters and carries role, tier, phase, work repo', briefs.every((b) => b.length <= BRIEF_MAX && /Role: /.test(b) && /Tier: T[012]/.test(b) && /Phase: /.test(b) && b.includes(work)))
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

// Dirty work repo: Start opens the run and waits on Commit first / Stash first (Approve in advance too). Critical risk needs a click.
{
  const turns = () => calls.filter((c) => c.fn === 'prompt').length
  const stashes = () => git(work, ['stash', 'list']).trim().split('\n').filter(Boolean).length
  promptPlan = async () => {
    writeFileSync(join(work, 'src', 'footer.ts'), 'export const footer = "Copyright 2026"\n')
  }
  writeFileSync(join(work, 'scratch.txt'), 'dirty')
  writeFileSync(join(work, 'src', 'footer.ts'), 'export const footer = "Copyrigth 2026 wip"\n')
  const head0 = git(work, ['rev-parse', 'HEAD']).trim()
  const t0 = turns()
  const dirty = ctl.startRun({ task: 'fix typo in footer text', workRepo: work, brainPath: brainA })
  const did = dirty.ok ? dirty.run.id : ''
  check(
    'dirty start returns ok with needsPrep and the dirty files',
    dirty.ok && dirty.run.phase === 'triage' && dirty.run.needsPrep === 'dirty' && !!dirty.run.dirtyFiles?.includes('scratch.txt') && dirty.run.dirtyFiles.includes('src/footer.ts'),
    JSON.stringify(dirty.ok ? { phase: dirty.run.phase, prep: dirty.run.needsPrep, files: dirty.run.dirtyFiles } : dirty)
  )
  await ctl.settle(did)
  check('dirty start: triage has not run, no turn, lock held', !store.loadRun(did)?.triage.llm && turns() === t0 && store.holdsLock(work, did) && store.loadRun(did)?.base === head0)
  ctl.resumeRun(did)
  await ctl.settle(did)
  check('dirty start: Resume does not start triage', store.loadRun(did)?.needsPrep === 'dirty' && !store.loadRun(did)?.triage.llm && turns() === t0)
  ctl.decideRun(did, 'prep-commit')
  const committed = await ctl.settle(did)
  const wip = git(work, ['rev-parse', 'HEAD']).trim()
  check('prep-commit makes a WIP commit with every dirty path', wip !== head0 && git(work, ['log', '-1', '--format=%s']).trim() === 'WIP before Factory: fix typo in footer text' && git(work, ['show', '--name-only', '--format=', 'HEAD']).includes('scratch.txt'))
  check(
    'prep-commit clears prep, base is the new HEAD, triage then build ran',
    !committed?.needsPrep && !committed?.dirtyFiles && committed?.base === wip && !!committed.triage.llm && committed.phase === 'review' && turns() === t0 + 1,
    JSON.stringify({ phase: committed?.phase, base: committed?.base, error: committed?.error })
  )
  ctl.abandonRun(did)
  git(work, ['checkout', '--', '.'])

  writeFileSync(join(work, 'scratch2.txt'), 'dirty again')
  const s0 = stashes()
  const t1 = turns()
  const through = ctl.startRun({ task: 'fix typo in footer text', workRepo: work, brainPath: brainA, runThrough: true })
  const tid = through.ok ? through.run.id : ''
  await ctl.settle(tid)
  check('runThrough still waits on dirty prep (no auto WIP commit)', through.ok && store.loadRun(tid)?.needsPrep === 'dirty' && turns() === t1 && git(work, ['rev-parse', 'HEAD']).trim() === wip && stashes() === s0)
  ctl.decideRun(tid, 'prep-stash')
  const stashed = await ctl.settle(tid)
  check('prep-stash leaves a stash and a clean start, base is HEAD', stashes() === s0 + 1 && git(work, ['stash', 'list']).includes('Factory: fix typo in footer text') && stashed?.base === wip && !stashed.needsPrep, JSON.stringify({ base: stashed?.base, phase: stashed?.phase }))
  check('prep-stash run goes on to a commit and never pops the stash', stashed?.phase === 'done' && !!stashed.commitSha && stashes() === s0 + 1 && !existsSync(join(work, 'scratch2.txt')), JSON.stringify({ phase: stashed?.phase, error: stashed?.error }))
  git(work, ['stash', 'drop', '-q'])

  writeFileSync(join(work, 'scratch3.txt'), 'dirty')
  const head1 = git(work, ['rev-parse', 'HEAD']).trim()
  const left = ctl.startRun({ task: 'fix typo in footer text', workRepo: work, brainPath: brainA })
  const lid = left.ok ? left.run.id : ''
  const gone = ctl.abandonRun(lid)
  check('Abandon from the dirty wait releases the lock, no commit, no stash', gone.phase === 'abandoned' && store.activeRunFor(work) === null && git(work, ['rev-parse', 'HEAD']).trim() === head1 && stashes() === s0 && existsSync(join(work, 'scratch3.txt')))
  execFileSync('/bin/rm', ['-f', join(work, 'scratch3.txt')])
  // 25 dirty paths: the list keeps 20, dirtyCount keeps the true number for the card.
  const many = repo('many-dirty', { 'README.md': 'x\n' })
  for (let i = 0; i < 25; i++) writeFileSync(join(many, `d${i}.txt`), 'dirty')
  const lots = ctl.startRun({ task: 'fix typo in footer text', workRepo: many, brainPath: brainA })
  check('dirty start stores the true dirtyCount (25) and caps dirtyFiles at 20', lots.ok && lots.run.dirtyCount === 25 && lots.run.dirtyFiles?.length === 20, JSON.stringify(lots.ok ? { n: lots.run.dirtyCount, files: lots.run.dirtyFiles?.length } : lots))
  if (lots.ok) ctl.abandonRun(lots.run.id)
  const clean = ctl.startRun({ task: 'fix typo in footer text', workRepo: work, brainPath: brainA })
  check('clean Start has no needsPrep', clean.ok && !clean.run.needsPrep && !clean.run.dirtyFiles)
  if (clean.ok) {
    await ctl.settle(clean.run.id)
    ctl.abandonRun(clean.run.id)
  }
  git(work, ['checkout', '--', '.'])
  const crit = ctl.startRun({ task: 'fix the stripe checkout total', workRepo: work, brainPath: brainA })
  check('critical risk needs Proceed at T1', !crit.ok && !!crit.needsProceed && store.activeRunFor(work) === null)
}

// ---- Slice 2 (fake driver, fake claude, voice stub, bare remote) ----
const claudeBin = join(home, '.local', 'bin', 'claude')
const claudeLog = join(temp, 'fake-claude.jsonl')
const claudePlan = join(temp, 'fake-claude-plan.json')
process.env.FAKE_CLAUDE_LOG = claudeLog
process.env.FAKE_CLAUDE_PLAN = claudePlan
mkdirSync(dirname(claudeBin), { recursive: true })
const claudeSource = `#!/usr/bin/env node
const fs = require('fs')
let n = 0
try { n = fs.readFileSync(0).length } catch { n = 0 }
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, stdinBytes: n, cwd: process.cwd(), anthropic: 'ANTHROPIC_API_KEY' in process.env, translator: 'ANTHROPIC_TRANSLATOR_API_KEY' in process.env }) + '\\n')
let plan = []
try { plan = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_PLAN, 'utf8')) } catch {}
const next = plan.shift()
fs.writeFileSync(process.env.FAKE_CLAUDE_PLAN, JSON.stringify(plan))
process.stdout.write(next == null ? 'no plan line\\n' : next + '\\n')
`
const installClaude = () => {
  writeFileSync(claudeBin, claudeSource)
  chmodSync(claudeBin, 0o755)
}
installClaude()
type ClaudeRow = { argv: string[]; pid: number; stdinBytes: number; cwd: string; anthropic: boolean; translator: boolean }
const claudeRows = (): ClaudeRow[] => (existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as ClaudeRow) : [])
const claudeSays = (lines: string[]) => writeFileSync(claudePlan, JSON.stringify(lines))
check('S2 resolveBin finds the fake claude under the tmp HOME only', aicli.resolveBin('claude') === claudeBin)

const pkg2 = JSON.stringify({ name: 'work2', private: true, scripts: { typecheck: 'x', test: 'x', 'test:e2e': 'x' } })
const work2 = repo('work2', { 'package.json': pkg2, 'README.md': 'Hello there\n', 'src/app.ts': 'export const app = 1\n' })
const bare = join(temp, 'origin.git')
mkdirSync(bare)
git(bare, ['init', '-q', '--bare', '-b', 'main'])
git(work2, ['remote', 'add', 'origin', bare])
const reset2 = () => {
  git(work2, ['checkout', '-q', '--', '.'])
  git(work2, ['clean', '-qfd'])
}
const promptsFrom = (n: number) => calls.filter((c) => c.fn === 'prompt').slice(n).map((c) => String(c.o?.text))
const promptCount = () => calls.filter((c) => c.fn === 'prompt').length
const effortsFrom = (n: number) => calls.filter((c) => c.fn === 'effort').slice(n).map((c) => String(c.o?.effort))
const effortCount = () => calls.filter((c) => c.fn === 'effort').length

// Profiles: detection, userData only, voice off by default.
{
  const p = profiles.readProfile(work2)
  check('S2 6 profile detects typecheck, test, test:e2e; voice off; origin', p.scripts.typecheck === 'typecheck' && p.scripts.test === 'test' && p.scripts.e2e === 'test:e2e' && p.voice.on === false && p.publish.remote === 'origin', JSON.stringify(p))
  check('S2 6 profile line', profiles.profileLine(p) === 'This repo: typecheck · test · test:e2e')
}

// 3 + 4. T2: triage then an Opus plan; no build before Approve; resume stays in plan; every reject is a fresh Opus; approve.
const T2TASK = 'Add a new page for team settings with a new route and shared types'
{
  promptPlan = async (o) => {
    if (/Phase: build\./.test(o.text)) {
      writeFileSync(join(work2, 'src', 'team.ts'), 'export const team = 1\n')
      writeFileSync(join(work2, 'src', 'routes.ts'), 'export const routes = ["team"]\n')
    }
    if (/Phase: fix\./.test(o.text)) writeFileSync(join(work2, 'src', 'team.ts'), 'export const team = 2\n')
  }
  claudeSays(['Plan 1: add src/team.ts and src/routes.ts, test with npm test.'])
  const p0 = promptCount()
  const c00 = claudeRows().length
  const res = ctl.startRun({ task: T2TASK, workRepo: work2, brainPath: brainA })
  check('S2 3 T2 start lands in triage first', res.ok && res.run.phase === 'triage' && res.run.tier === 'T2', JSON.stringify(res))
  const id = res.ok ? res.run.id : ''
  let r = await ctl.settle(id)
  const planner1 = claudeRows()[c00]
  const pArgv = planner1?.argv || []
  const pFlag = (f: string) => pArgv[pArgv.indexOf(f) + 1]
  check('S2 3 T2 first plan is by Opus and waits for Approve', r?.phase === 'plan' && r.plan?.status === 'waiting' && !!r.plan.text.startsWith('Plan 1') && r.plan.by === 'opus' && r.plan.rejects === 0, JSON.stringify({ phase: r?.phase, plan: r?.plan, error: r?.error }))
  check('S2 3 first plan: one claude spawn, no Grok plan or build turn, work repo clean', claudeRows().length === c00 + 1 && promptsFrom(p0).length === 0 && git(work2, ['status', '--porcelain']).trim() === '', JSON.stringify(promptsFrom(p0)))
  check(
    'S2 3 first plan argv: -p T2 plan prompt, --model opus, --effort medium, --permission-mode plan; stdin empty, no Anthropic keys, cwd work repo',
    pArgv[0] === '-p' && pArgv[1].includes(T2TASK) && pArgv[1].includes('Limit T2') && !pArgv[1].includes('Earlier plans') && pFlag('--model') === 'opus' && pFlag('--effort') === 'medium' && pFlag('--permission-mode') === 'plan' && planner1.stdinBytes === 0 && !planner1.anthropic && !planner1.translator && realish(planner1.cwd) === realish(work2),
    JSON.stringify(pArgv.filter((a) => a.length < 40))
  )
  check('S2 3 run keeps the profile snapshot', r?.profile?.scripts.e2e === 'test:e2e')
  check('S2 3 plan text sits beside the run record', existsSync(store.runTextPath(id, 'plan')) && readFileSync(store.runTextPath(id, 'plan'), 'utf8').startsWith('Plan 1'))
  ctl.dropMemory()
  const p1 = promptCount()
  ctl.resumeRun(id)
  r = await ctl.settle(id)
  check('S2 3 resumeRun after dropMemory stays in plan and sends no turn or claude', r?.phase === 'plan' && r.plan?.status === 'waiting' && promptCount() === p1 && claudeRows().length === c00 + 1, JSON.stringify({ phase: r?.phase }))
  let threw = false
  try {
    ctl.commitRunNow(id)
  } catch {
    threw = true
  }
  check('S2 3 Commit is refused while the plan waits', threw)

  // Reject 1: a fresh claude with the reason and the rejected plan path, no Grok turn.
  claudeSays(['Plan 2: src/team.ts only, test with npm test.'])
  const p2 = promptCount()
  const c01 = claudeRows().length
  ctl.decideRun(id, 'reject-plan', { reason: 'Too broad, skip routes' })
  r = await ctl.settle(id)
  const planner2 = claudeRows()[c01]
  check(
    'S2 4 reject 1 is one new claude process with the reason and the rejected plan path',
    claudeRows().length === c01 + 1 && planner2.pid !== planner1?.pid && planner2.argv[1].includes('Too broad, skip routes') && planner2.argv[1].includes(store.runTextPath(id, 'plan')) && promptsFrom(p2).length === 0,
    JSON.stringify({ spawns: claudeRows().length - c01, prompts: promptsFrom(p2) })
  )
  check('S2 4 reject count survives on disk', store.loadRun(id)?.plan?.rejects === 1 && r?.plan?.text.startsWith('Plan 2') === true && r.plan.by === 'opus' && r.plan.status === 'waiting')

  // Reject 2: another fresh claude -p writes the plan.
  claudeSays(['Opus plan: one route, one component, one test.'])
  const c0 = claudeRows().length
  ctl.decideRun(id, 'reject-plan', { reason: 'Still wrong' })
  r = await ctl.settle(id)
  const row = claudeRows()[c0]
  const argv = row?.argv || []
  const flag = (f: string) => argv[argv.indexOf(f) + 1]
  check('S2 4 reject 2 spawns claude once, a new process', claudeRows().length === c0 + 1 && row?.pid !== planner2?.pid && row?.pid !== planner1?.pid)
  check('S2 4 Opus argv: -p prompt, --model opus, --effort medium, --permission-mode plan, --output-format text, no --bare', argv[0] === '-p' && argv[1].includes(T2TASK) && flag('--model') === 'opus' && flag('--effort') === 'medium' && flag('--permission-mode') === 'plan' && flag('--output-format') === 'text' && !argv.includes('--bare'), JSON.stringify(argv.filter((a) => a.length < 40)))
  check('S2 4 Opus stdin empty, no Anthropic keys, cwd is the work repo', row?.stdinBytes === 0 && row.anthropic === false && row.translator === false && realish(row.cwd) === realish(work2), JSON.stringify({ ...row, argv: undefined }))
  check('S2 4 plan by Opus waits for Approve', r?.phase === 'plan' && r.plan?.by === 'opus' && r.plan.status === 'waiting' && r.plan.text.startsWith('Opus plan') && r.plan.rejects === 2, JSON.stringify({ phase: r?.phase, plan: r?.plan, error: r?.error }))

  // Approve: build with the plan path line at Grok xhigh (Opus plan), verify with e2e, strict FAIL five times (a PASS with gaps is a FAIL).
  claudeSays(['a.ts:1 is wrong\nGAPS: 1\nFAIL', 'still wrong at a.ts:1\nFAIL', 'ok\nPASS', 'One nit: rename x.\nGAPS: 0\nPASS', 'still wrong at a.ts:9\nGAPS: 1\nFAIL'])
  const p3 = promptCount()
  const e3 = effortCount()
  const c1 = claudeRows().length
  scriptRuns.length = 0
  ctl.decideRun(id, 'approve-plan')
  r = await ctl.settle(id)
  const after = promptsFrom(p3)
  check('S2 3 approve-plan starts build with the Approved plan path line', /Phase: build\./.test(after[0] || '') && (after[0] || '').includes(`Approved plan: ${store.runTextPath(id, 'plan')}. Read it first.`), after[0])
  check('S2 3 build after an Opus plan runs at Grok xhigh', effortsFrom(e3).includes('xhigh'), JSON.stringify(effortsFrom(e3)))
  check('S2 5 T2 verify runs typecheck, test and the profile e2e', scriptRuns.slice(0, 3).join(',') === 'typecheck,test,test:e2e' && r?.verify?.some((v) => v.script === 'test:e2e' && v.status === 'pass') === true, JSON.stringify(scriptRuns))
  const fixes = after.filter((t) => /Phase: fix\./.test(t))
  check('S2 8 T2 has no self-check turn', !after.some((t) => /Role: self-check/.test(t)))
  check('S2 8 five fails send four auto fix turns with the Reviewer notes path', fixes.length === 4 && fixes.every((f) => f.includes(`Reviewer notes: ${store.runTextPath(id, 'review')}. Fix what it names.`)), JSON.stringify(fixes.length))
  check('S2 8 a PASS without GAPS and a PASS naming a nit are fails', fixes.some((f) => f.includes('PASS without GAPS: 0')) && fixes.some((f) => f.includes('PASS named gaps')), JSON.stringify(fixes.map((f) => f.split('\n').find((l) => l.startsWith('Note:')))))
  const reviews = claudeRows().slice(c1)
  const plannerPids = [planner1?.pid, planner2?.pid, row?.pid]
  check('S2 8 reviewers are never the planner process', reviews.length === 5 && reviews.every((x) => !plannerPids.includes(x.pid)), JSON.stringify({ planners: plannerPids, reviewers: reviews.map((x) => x.pid) }))
  check(
    'S2 8 exactly 5 claude review spawns, each a new process, prompt asks for GAPS then PASS/FAIL',
    reviews.length === 5 && new Set(reviews.map((x) => x.pid)).size === 5 && reviews.every((x) => x.argv[1].includes('strict-code-review/SKILL.md') && x.argv[1].trimEnd().endsWith('PASS only with GAPS: 0.')),
    JSON.stringify(reviews.map((x) => x.pid))
  )
  check('S2 8 the fifth fail holds in review with the FAIL text and reviewCycles 5, no auto-commit', r?.phase === 'review' && !!r.diff && r.reviewCycles === 5 && r.strict?.status === 'fail' && r.strict.text.includes('a.ts:9') && store.loadRun(id)?.reviewCycles === 5 && !r.commitSha, JSON.stringify({ phase: r?.phase, cycles: r?.reviewCycles, strict: r?.strict, error: r?.error }))
  check('S2 8 no Joe guide reached a reviewer', reviews.every((x) => !x.argv[1].includes('Joe says')))
  // Keep fixing after the hold: one builder fix turn, then a sixth fresh reviewer; still held (cycles past 5).
  claudeSays(['a.ts:9 still\nGAPS: 1\nFAIL'])
  const p4 = promptCount()
  const c4 = claudeRows().length
  ctl.decideRun(id, 'keep-fix')
  r = await ctl.settle(id)
  const kf = promptsFrom(p4)
  const r6 = claudeRows().slice(c4)
  check('S2 8 keep-fix: one fix turn, then another fresh Opus review, held again at 6', kf.length === 1 && /Phase: fix\./.test(kf[0]) && r6.length === 1 && !reviews.some((x) => x.pid === r6[0].pid) && r?.phase === 'review' && r.reviewCycles === 6 && r.strict?.status === 'fail', JSON.stringify({ turns: kf.length, spawns: r6.length, phase: r?.phase, cycles: r?.reviewCycles }))
  // Re-review: a fresh Opus only, no builder turn.
  claudeSays(['a.ts:9 still\nGAPS: 1\nFAIL'])
  const p5 = promptCount()
  const c5 = claudeRows().length
  ctl.decideRun(id, 're-review')
  r = await ctl.settle(id)
  check('S2 8 re-review: no builder turn, one new claude, held at 7', promptCount() === p5 && claudeRows().length === c5 + 1 && r?.phase === 'review' && r.reviewCycles === 7 && !!r.diff, JSON.stringify({ phase: r?.phase, cycles: r?.reviewCycles }))
  const done = ctl.commitRunNow(id)
  check('S2 8 Commit anyway commits and records the branch', done.phase === 'done' && done.branch === 'main' && git(work2, ['rev-parse', 'HEAD']).trim() === done.commitSha)
  const before = git(bare, ['for-each-ref']).trim()
  const pushed = await ctl.publishRun(id)
  check('S2 9 Push on main is refused and the remote is unchanged', !pushed.pushed && /does not push to main/.test(pushed.pushError || '') && git(bare, ['for-each-ref']).trim() === before && ctl.publishBlockFor(id) === pushed.pushError, pushed.pushError)
}

// 4. Third reject pauses; with no claude, the first plan and a reject both pause.
{
  promptPlan = async () => {}
  claudeSays(['Plan: small.', 'Opus plan A.', 'Opus plan B.'])
  const res = ctl.startRun({ task: T2TASK, workRepo: work2, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  await ctl.settle(id)
  ctl.decideRun(id, 'reject-plan')
  await ctl.settle(id)
  ctl.decideRun(id, 'reject-plan')
  await ctl.settle(id)
  const p0 = promptCount()
  const c0 = claudeRows().length
  const third = ctl.decideRun(id, 'reject-plan')
  const r = await ctl.settle(id)
  check('S2 4 third reject pauses with resumePhase plan', third.phase === 'paused' && r?.phase === 'paused' && r.resumePhase === 'plan' && promptCount() === p0 && claudeRows().length === c0, JSON.stringify({ phase: r?.phase, resume: r?.resumePhase }))
  ctl.abandonRun(id)

  execFileSync('/bin/rm', ['-f', claudeBin])
  const p1 = promptCount()
  const res1 = ctl.startRun({ task: T2TASK, workRepo: work2, brainPath: brainA })
  const id1 = res1.ok ? res1.run.id : ''
  const r1 = await ctl.settle(id1)
  check('S2 4 no claude at the first plan pauses in plan, no Grok plan turn', r1?.phase === 'paused' && r1.resumePhase === 'plan' && /Opus planner not found/.test(r1.error || '') && promptCount() === p1, JSON.stringify({ phase: r1?.phase, error: r1?.error }))
  ctl.resumeRun(id1)
  const r1b = await ctl.settle(id1)
  check('S2 4 resume of that pause asks Opus again (still missing: paused), never Grok', r1b?.phase === 'paused' && /not found/.test(r1b.error || '') && promptCount() === p1, JSON.stringify({ phase: r1b?.phase, error: r1b?.error }))
  ctl.abandonRun(id1)
  installClaude()
  claudeSays(['Plan: small.'])
  const res2 = ctl.startRun({ task: T2TASK, workRepo: work2, brainPath: brainA })
  const id2 = res2.ok ? res2.run.id : ''
  await ctl.settle(id2)
  execFileSync('/bin/rm', ['-f', claudeBin])
  ctl.decideRun(id2, 'reject-plan')
  const r2 = await ctl.settle(id2)
  check('S2 4 no claude at reject 1 pauses in plan', r2?.phase === 'paused' && r2.resumePhase === 'plan' && /not found/.test(r2.error || ''), JSON.stringify({ phase: r2?.phase, error: r2?.error }))
  const back = ctl.resumeRun(id2)
  check('S2 4 resume after that pause shows the waiting plan, no build', back.phase === 'plan' && back.plan?.status === 'waiting' && !!back.plan.text)
  ctl.abandonRun(id2)
  installClaude()
  reset2()
}

// 8. T1 elevated: self-check, then Opus strict PASS, then review with Commit.
{
  let claudeAtSelfCheck = -1
  promptPlan = async (o) => {
    if (/Role: self-check/.test(o.text)) claudeAtSelfCheck = claudeRows().length
    else writeFileSync(join(work2, 'src', 'app.ts'), 'export const app = "API error: try again"\n')
  }
  claudeSays(['Checked the diff.\nGAPS: 0\nPASS'])
  const c0 = claudeRows().length
  const res = ctl.startRun({ task: 'fix the API error message', workRepo: work2, brainPath: brainA })
  check('S2 8 T1 elevated start', res.ok && res.run.tier === 'T1' && res.run.risk === 'elevated', JSON.stringify(res.ok ? { tier: res.run.tier, risk: res.run.risk } : res))
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  check('S2 8 self-check ran before the strict review', claudeAtSelfCheck === c0 && claudeRows().length === c0 + 1)
  check('S2 8 PASS reaches review with Commit', r?.phase === 'review' && !!r.diff && r.strict?.status === 'pass' && r.selfChecked === true, JSON.stringify({ phase: r?.phase, strict: r?.strict, error: r?.error }))
  ctl.abandonRun(id)
  reset2()
}

// 7. T0 risk none on a plain repo never spawns claude.
{
  promptPlan = async () => {
    writeFileSync(join(work2, 'src', 'app.ts'), 'export const app = 2\n')
  }
  const c0 = claudeRows().length
  const res = ctl.startRun({ task: 'fix typo in the app label', workRepo: work2, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  check('S2 7 T0 risk none: no strict review', res.ok && res.run.tier === 'T0' && r?.phase === 'review' && !r.strict && claudeRows().length === c0, JSON.stringify({ phase: r?.phase, tier: r?.tier, strict: r?.strict }))
  ctl.abandonRun(id)
  reset2()
}

// 5. T1 trips into T2: tier stays T1 until the click, then T2 verify runs e2e.
{
  promptPlan = async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(work2, 'src', `${n}.ts`), Array.from({ length: 40 }, (_, i) => `export const ${n}${i} = ${i}`).join('\n') + '\n')
  }
  claudeSays(['GAPS: 0\nPASS'])
  const res = ctl.startRun({ task: 'Fix the date shown one day off in the order list', workRepo: work2, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  let r = await ctl.settle(id)
  check('S2 5 T1 with 5 files / 200 lines trips and suggests T2, tier stays T1', r?.phase === 'upgrade' && r.tripwire?.suggest === 'T2' && r.tier === 'T1' && store.loadRun(id)?.tier === 'T1', JSON.stringify({ phase: r?.phase, trip: r?.tripwire, tier: r?.tier }))
  scriptRuns.length = 0
  const p0 = promptCount()
  ctl.decideRun(id, 'upgrade')
  r = await ctl.settle(id)
  check('S2 5 upgrade moves to T2, skips the plan, runs the e2e row', r?.tier === 'T2' && !r.plan && scriptRuns.includes('test:e2e') && r.phase === 'review' && r.strict?.status === 'pass' && promptCount() === p0, JSON.stringify({ tier: r?.tier, phase: r?.phase, scripts: scriptRuns, error: r?.error }))
  ctl.abandonRun(id)
  reset2()
}

// 2. Model triage raises risk to critical: waits in triage for Proceed.
{
  const tbin = join(temp, 'triage-bin')
  mkdirSync(tbin, { recursive: true })
  triageBin = join(tbin, 'grok')
  writeFileSync(triageBin, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: 'text', data: '{"size":"T1","risk":"critical","reason":"touches user records"}' }))\n`)
  chmodSync(triageBin, 0o755)
  promptPlan = async () => {
    writeFileSync(join(work2, 'src', 'app.ts'), 'export const app = 3\n')
  }
  claudeSays(['GAPS: 0\nPASS'])
  const p0 = promptCount()
  const res = ctl.startRun({ task: 'Fix the date shown one day off in the order list', workRepo: work2, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  let r = await ctl.settle(id)
  check('S2 2 model raise to critical waits in triage with needsProceed, no turn', r?.phase === 'triage' && r.needsProceed === true && r.risk === 'critical' && r.triage.llm?.risk === 'critical' && promptCount() === p0, JSON.stringify({ phase: r?.phase, np: r?.needsProceed, risk: r?.risk, llm: r?.triage.llm }))
  ctl.decideRun(id, 'proceed')
  r = await ctl.settle(id)
  check('S2 2 Proceed click builds (critical gets strict)', r?.phase === 'review' && r.strict?.status === 'pass' && !r.needsProceed, JSON.stringify({ phase: r?.phase, error: r?.error }))
  ctl.abandonRun(id)
  reset2()
  writeFileSync(triageBin, `#!/usr/bin/env node\nconsole.log('I think it is small')\n`)
  const junk = ctl.startRun({ task: 'fix typo in the app label', workRepo: work2, brainPath: brainA })
  const jid = junk.ok ? junk.run.id : ''
  const j = await ctl.settle(jid)
  check('S2 2 junk model output keeps the rules result', j?.tier === 'T0' && !!j.triage.llm?.skipped && j.triage.reasons.some((x) => x.startsWith('Model triage skipped')), JSON.stringify(j?.triage))
  ctl.abandonRun(jid)
  reset2()
  triageBin = null
}

// 10. Voice: default profile never calls the stub; on + REJECT holds Commit; Fix copy + APPROVE passes.
{
  check('S2 10 voice stub never called with the default profile', voiceCalls.length === 0)
  profiles.saveProfile(work2, { voice: { on: true } })
  check('S2 6 profile save leaves the work repo clean', git(work2, ['status', '--porcelain']).trim() === '' && existsSync(join(store.factoryDir(), 'profiles', `${store.lockKey(work2)}.json`)))
  let turn = 0
  promptPlan = async () => {
    turn++
    writeFileSync(join(work2, 'README.md'), turn === 1 ? 'Hello there\nBest sites ever, buy now!\n' : 'Hello there\nWe build clear sites for vets.\n')
  }
  voiceCode = 2
  const res = ctl.startRun({ task: 'fix typo in README.md', workRepo: work2, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  let r = await ctl.settle(id)
  const call = voiceCalls[0]
  check('S2 10 voice stub called with doppler team-brain dev and the check script', !!call && call.bin === 'doppler' && call.args.slice(0, 7).join(' ') === 'run -p team-brain -c dev -- node' && call.args.some((a) => a.startsWith('--file=')) && call.args.includes('--register=email') && call.args.includes('--audience=client'), JSON.stringify(call?.args))
  check('S2 10 only added copy lines go in, tmp file deleted', call?.body.trim() === 'Best sites ever, buy now!' && !existsSync(String(call?.args.find((a) => a.startsWith('--file='))).slice(7)))
  check('S2 10 REJECT holds in review', r?.phase === 'review' && r.voice?.status === 'fail', JSON.stringify({ phase: r?.phase, voice: r?.voice, error: r?.error }))
  let hold = ''
  try {
    ctl.commitRunNow(id)
  } catch (e) {
    hold = String((e as Error).message)
  }
  check('S2 10 commitRunNow refuses with the hold sentence', hold === ctl.VOICE_HOLD && git(work2, ['log', '--oneline']).trim().split('\n').length === 2)
  voiceCode = 0
  ctl.decideRun(id, 'fix-copy')
  r = await ctl.settle(id)
  check('S2 10 Fix copy then APPROVE passes', r?.phase === 'review' && r.voice?.status === 'pass' && voiceCalls.length === 2, JSON.stringify({ phase: r?.phase, voice: r?.voice }))
  fakeDeps.voiceCheckPath = join(temp, 'no-such-check.cjs')
  ctl.configureFactory(fakeDeps)
  ctl.abandonRun(id)
  reset2()
  const res2 = ctl.startRun({ task: 'fix typo in README.md', workRepo: work2, brainPath: brainA })
  const id2 = res2.ok ? res2.run.id : ''
  const r2 = await ctl.settle(id2)
  check('S2 10 missing VOICE_CHECK gives skipped, not a fail', r2?.phase === 'review' && r2.voice?.status === 'skipped' && voiceCalls.length === 2, JSON.stringify({ phase: r2?.phase, voice: r2?.voice }))
  ctl.abandonRun(id2)
  reset2()
  profiles.saveProfile(work2, { voice: { on: false } })
  fakeDeps.voiceCheckPath = self
}

// 9. Publish: branch factory/x pushes to the bare origin; HEAD moved is refused; the shim still refuses push.
{
  git(work2, ['checkout', '-q', '-b', 'factory/x'])
  promptPlan = async () => {
    writeFileSync(join(work2, 'src', 'app.ts'), 'export const app = 9\n')
  }
  const res = ctl.startRun({ task: 'fix typo in the app label', workRepo: work2, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  await ctl.settle(id)
  const done = ctl.commitRunNow(id)
  check('S2 9 commit records branch factory/x', done.phase === 'done' && done.branch === 'factory/x')
  git(work2, ['commit', '-q', '--allow-empty', '-m', 'someone else'])
  const moved = await ctl.publishRun(id)
  check('S2 9 HEAD moved since commit: Push refused', !moved.pushed && /moved since Factory committed/.test(moved.pushError || '') && !git(bare, ['for-each-ref']).includes('factory/x'), moved.pushError)
  git(work2, ['reset', '-q', '--hard', String(done.commitSha)])
  const ok = await ctl.publishRun(id)
  check('S2 9 publishRun pushes and the remote has commitSha', ok.pushed?.sha === done.commitSha && git(bare, ['rev-parse', 'refs/heads/factory/x']).trim() === done.commitSha, JSON.stringify({ pushed: ok.pushed, err: ok.pushError }))
  const shim = spawnSync('git', ['push', 'origin', 'factory/x'], { cwd: work2, env: gates.factoryEnv({ ...process.env }, gates.ensureShims(store.factoryShimDir())), encoding: 'utf8' })
  check('S2 9 shim git push in the Factory env still exits 1', shim.status === 1)
  const fenv = gates.factoryEnv({ ...process.env }, store.factoryShimDir())
  check('S2 9 factoryEnv drops both Anthropic keys', !('ANTHROPIC_API_KEY' in fenv) && !('ANTHROPIC_TRANSLATOR_API_KEY' in fenv))
  git(work2, ['checkout', '-q', 'main'])
}

// ---- Slice 3 (fake driver, fake claude, no live Grok/Claude, no deploy) ----
{
  // S3 1. Rules: T3 is its own size, not capped, fast.
  const big = ctl.triageTask('Rewrite the whole app in Svelte')
  check('S3 1 rules: T3 ask is size T3, capped false, under 200 ms', big.size === 'T3' && big.capped === false && big.ms < 200, JSON.stringify(big))

  // S3 4. Approve in advance: ordinary asks auto-allow after the filter; push, gh, deploy, brain edits still reject.
  const ctx = { brainPath: brainA, workRepo: work2, runThrough: true }
  const f = fakePool('factory', brainA, ctx)
  acp.handleReq(f.pool as never, req(40, 'session/request_permission', { sessionId: 'sess-factory', toolCall: { title: 'Edit src/app.ts', kind: 'edit', rawInput: { path: join(work2, 'src', 'app.ts') } }, options: permOpts }))
  check('S3 4 runThrough ordinary edit ask is allow_once without the card', outcome(f.sent[0])?.optionId === 'allow_once' && !f.events.some((e) => e.kind === 'permission'), JSON.stringify(f.sent))
  for (const [n, cmd] of [['git push origin main', 'git push origin main'], ['gh', 'gh pr create'], ['deploy', 'npx wrangler deploy']] as const) {
    const g = fakePool('factory', brainA, ctx)
    acp.handleReq(g.pool as never, req(41, 'session/request_permission', { sessionId: 'sess-factory', toolCall: { title: 'Run command', kind: 'execute', rawInput: { command: cmd } }, options: permOpts }))
    check(`S3 4 runThrough "${n}" ask is still reject_once`, outcome(g.sent[0])?.optionId === 'reject_once', JSON.stringify(g.sent))
  }
  const b = fakePool('factory', brainA, ctx)
  acp.handleReq(b.pool as never, req(42, 'session/request_permission', { sessionId: 'sess-factory', toolCall: { title: 'Edit AGENTS.md', kind: 'edit', rawInput: { path: join(brainA, 'AGENTS.md') } }, options: permOpts }))
  check('S3 4 runThrough brain edit ask is still reject_once', outcome(b.sent[0])?.optionId === 'reject_once')
  const off = fakePool('factory', brainA, { brainPath: brainA, workRepo: work2 })
  acp.handleReq(off.pool as never, req(43, 'session/request_permission', { sessionId: 'sess-factory', toolCall: { title: 'Edit src/app.ts', kind: 'edit', rawInput: { path: join(work2, 'src', 'app.ts') } }, options: permOpts }))
  check('S3 4 without runThrough the same ask still waits for the card', off.sent.length === 0 && off.events.some((e) => e.kind === 'permission'))
  const always = fakePool('factory', brainA, ctx)
  const alwaysOpts = [
    { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
  ]
  acp.handleReq(always.pool as never, req(44, 'session/request_permission', { sessionId: 'sess-factory', toolCall: { title: 'Edit src/app.ts', kind: 'edit', rawInput: { path: join(work2, 'src', 'app.ts') } }, options: alwaysOpts }))
  check('S3 4 runThrough never auto-selects allow_always; with no allow_once the card asks', always.sent.length === 0 && always.events.some((e) => e.kind === 'permission'), JSON.stringify(always.sent))
  check('S3 model stays gated: factory argv has no --always-approve, session/new no yoloMode', !gargs.grokFactoryAcpArgs(brainA, true).includes('--always-approve') && !JSON.stringify(acp.sessionNewParams('grok', brainA, 'factory')).includes('yoloMode'))
}

let pushCalls = 0
fakeDeps.publish = async () => {
  pushCalls++
  return { ok: false, out: 'push stub' }
}
let deployCalls = 0
fakeDeps.deploy = async () => {
  deployCalls++
  return { ok: true, out: '' }
}
ctl.configureFactory(fakeDeps)

// S3 2 + 9. runThrough T2: Opus plan written, build starts without approve-plan, clean review auto-commits, never pushes.
{
  promptPlan = async (o) => {
    if (/Phase: build\./.test(o.text)) {
      writeFileSync(join(work2, 'src', 'team.ts'), 'export const team = 1\n')
      writeFileSync(join(work2, 'src', 'routes.ts'), 'export const routes = ["team"]\n')
    }
  }
  claudeSays(['Plan: add src/team.ts and src/routes.ts, test with npm test.', 'GAPS: 0\nPASS'])
  const c0 = claudeRows().length
  const refs = git(bare, ['for-each-ref']).trim()
  const head0 = git(work2, ['rev-parse', 'HEAD']).trim()
  const res = ctl.startRun({ task: T2TASK, workRepo: work2, brainPath: brainA, runThrough: true })
  const id = res.ok ? res.run.id : ''
  check('S3 2 runThrough T2 start is stored on the run', res.ok && res.run.runThrough === true && res.run.tier === 'T2', JSON.stringify(res.ok ? { rt: res.run.runThrough, tier: res.run.tier } : res))
  const r = await ctl.settle(id)
  const seen = events.filter((e) => e.runId === id && e.kind === 'run').map((e) => e.run?.phase)
  check('S3 2 lands in plan, then reaches build with no approve-plan click', seen.includes('plan') && seen.indexOf('build') > seen.indexOf('plan') && r?.plan?.status === 'approved' && !!r.plan.approvedAt, JSON.stringify(seen))
  check('S3 2 plan sidecar exists under userData', existsSync(store.runTextPath(id, 'plan')) && readFileSync(store.runTextPath(id, 'plan'), 'utf8').startsWith('Plan: add src/team.ts'))
  const rows = claudeRows().slice(c0)
  check('S3 2 runThrough T2 plan is by Opus; the strict reviewer is a second, different claude process', r?.plan?.by === 'opus' && rows.length === 2 && rows[0].pid !== rows[1].pid && rows[1].argv[1].includes('strict-code-review/SKILL.md') && r.strict?.status === 'pass', JSON.stringify({ by: r?.plan?.by, pids: rows.map((x) => x.pid) }))
  check('S3 9 clean review auto-commits the work files', r?.phase === 'done' && !!r.commitSha && git(work2, ['rev-parse', 'HEAD']).trim() === r.commitSha && r.commitSha !== head0 && git(work2, ['show', '--name-only', '--format=', 'HEAD']).includes('src/team.ts'), JSON.stringify({ phase: r?.phase, error: r?.error, strict: r?.strict }))
  check('S3 9 auto-commit never pushes', pushCalls === 0 && git(bare, ['for-each-ref']).trim() === refs && !r?.pushed)
  check('S3 10 deploy is refused before Push and never called', ctl.deployBlockFor(id) === 'Deploy comes after Push.' && deployCalls === 0)
  check('S3 git status clean after auto-commit', git(work2, ['status', '--porcelain']).trim() === '')
}

// UX 7 + 8. Ship in advance: push only after reviewAccept's clean pass; protected branch, missing claude, and plain T0 never push.
{
  const APITASK = 'fix the API error message'
  let n = 0
  promptPlan = async (o) => {
    if (!/Role: self-check/.test(o.text)) writeFileSync(join(work2, 'src', 'app.ts'), `export const app = "API error ${++n}"\n`)
  }
  const publish0 = fakeDeps.publish
  fakeDeps.publish = async (r, t) => {
    pushCalls++
    return gates.publish(r, t)
  }
  ctl.configureFactory(fakeDeps)

  git(work2, ['checkout', '-q', '-b', 'factory/ship'])
  claudeSays(['Checked it.\nGAPS: 0\nPASS'])
  const push0 = pushCalls
  const res = ctl.startRun({ task: APITASK, workRepo: work2, brainPath: brainA, runThrough: false, shipThrough: true })
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  check('UX 7 shipThrough is stored on the run', res.ok && res.run.shipThrough === true && !res.run.runThrough)
  check(
    'UX 7 shipThrough + clean Opus pass: commit and push to the run branch, no deploy',
    r?.phase === 'done' && !!r.commitSha && r.pushed?.branch === 'factory/ship' && pushCalls === push0 + 1 && git(bare, ['rev-parse', 'refs/heads/factory/ship']).trim() === r.commitSha && deployCalls === 0 && !r.deployed,
    JSON.stringify({ phase: r?.phase, pushed: r?.pushed, err: r?.pushError, strict: r?.strict, error: r?.error })
  )
  git(work2, ['checkout', '-q', 'main'])

  claudeSays(['Checked it.\nGAPS: 0\nPASS'])
  const refs = git(bare, ['for-each-ref']).trim()
  const push1 = pushCalls
  const res2 = ctl.startRun({ task: APITASK, workRepo: work2, brainPath: brainA, shipThrough: true })
  const id2 = res2.ok ? res2.run.id : ''
  const r2 = await ctl.settle(id2)
  check(
    'UX 7 shipThrough on main: commit, pushError set, no push call, remote unchanged',
    r2?.phase === 'done' && !!r2.commitSha && !r2.pushed && /does not push to main/.test(r2.pushError || '') && pushCalls === push1 && git(bare, ['for-each-ref']).trim() === refs,
    JSON.stringify({ phase: r2?.phase, err: r2?.pushError })
  )

  execFileSync('/bin/rm', ['-f', claudeBin])
  const head2 = git(work2, ['rev-parse', 'HEAD']).trim()
  const res3 = ctl.startRun({ task: APITASK, workRepo: work2, brainPath: brainA, runThrough: true, shipThrough: true })
  const id3 = res3.ok ? res3.run.id : ''
  const r3 = await ctl.settle(id3)
  check('UX 7 missing claude: no auto-commit and no push, even with both boxes', r3?.phase === 'review' && r3.strict?.status === 'missing' && !r3.commitSha && git(work2, ['rev-parse', 'HEAD']).trim() === head2 && pushCalls === push1, JSON.stringify({ phase: r3?.phase, strict: r3?.strict }))
  ctl.abandonRun(id3)
  reset2()
  installClaude()

  const c0 = claudeRows().length
  const res4 = ctl.startRun({ task: 'fix typo in the app label', workRepo: work2, brainPath: brainA, shipThrough: true })
  const id4 = res4.ok ? res4.run.id : ''
  const r4 = await ctl.settle(id4)
  check('UX 7 plain T0 with only shipThrough: no Opus, waits on Commit, never pushes', res4.ok && res4.run.tier === 'T0' && r4?.phase === 'review' && !!r4.diff && !r4.commitSha && claudeRows().length === c0 && pushCalls === push1, JSON.stringify({ phase: r4?.phase, tier: r4?.tier }))
  ctl.abandonRun(id4)
  reset2()

  // UX 8 + 9: every review names a nit under PASS: never a pass; four auto fixes, held at 5, no commit, no push.
  const nit = 'Looks fine. One nit: rename x, a non-blocker.\nGAPS: 0\nPASS'
  claudeSays([nit, nit, nit, nit, nit])
  const head5 = git(work2, ['rev-parse', 'HEAD']).trim()
  const p5 = promptCount()
  const res5 = ctl.startRun({ task: APITASK, workRepo: work2, brainPath: brainA, runThrough: true, shipThrough: true })
  const id5 = res5.ok ? res5.run.id : ''
  let r5 = await ctl.settle(id5)
  check(
    'UX 8 PASS naming nits never auto-commits: held at 5 with both boxes on',
    r5?.phase === 'review' && !!r5.diff && r5.reviewCycles === 5 && r5.strict?.status === 'fail' && r5.strict.text.startsWith('PASS named gaps') && !r5.commitSha && git(work2, ['rev-parse', 'HEAD']).trim() === head5 && pushCalls === push1,
    JSON.stringify({ phase: r5?.phase, cycles: r5?.reviewCycles, strict: r5?.strict?.text.slice(0, 40), sha: r5?.commitSha })
  )
  check('UX 9 four auto fix turns before the hold', promptsFrom(p5).filter((t) => /Phase: fix\./.test(t)).length === 4)

  // UX 6: Guide on a held reject is Keep fixing with that note, then a fresh reviewer that never sees the note.
  claudeSays(['Checked it.\nGAPS: 0\nPASS'])
  const p6 = promptCount()
  const c6 = claudeRows().length
  ctl.guideRun(id5, 'Rename x to count in src/app.ts')
  r5 = await ctl.settle(id5)
  const g6 = promptsFrom(p6)
  const rev6 = claudeRows().slice(c6)
  check(
    'UX 6 guide on a held run: one fix turn with the note, then a fresh Opus review',
    g6.length === 1 && /Phase: fix\./.test(g6[0]) && g6[0].includes('Joe says: Rename x to count in src/app.ts') && rev6.length === 1 && !rev6[0].argv[1].includes('Rename x to count'),
    JSON.stringify({ turns: g6.length, spawns: rev6.length })
  )
  check('UX 6 guide note is on the run and marked sent', r5?.guide?.length === 1 && r5.guide[0].text === 'Rename x to count in src/app.ts' && r5.guide[0].sent === true)
  check('UX 9 clean pass after keep fixing is an Opus approval: runThrough + shipThrough commit, main refuses the push', r5?.phase === 'done' && !!r5.commitSha && /does not push to main/.test(r5.pushError || '') && pushCalls === push1, JSON.stringify({ phase: r5?.phase, err: r5?.pushError }))
  if (r5?.phase !== 'done') ctl.abandonRun(id5)
  fakeDeps.publish = publish0
  ctl.configureFactory(fakeDeps)
  reset2()
}

// UX 6. Guide while the plan waits: a fresh Opus plan with the note, still waiting, not a reject.
{
  promptPlan = async () => {}
  claudeSays(['Plan: small.', 'Plan: small, with the footer.'])
  const res = ctl.startRun({ task: T2TASK, workRepo: work2, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  await ctl.settle(id)
  const c0 = claudeRows().length
  const p0 = promptCount()
  ctl.guideRun(id, 'Also touch the footer')
  const r = await ctl.settle(id)
  const row = claudeRows()[c0]
  check(
    'UX 6 guide on a waiting plan: one new claude with the note and the earlier plan path, still waiting, no Grok turn',
    claudeRows().length === c0 + 1 && row.argv[1].includes('Also touch the footer') && row.argv[1].includes(store.runTextPath(id, 'plan')) && r?.phase === 'plan' && r.plan?.status === 'waiting' && r.plan.text === 'Plan: small, with the footer.' && r.plan.rejects === 0 && promptCount() === p0,
    JSON.stringify({ spawns: claudeRows().length - c0, phase: r?.phase, plan: r?.plan })
  )
  ctl.abandonRun(id)
  let threw = false
  try {
    ctl.guideRun(id, 'too late')
  } catch {
    threw = true
  }
  check('UX 6 guide on an abandoned run is refused', threw)
  reset2()
}

// UX 6. Guide while a turn is in flight: queued, then one follow-up turn with the note before verify.
{
  let release: () => void = () => {}
  let scriptsAtFollowUp = -1
  let turn = 0
  promptPlan = (o) => {
    turn++
    if (turn === 1)
      return new Promise<void>((r) => {
        release = () => {
          writeFileSync(join(work2, 'src', 'app.ts'), 'export const app = "label"\n')
          r()
        }
      })
    if (o.text.includes('Joe says:')) scriptsAtFollowUp = scriptRuns.length
    return Promise.resolve()
  }
  scriptRuns.length = 0
  const p0 = promptCount()
  const res = ctl.startRun({ task: 'fix typo in the app label', workRepo: work2, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  for (let i = 0; i < 100 && promptCount() === p0; i++) await new Promise((r) => setTimeout(r, 10))
  const queued = ctl.guideRun(id, 'Keep the label lowercase')
  check('UX 6 guide while busy is stored unsent, no new turn yet', queued.guide?.[0]?.sent !== true && promptCount() === p0 + 1)
  release()
  const r = await ctl.settle(id)
  const turns = promptsFrom(p0)
  check(
    'UX 6 queued note gets one follow-up build turn before verify',
    turns.length === 2 && /Phase: build\./.test(turns[1]) && turns[1].includes('Joe says: Keep the label lowercase') && scriptsAtFollowUp === 0 && scriptRuns.length > 0 && r?.phase === 'review' && r.guide?.[0]?.sent === true,
    JSON.stringify({ turns: turns.length, scriptsAtFollowUp, phase: r?.phase })
  )
  ctl.abandonRun(id)
  reset2()
}

// S3 3. runThrough false T2: still waits in plan until Approve.
{
  promptPlan = async () => {}
  claudeSays(['Plan: small.'])
  const p0 = promptCount()
  const res = ctl.startRun({ task: T2TASK, workRepo: work2, brainPath: brainA, runThrough: false })
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  check('S3 3 runThrough false T2 waits on the Opus plan, no Grok turn', r?.phase === 'plan' && r.plan?.status === 'waiting' && r.plan.by === 'opus' && r.plan.text === 'Plan: small.' && promptsFrom(p0).length === 0 && !r.runThrough, JSON.stringify({ phase: r?.phase, plan: r?.plan?.status }))
  ctl.abandonRun(id)
  reset2()
}

// S3 5 + 8 + 11. T3, two disjoint slices: two worker tabs in parallel, verify with e2e:full and an artifact, Opus high.
const T3TASK = 'Rewrite the whole app in Svelte'
const order: string[] = []
type SliceSpec = { title: string; files: string[] }[]
// The T3 plan comes from the fake claude (Opus), then any reviewer verdicts.
const t3Says = (slices: SliceSpec, ...after: string[]) => claudeSays([`Plan: split it.\n${JSON.stringify({ slices })}`, ...after])
const t3Build = async (o: { text: string; tabId?: string }) => {
  if (/Phase: build\./.test(o.text)) {
    const m = /Your slice (\d+) of \d+: [^.]+\. Edit only these files; other builders own the rest: (.+)/.exec(o.text)
    order.push(`start:${o.tabId}`)
    await new Promise((r) => setTimeout(r, 30))
    for (const rel of (m?.[2] || '').split(', ').map((x) => x.trim()).filter(Boolean)) {
      writeFileSync(join(work2, rel), `export const v = ${JSON.stringify(o.tabId)} // ${rel}\n`)
    }
    order.push(`end:${o.tabId}`)
  }
}
{
  const slices = [
    { title: 'api', files: ['src/api.ts'] },
    { title: 'ui', files: ['src/ui.ts'] }
  ]
  promptPlan = t3Build
  order.length = 0
  t3Says(slices, 'GAPS: 0\nPASS')
  scriptRuns.length = 0
  const e0 = effortCount()
  const c0 = claudeRows().length
  const p0 = promptCount()
  const push0 = pushCalls
  const res = ctl.startRun({ task: T3TASK, workRepo: work2, brainPath: brainA, runThrough: true })
  check('S3 5 T3 start keeps T3 (asTier)', res.ok && res.run.tier === 'T3', JSON.stringify(res.ok ? res.run.tier : res))
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  const builds = calls.filter((c) => c.fn === 'prompt').slice(p0).filter((c) => /Phase: build\./.test(String(c.o?.text)))
  const tabs = builds.map((c) => String(c.o?.tabId))
  const plans = promptsFrom(p0).filter((t) => /Phase: plan\./.test(t))
  const planner = claudeRows().slice(c0)[0]
  check('S3 5 T3 plan is Opus (claude) asking for slices JSON; no Grok plan turn; builders at Grok xhigh', plans.length === 0 && !!planner && planner.argv[1].includes('{"slices":') && planner.argv[1].includes('Limit T3') && r?.plan?.by === 'opus' && effortsFrom(e0).length > 0 && effortsFrom(e0).every((e) => e === 'xhigh'), JSON.stringify(effortsFrom(e0)))
  check('S3 5 slices parsed onto the run', r?.slices?.length === 2 && r.slices[0].files[0] === 'src/api.ts', JSON.stringify(r?.slices))
  check('S3 5 two worker tabIds factory-<id>-w1 and -w2', tabs.length === 2 && tabs.includes(`factory-${id}-w1`) && tabs.includes(`factory-${id}-w2`), JSON.stringify(tabs))
  check('S3 5 disjoint slices run in parallel (both start before either ends)', order.indexOf(`end:factory-${id}-w1`) > order.indexOf(`start:factory-${id}-w2`) && order.indexOf(`end:factory-${id}-w2`) > order.indexOf(`start:factory-${id}-w1`), JSON.stringify(order))
  check('S3 5 both slices wrote their file', r?.audit?.work.some((w) => w.path === 'src/api.ts') === true && r?.audit?.work.some((w) => w.path === 'src/ui.ts') === true, JSON.stringify(r?.audit))
  check('S3 5 worker tabs are closed after the build', [`factory-${id}-w1`, `factory-${id}-w2`].every((t) => calls.some((c) => c.fn === 'close' && c.o?.tabId === t)))
  check('S3 6 verify T3 runs typecheck, test, the profile e2e, and an e2e:full row', scriptRuns.join(',') === 'typecheck,test,test:e2e' && r?.verify?.map((v) => v.script).join(',') === 'typecheck,test,test:e2e,e2e:full' && r.verify.at(-1)?.status === 'skipped', JSON.stringify({ scripts: scriptRuns, verify: r?.verify }))
  const art = store.runTextPath(id, 'verify')
  check('S3 8 verify artifact <id>.verify.txt under userData', r?.verifyArtifact === art && art.endsWith(`${id}.verify.txt`) && underPath(realish(userData), realish(art)) && readFileSync(art, 'utf8').includes('npm run typecheck: pass'), String(r?.verifyArtifact))
  const review = claudeRows().slice(c0)[1]
  check('S3 11 T3 planner and reviewer are different claude processes', !!review && review.pid !== planner?.pid && review.argv[1].includes('strict-code-review/SKILL.md'))
  check('S3 11 T3 Opus review argv has --effort medium, plan mode', !!review && review.argv[review.argv.indexOf('--effort') + 1] === 'medium' && review.argv[review.argv.indexOf('--permission-mode') + 1] === 'plan', JSON.stringify(review?.argv.filter((a) => a.length < 40)))
  check('S3 5 T3 runThrough reaches done with a commit, not pushed', r?.phase === 'done' && !!r.commitSha && !r.pushed && pushCalls === push0, JSON.stringify({ phase: r?.phase, error: r?.error, strict: r?.strict }))
  check('S3 8 work repo git status is clean of the artifact', git(work2, ['status', '--porcelain', '--ignored']).trim() === '' && !existsSync(join(work2, `${id}.verify.txt`)))
}

// S3 6. Overlapping slices go sequential.
{
  const slices = [
    { title: 'one', files: ['src/shared.ts'] },
    { title: 'two', files: ['src/shared.ts', 'src/extra.ts'] }
  ]
  promptPlan = t3Build
  order.length = 0
  t3Says(slices, 'GAPS: 0\nPASS')
  const res = ctl.startRun({ task: T3TASK, workRepo: work2, brainPath: brainA, runThrough: true })
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  const w1 = `factory-${id}-w1`
  const w2 = `factory-${id}-w2`
  check('S3 6 overlapping slices: the second prompt starts after the first settles', order.join(',') === [`start:${w1}`, `end:${w1}`, `start:${w2}`, `end:${w2}`].join(','), JSON.stringify(order))
  check('S3 6 overlapping run still finishes', r?.phase === 'done', JSON.stringify({ phase: r?.phase, error: r?.error }))
}

// UX fix 1. T3 two slices waiting in review: a guide note is one builder fix turn on the run tab, never the slice workers again.
{
  const slices = [
    { title: 'api', files: ['src/api.ts'] },
    { title: 'ui', files: ['src/ui.ts'] }
  ]
  promptPlan = t3Build
  order.length = 0
  t3Says(slices, 'GAPS: 0\nPASS', 'GAPS: 0\nPASS')
  const res = ctl.startRun({ task: T3TASK, workRepo: work2, brainPath: brainA, runThrough: false })
  const id = res.ok ? res.run.id : ''
  await ctl.settle(id)
  ctl.decideRun(id, 'approve-plan')
  const r0 = await ctl.settle(id)
  const p0 = promptCount()
  ctl.guideRun(id, 'Name the api export count')
  const r = await ctl.settle(id)
  const extra = calls.filter((c) => c.fn === 'prompt').slice(p0)
  check(
    'UX fix 1 T3 guide in review: one builder fix turn with the note on the run tab, no worker tabs',
    r0?.phase === 'review' && !!r0.diff && extra.length === 1 && extra[0].o?.tabId === `factory-${id}` && /Phase: fix\./.test(String(extra[0].o?.text)) && String(extra[0].o?.text).includes('Joe says: Name the api export count') && r?.phase === 'review' && !!r.diff,
    JSON.stringify({ r0: r0?.phase, n: extra.length, tabs: extra.map((c) => c.o?.tabId), phase: r?.phase, error: r?.error })
  )
  ctl.abandonRun(id)
  reset2()
}

// S3 5b. T3 disjoint slices, builder 2's prompt fails: builder 1 is cancelled and closed, the run fails.
{
  const slices = [
    { title: 'api', files: ['src/api.ts'] },
    { title: 'ui', files: ['src/ui.ts'] }
  ]
  t3Says(slices)
  // w2 fails at once; w1 is still mid-prompt and must see its cancel before it finishes.
  let cancelledMidPrompt = false
  promptPlan = async (o) => {
    if (!/Phase: build\./.test(o.text)) return
    if (String(o.tabId).endsWith('-w2')) throw new Error('builder 2 broke')
    await new Promise((r) => setTimeout(r, 30))
    cancelledMidPrompt = calls.some((c) => c.fn === 'cancel' && c.o?.tabId === o.tabId)
    return t3Build(o)
  }
  order.length = 0
  const c0 = calls.length
  const res = ctl.startRun({ task: T3TASK, workRepo: work2, brainPath: brainA, runThrough: true })
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  const w1 = `factory-${id}-w1`
  const after = calls.slice(c0)
  const cancelAt = after.findIndex((c) => c.fn === 'cancel' && c.o?.tabId === w1)
  check('S3 5b one builder fails: the run is failed with its error', r?.phase === 'failed' && /builder 2 broke/.test(r.error || ''), JSON.stringify({ phase: r?.phase, error: r?.error }))
  check('S3 5b the other builder is cancelled and its tab closed', cancelAt >= 0 && after.some((c, i) => i > cancelAt && c.fn === 'close' && c.o?.tabId === w1), JSON.stringify(after.filter((c) => c.fn === 'cancel' || c.fn === 'close')))
  check('S3 5b the cancel reaches builder 1 while its prompt is still running', cancelledMidPrompt)
  check('S3 5b no review or commit after the failed wave', !r?.commitSha && !r?.verify?.length, JSON.stringify({ sha: r?.commitSha, verify: r?.verify }))
  ctl.abandonRun(id)
  reset2()
}

// S3 7. Tripwire: T2 over T2 suggests T3; over T3 null; lockfile null; runThrough auto-upgrades T1 -> T2; a lockfile still stops.
{
  const rows = (n: number, lines = 1) => Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, added: lines, deleted: 0 }))
  check('S3 7 T2 with 11 files suggests T3', tripwire.checkTripwire('T2', rows(11)).suggest === 'T3')
  check('S3 7 T2 over T3 limits suggests null', tripwire.checkTripwire('T2', rows(41)).suggest === null && tripwire.checkTripwire('T2', rows(11, 300)).suggest === null)
  check('S3 7 lockfile suggests null', tripwire.checkTripwire('T2', [...rows(11), { path: 'package-lock.json', added: 1, deleted: 0 }]).suggest === null)
  promptPlan = async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(work2, 'src', `${n}.ts`), Array.from({ length: 40 }, (_, i) => `export const ${n}${i} = ${i}`).join('\n') + '\n')
  }
  claudeSays(['GAPS: 0\nPASS'])
  const res = ctl.startRun({ task: 'Fix the date shown one day off in the order list', workRepo: work2, brainPath: brainA, runThrough: true })
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  check('S3 7 runThrough auto-upgrades a T1 -> T2 suggest and goes on to done', res.ok && res.run.tier === 'T1' && r?.tier === 'T2' && r.tripwire?.auto === true && r.tripwire.suggest === 'T2' && r.phase === 'done', JSON.stringify({ tier: r?.tier, trip: r?.tripwire, phase: r?.phase, error: r?.error }))
  promptPlan = async () => {
    writeFileSync(join(work2, 'src', 'app.ts'), 'export const app = 42\n')
    writeFileSync(join(work2, 'package-lock.json'), '{}\n')
  }
  const res2 = ctl.startRun({ task: 'Fix the date shown one day off in the order list', workRepo: work2, brainPath: brainA, runThrough: true })
  const id2 = res2.ok ? res2.run.id : ''
  const r2 = await ctl.settle(id2)
  check('S3 7 runThrough with a lockfile change still stops on the card', r2?.phase === 'upgrade' && r2.tripwire?.suggest === null && !r2.tripwire.auto && !r2.commitSha, JSON.stringify({ phase: r2?.phase, trip: r2?.tripwire }))
  ctl.abandonRun(id2)
  reset2()
}

// S3 9. runThrough with voice REJECT does not auto-commit.
{
  profiles.saveProfile(work2, { voice: { on: true } })
  voiceCode = 2
  promptPlan = async () => {
    writeFileSync(join(work2, 'README.md'), 'Hello there\nBest sites ever, buy now!\n')
  }
  const head0 = git(work2, ['rev-parse', 'HEAD']).trim()
  const res = ctl.startRun({ task: 'fix typo in README.md', workRepo: work2, brainPath: brainA, runThrough: true })
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  check('S3 9 runThrough voice REJECT waits in review, no commit', r?.phase === 'review' && r.voice?.status === 'fail' && !r.commitSha && git(work2, ['rev-parse', 'HEAD']).trim() === head0, JSON.stringify({ phase: r?.phase, voice: r?.voice }))
  ctl.abandonRun(id)
  reset2()
  voiceCode = 0
  profiles.saveProfile(work2, { voice: { on: false } })
}

// S3 10. Deploy cmd lives in the userData profile only; runs never copy it; no cmd refuses.
{
  const secretish = 'echo fixture-deploy-cmd-not-a-secret'
  profiles.saveProfile(work2, { deploy: { cmd: secretish } })
  check('S3 10 profile keeps the deploy cmd in userData', profiles.readProfile(work2).deploy?.cmd === secretish && git(work2, ['status', '--porcelain']).trim() === '')
  promptPlan = async () => {
    writeFileSync(join(work2, 'src', 'app.ts'), 'export const app = 77\n')
  }
  const res = ctl.startRun({ task: 'fix typo in the app label', workRepo: work2, brainPath: brainA, runThrough: true })
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  check('S3 10 the run record never carries the deploy cmd', !!r && !JSON.stringify(r).includes(secretish) && !readFileSync(join(store.factoryDir(), 'runs', `${id}.json`), 'utf8').includes(secretish))
  check('S3 10 deployRun before Push refuses', await ctl.deployRun(id).then(() => false, (e) => /after Push/.test(String(e))))
  profiles.saveProfile(work2, { deploy: { cmd: '' } })
  check('S3 10 cleared deploy cmd is gone', !profiles.readProfile(work2).deploy)
  check('S3 10 deploy stub never ran', deployCalls === 0)
}

// S3 10b. The Deploy click gets the verify env: project bins on PATH, the Factory shim dir stripped.
{
  git(work2, ['checkout', '-q', '-b', 'factory/deploy'])
  const projBin = join(work2, 'node_modules', '.bin')
  const shimDir = gates.ensureShims(store.factoryShimDir())
  const env0 = fakeDeps.env
  const publish0 = fakeDeps.publish
  const deploy0 = fakeDeps.deploy
  const spawned: { bin: string; path: string }[] = []
  fakeDeps.env = () => gates.factoryEnv({ ...process.env, PATH: `${projBin}:${process.env.PATH}` }, shimDir)
  fakeDeps.publish = async () => ({ ok: true, out: '' })
  fakeDeps.deploy = (r, c, o) =>
    gates.deploy(r, c, {
      ...o,
      spawnFn: ((bin: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        spawned.push({ bin, path: String(opts.env.PATH) })
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = () => true
        setTimeout(() => child.emit('close', 0), 5)
        return child
      }) as never
    })
  ctl.configureFactory(fakeDeps)
  profiles.saveProfile(work2, { deploy: { cmd: 'echo fixture-deploy' } })
  promptPlan = async () => {
    writeFileSync(join(work2, 'src', 'app.ts'), 'export const app = 88\n')
  }
  claudeSays(['GAPS: 0\nPASS'])
  const res = ctl.startRun({ task: 'fix typo in the app label', workRepo: work2, brainPath: brainA, runThrough: true })
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  const pushed = r?.phase === 'done' ? await ctl.publishRun(id) : r
  const dep = pushed?.pushed ? await ctl.deployRun(id) : pushed
  const path = (spawned[0]?.path || '').split(':')
  check('S3 10b deploy ran once after Push', !!dep?.deployed && spawned.length === 1 && spawned[0].bin === '/bin/sh', JSON.stringify({ phase: r?.phase, pushed: pushed?.pushed, err: dep?.deployError, spawned: spawned.length }))
  check('S3 10b deploy PATH has the project bins and no Factory shim dir', path.includes(projBin) && !path.includes(shimDir) && !path.some((d) => /[\\/]factory[\\/]bin$/.test(d)), spawned[0]?.path)
  profiles.saveProfile(work2, { deploy: { cmd: '' } })
  fakeDeps.env = env0
  fakeDeps.publish = publish0
  fakeDeps.deploy = deploy0
  ctl.configureFactory(fakeDeps)
  git(work2, ['checkout', '-q', 'main'])
  reset2()
}

// S3 13. Work repo resolves from the task or the last Factory repo; never the brain; else the name-the-repo error.
{
  fakeDeps.projectsDir = temp
  ctl.configureFactory(fakeDeps)
  promptPlan = async () => {}
  const lastOk = ctl.startRun({ task: 'fix the label', brainPath: brainA, runThrough: false })
  check('S3 13 start with only { task, brainPath, runThrough } uses lastRepo', lastOk.ok && realish(lastOk.run.workRepo) === realish(work2), JSON.stringify(lastOk.ok ? lastOk.run.workRepo : lastOk))
  if (lastOk.ok) ctl.abandonRun(lastOk.run.id)
  const byPath = ctl.startRun({ task: `fix the typo in ${join(work, 'src', 'footer.ts')}`, brainPath: brainA, runThrough: false })
  check('S3 13 a path in the task resolves to its git top', byPath.ok && realish(byPath.run.workRepo) === realish(work), JSON.stringify(byPath.ok ? byPath.run.workRepo : byPath))
  if (byPath.ok) ctl.abandonRun(byPath.run.id)
  check('S3 13 Start remembers the resolved repo', realish(resolver.lastRepo()) === realish(work))
  const byName = ctl.startRun({ task: 'fix typo in work2 readme', brainPath: brainA, runThrough: false })
  check('S3 13 a Projects folder name in the task resolves', byName.ok && realish(byName.run.workRepo) === realish(work2), JSON.stringify(byName.ok ? byName.run.workRepo : byName))
  if (byName.ok) ctl.abandonRun(byName.run.id)
  const brainOnly = ctl.startRun({ task: `edit ${join(brainA, 'AGENTS.md')}`, brainPath: brainA, runThrough: false })
  check('S3 13 a task that names only the brain is refused (no lastRepo fallback)', !brainOnly.ok && brainOnly.error === resolver.BRAIN_IS_WORK && store.activeRunFor(brainA) === null, JSON.stringify(brainOnly))
  if (brainOnly.ok) ctl.abandonRun(brainOnly.run.id)
  const explicitBrain = ctl.startRun({ task: 'fix typo', workRepo: brainA, brainPath: brainA })
  check('S3 13 the brain as the work repo is refused', !explicitBrain.ok && /brain itself/.test(explicitBrain.error))
  execFileSync('/bin/rm', ['-f', join(store.factoryDir(), 'prefs.json')])
  const none = ctl.startRun({ task: 'fix typo in footer', brainPath: brainA, runThrough: true })
  check('S3 13 nothing named and no lastRepo gives the name-the-repo error', !none.ok && none.error === resolver.NAME_THE_REPO, JSON.stringify(none))
  fakeDeps.projectsDir = undefined
  fakeDeps.publish = undefined
  fakeDeps.deploy = undefined
  ctl.configureFactory(fakeDeps)
  reset2()
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
if (argv[0] === '-p') {
  process.stdout.write(JSON.stringify({ type: 'text', data: '{"size":"T0","risk":"none","reason":"one word"}' }) + '\\n')
  process.exit(0)
} else if (argv[0] === 'agent' && argv[1] === 'leader') {
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
      const text = (m.params.prompt || []).map((p) => p.text || '').join('\\n')
      const pick = JSON.parse(fs.readFileSync(process.env.FAKE_GROK_PLAN, 'utf8')).find((e) => new RegExp(e.match).test(text))
      for (const s of pick ? pick.steps : []) {
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
      {
        match: 'Phase: build\\.',
        steps: [
          { write: footer, content: 'export const footer = "Copyright 2026!"\n' },
          { write: join(brainA, 'AGENTS.md'), content: 'hijacked\n' },
          { native: join(brainA, 'AGENTS.md'), content: '# Brain A rules\nnative tool write\n' },
          { perm: { title: 'Run git push origin main', kind: 'execute', rawInput: { command: 'git push origin main' } } },
          { perm: { title: 'Run npm run typecheck', kind: 'execute', rawInput: { command: 'npm run typecheck' } } },
          { say: 'Fixed the typo.' }
        ]
      }
    ])
  )
  const streamed: { kind: string; ev?: { kind: string; requestId?: string } }[] = []
  let decided = ''
  ctl.configureFactory({
    driver: {
      warm: (o) => acp.factoryWarm(o),
      prompt: (o) => acp.factoryPrompt(o),
      cancel: (t) => void acp.factoryCancel(t),
      close: (t) => acp.factoryClose(t),
      setEffort: (t, effort) => acp.factorySetEffort(t, effort)
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
  const triageRun = lines.find((l) => Array.isArray(l.argv) && (l.argv as string[])[0] === '-p') as { argv: string[]; path0: string; anthropic: boolean } | undefined
  check('S2 2 e2e triage one-shot: grok -p, --effort low, no --always-approve, shims first, no key', !!triageRun && triageRun.argv[triageRun.argv.indexOf('--effort') + 1] === 'low' && !triageRun.argv.includes('--always-approve') && triageRun.path0 === store.factoryShimDir() && !triageRun.anthropic, JSON.stringify(triageRun?.argv?.filter((a) => a.length < 40)))
  check('S2 2 e2e model triage kept T0 (raise-only)', end?.tier === 'T0' && end.triage.llm?.size === 'T0')
  // T2 through the real lane: the plan is the fake claude (Opus), never a Grok plan turn; nothing written.
  claudeSays(['Plan: 1. add src/team.ts 2. test it.'])
  const grokPrompts0 = lines.filter((l) => l.method === 'session/prompt').length
  const t2 = ctl.startRun({ task: 'Add a new page for team settings with a new route and shared types', workRepo: work, brainPath: brainA })
  const t2id = t2.ok ? t2.run.id : ''
  const t2end = await ctl.settle(t2id)
  const lines2 = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  const grokPrompts = lines2.filter((l) => l.method === 'session/prompt')
  check('S2 3 e2e T2 waits with the Opus plan text', t2end?.phase === 'plan' && t2end.plan?.by === 'opus' && t2end.plan.text.startsWith('Plan: 1.') === true, JSON.stringify({ phase: t2end?.phase, plan: t2end?.plan, error: t2end?.error }))
  check('S2 3 e2e no Grok session/prompt for the plan', grokPrompts.length === grokPrompts0 && !grokPrompts.some((l) => /Phase: plan\./.test(JSON.stringify(l.params))), String(grokPrompts.length - grokPrompts0))
  check('S2 3 e2e plan wrote nothing in the work repo', git(work, ['status', '--porcelain']).trim() === '')
  ctl.abandonRun(t2id)
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
