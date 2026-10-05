import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
export const clipboard = {}, dialog = {}, ipcMain = { handle(name, fn) { (globalThis.__fipc ||= new Map()).set(name, fn) }, on() {} }, Menu = {}, nativeImage = {}, shell = {}, Tray = class {}
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
// No live Jev: the key is gone and any typesafe.ai fetch is recorded and refused (NO_LIVE_JEV at the end).
delete process.env.TYPESAFE_API_KEY
const liveJev: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = String(input instanceof Request ? input.url : input)
  if (/typesafe\.ai/.test(url)) {
    liveJev.push(url)
    throw new Error('live Jev refused in checks')
  }
  return realFetch(input, init)
}) as typeof fetch
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
const conductor = (await import(src('factory/conductor.ts'))) as typeof import('../src/main/factory/conductor.ts')
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
const fallback = (await import(src('factory/fallback.ts'))) as typeof import('../src/main/factory/fallback.ts')
const shared = (await import(pathToFileURL(join(rootRepo, 'src', 'shared', 'factory.ts')).href)) as typeof import('../src/shared/factory.ts')
store.setUserDataDir(() => userData)

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })

type Sent = { id: number | string; result?: unknown; error?: { code: number; message: string } }
type Ev = { kind: string; title?: string; path?: string; data?: string; options?: { id: string; label: string }[] }
function fakePool(lane: 'chat' | 'factory', cwd: string, factory?: { brainPath: string; workRepo: string; runThrough?: boolean; watchOnly?: boolean }) {
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

// FB 1-3: Factory Cursor (the grunt when Grok cannot run) is not Chat Cursor.
{
  let argv: string[] = []
  let threw = ''
  try {
    argv = await acp.spawnArgs('cursor', brainA, 'factory', work)
  } catch (e) {
    threw = String((e as Error).message || e)
  }
  const at = (flag: string) => argv[argv.indexOf(flag) + 1]
  check(
    'FB 1 spawnArgs cursor factory: --trust, --workspace brain, --add-dir work repo, acp; no --always-approve, no --sandbox disabled, no home add-dir',
    !threw && argv.includes('--trust') && at('--workspace') === brainA && at('--add-dir') === work && argv.at(-1) === 'acp' && !argv.includes('--always-approve') && !argv.includes('--sandbox') && !argv.includes('disabled') && !argv.includes(home) && !argv.includes(realHome) && argv.filter((a) => a === '--add-dir').length === 1,
    threw || JSON.stringify(argv)
  )
  const same = await acp.spawnArgs('cursor', brainA, 'factory', brainA)
  check('FB 1 no --add-dir when the work repo is the brain', !same.includes('--add-dir'), JSON.stringify(same))
  check('FB 1 factory cursor pool key is its own', acp.poolKey('cursor', brainA, 'factory') === 'factory:cursor:' + brainA)
  check('FB 1 factory cursor session/new sends no Grok-only _meta (no yoloMode, no rules)', JSON.stringify(acp.sessionNewParams('cursor', brainA, 'factory')) === JSON.stringify({ cwd: brainA, mcpServers: [] }))

  const g = fallback.grokUsageBlocked
  check(
    'FB 2 grokUsageBlocked: true for a weekly-usage error and 100% credits; false for cancelled and a write-block sentence',
    g(new Error('You have hit your weekly usage limit for Grok. It resets Monday.')) && g({ creditUsagePercent: 100 }) && !g(new Error('cancelled')) && !g(new Error(gates.BRAIN_WRITE_REFUSAL)) && !g(new Error(gates.OTHER_REPO_WRITE_REFUSAL))
  )

  const reqs: { method: string; params: Record<string, unknown> }[] = []
  const tab = {
    tabId: 'factory-fb3',
    sessionId: 'cur-sess-fb3',
    promptId: null,
    appTools: [],
    text: '',
    alwaysApprove: false,
    model: 'composer-2.5[fast=true]',
    models: [
      { id: 'composer-2.5[fast=true]', label: 'Composer 2.5' },
      { id: 'cursor-grok-4.7[effort=high]', label: 'Cursor Grok 4.7' }
    ],
    factory: { brainPath: brainB, workRepo: work }
  }
  const pool = {
    kind: 'cursor' as const,
    lane: 'factory' as const,
    cwd: brainB,
    boot: Promise.resolve(),
    tabs: new Map([[tab.tabId, tab]]),
    bySid: new Map([[tab.sessionId, tab.tabId]]),
    rpc: {
      dead: false,
      request: async (method: string, params: Record<string, unknown>) => {
        reqs.push({ method, params })
        return {}
      },
      notify: () => {},
      kill: () => {}
    }
  }
  acp.registerPoolForCheck(pool as never)
  let err = ''
  try {
    await acp.factorySetEffort(tab.tabId, 'xhigh')
    await acp.factorySetEffort(tab.tabId, 'high')
  } catch (e) {
    err = String((e as Error).message || e)
  }
  const models = reqs.map((r) => String(r.params.value || r.params.modelId || ''))
  check(
    'FB 3 Factory Cursor factorySetEffort extra high does not throw and pins Cursor Grok extra high (high too)',
    !err && models[0] === 'cursor-grok-4.7[effort=xhigh]' && tab.model === 'cursor-grok-4.7[effort=xhigh]' && !reqs.some((r) => r.params.configId === 'reasoning_effort'),
    err || JSON.stringify(reqs)
  )
  acp.factoryClose(tab.tabId)
}

// IN 1: Factory files live on the right In use rail, not as cards in the Factory body.
{
  const pane = readFileSync(join(rootRepo, 'src', 'renderer', 'src', 'FactoryPane.tsx'), 'utf8')
  const ws = readFileSync(join(rootRepo, 'src', 'renderer', 'src', 'TerminalWorkspace.tsx'), 'utf8')
  const at = ws.indexOf('<FactoryPane')
  const tag = at < 0 ? '' : ws.slice(at, ws.indexOf('/>', ws.indexOf('onRun=', at)) + 2)
  check(
    'IN 1 FactoryPane has no factory-files cards; TerminalWorkspace passes onFiles to the Factory tab; In use reads the Factory tab id',
    !pane.includes('factory-files') && /onFilesRef\.current\(id, files\)/.test(pane) && /onFilesRef\.current\(id, \[\]\)/.test(pane) && /onFiles=\{onFiles\}/.test(tag) && /tab\?\.type === 'factory' \? tab\.id : chatId/.test(ws) && ws.includes('Nothing for this run yet.') && ws.includes('Nothing for this chat yet.'),
    tag.slice(0, 200)
  )
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
  const watch = fakePool('factory', brainA, { brainPath: brainA, workRepo: work, runThrough: true, watchOnly: true })
  acp.handleReq(watch.pool as never, req(12, 'session/request_permission', { sessionId: 'sess-factory', toolCall: { title: 'Read src/footer.ts', kind: 'read', rawInput: { path: join(work, 'src', 'footer.ts') } }, options: permOpts }))
  check('9 orch read is allow_once and does not open a card', outcome(watch.sent[0])?.optionId === 'allow_once' && !watch.events.some((e) => e.kind === 'permission'), JSON.stringify({ sent: watch.sent, events: watch.events }))
  const watchEdit = fakePool('factory', brainA, { brainPath: brainA, workRepo: work, runThrough: true, watchOnly: true })
  acp.handleReq(watchEdit.pool as never, req(13, 'session/request_permission', { sessionId: 'sess-factory', toolCall: { title: 'Edit src/footer.ts', kind: 'edit', rawInput: { path: join(work, 'src', 'footer.ts') } }, options: permOpts }))
  check('9 orch edit is reject_once even with approve in advance', outcome(watchEdit.sent[0])?.optionId === 'reject_once', JSON.stringify(watchEdit.sent))
  const watchWrite = fakePool('factory', brainA, { brainPath: brainA, workRepo: work, watchOnly: true })
  const orchTarget = join(work, 'src', 'orch-write.ts')
  acp.handleReq(watchWrite.pool as never, req(14, 'fs/write_text_file', { sessionId: 'sess-factory', path: orchTarget, content: 'export const x = 1\n' }))
  check('9 orch write to the work repo is refused', watchWrite.sent[0]?.error?.message === gates.WATCH_WRITE_REFUSAL && !existsSync(orchTarget), JSON.stringify(watchWrite.sent))
  check(
    '9 orch cursor brief is not the builder rules',
    acp.factoryPromptText('factory-1-orch', 'cursor', 'hi') === 'hi' && acp.factoryPromptText('factory-1', 'cursor', 'hi').startsWith('You are a Factory builder') && acp.factoryPromptText('factory-1', 'grok', 'hi') === 'hi'
  )
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
// A missed T0/T1 model answer holds. This echo agrees with the rules line so older checks still build.
const echoGrok = join(temp, 'echo-grok')
writeFileSync(
  echoGrok,
  `#!/usr/bin/env node
const i = process.argv.indexOf('-p')
const prompt = i >= 0 ? String(process.argv[i + 1] || '') : ''
const m = /Rules said: (T[0-3]) \\((none|elevated|critical)\\)/.exec(prompt)
const size = m ? m[1] : 'T1'
const risk = m ? m[2] : 'none'
process.stdout.write(JSON.stringify({ type: 'text', data: JSON.stringify({ size, risk, reason: 'agrees' }) }) + '\\n')
`
)
chmodSync(echoGrok, 0o755)
triageBin = echoGrok
const restoreEcho = () => {
  triageBin = echoGrok
}
const scriptRuns: string[] = []
type VoiceCall = { bin: string; args: string[]; body: string }
const voiceCalls: VoiceCall[] = []
let voiceCode = 0
let voiceText = ''
/** Scripted voice answers, one per call, before voiceCode/voiceText take over. */
const voiceSays: { code: number; out: string }[] = []
// A hung prompt settles when its tab is cancelled, like an ACP session/cancel.
const pendingPrompts = new Map<string, () => void>()
const fakeDeps: Parameters<typeof ctl.configureFactory>[0] = {
  driver: {
    warm: async (o) => {
      calls.push({ fn: 'warm', o })
      return { sessionId: o.resumeId || 'grok-sess-' + calls.length }
    },
    prompt: async (o) => {
      calls.push({ fn: 'prompt', o: { text: o.text, tabId: o.tabId } })
      let settle: () => void = () => {}
      const cancelled = new Promise<'cancelled'>((r) => (settle = () => r('cancelled')))
      pendingPrompts.set(o.tabId, settle)
      try {
        const out = await Promise.race([promptPlan(o), cancelled])
        return typeof out === 'string' && out !== 'cancelled' ? out : ''
      } finally {
        // The follow-up prompt on this tab may already be waiting: only drop our own entry.
        if (pendingPrompts.get(o.tabId) === settle) pendingPrompts.delete(o.tabId)
      }
    },
    cancel: (tabId) => {
      calls.push({ fn: 'cancel', o: { tabId, mid: pendingPrompts.has(tabId) } })
      pendingPrompts.get(tabId)?.()
    },
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
    const said = voiceSays.shift()
    const code = said ? said.code : voiceCode
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(said ? said.out : voiceText || (voiceCode === 0 ? 'APPROVE\n' : 'REJECT: reads like an ad\n')))
      child.emit('close', code)
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
  check('brief is at most 2,000 characters and carries role, tier, phase, work repo', briefs.every((b) => b.length <= BRIEF_MAX && /Role: /.test(b) && /Tier: T[012]/.test(b) && /Phase: /.test(b) && b.includes(work)))
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
  const tn = turns()
  const noted = ctl.guideRun(lid, 'Keep the footer short')
  check(
    'ACK 2 Guide while waiting on dirty prep stores "Just noted." and starts nothing',
    noted.needsPrep === 'dirty' && noted.guide?.at(-1)?.ack === 'Just noted.' && noted.guide.at(-1)?.sent !== true && turns() === tn && store.loadRun(lid)?.guide?.at(-1)?.ack === shared.ACK_NOTED,
    JSON.stringify({ prep: noted.needsPrep, guide: noted.guide })
  )
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
const json = process.argv[process.argv.indexOf('--output-format') + 1] === 'json'
const envelope = (text) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0.0123, usage: { input_tokens: 111, output_tokens: 22, cache_read_input_tokens: 3333, cache_creation_input_tokens: 444 }, modelUsage: { 'claude-fake-served': { costUSD: 0.0123 } } })
const say = (text) => process.stdout.write(json ? envelope(text) : text + '\\n')
// The Opus builder (bypassPermissions) never takes a planner or reviewer line from the queue.
// Each turn appends a new comment so a long review loop does not pause on an unchanged diff.
if (process.argv.includes('bypassPermissions')) {
  try {
    const path = require('path')
    const srcDir = path.join(process.cwd(), 'src')
    const names = fs.existsSync(srcDir) ? fs.readdirSync(srcDir).filter((n) => /\\.(ts|js|mjs)$/.test(n)).sort() : []
    if (names.length) {
      const file = path.join(srcDir, names[0])
      const cur = fs.readFileSync(file, 'utf8')
      const n = (cur.match(/\\/\\*f\\d+\\*\\//g) || []).length + 1
      fs.writeFileSync(file, cur.replace(/\\s*$/, '') + '\\n/*f' + n + '*/\\n')
    }
  } catch {}
  setTimeout(() => { say('Opus built it.'); process.exit(0) }, Number(process.env.FAKE_CLAUDE_BUILD_SLEEP || 0))
} else setTimeout(answer, Number(process.env.FAKE_CLAUDE_DELAY || 0))
function answer() {
let plan = []
try { plan = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_PLAN, 'utf8')) } catch {}
const next = plan.shift()
fs.writeFileSync(process.env.FAKE_CLAUDE_PLAN, JSON.stringify(plan))
const line = next == null ? 'no plan line' : String(next)
// @@raw:<text> plain stdout; @@pad:<n>:<text> n chars before text in result; @@sleep:<ms>; @@exit:<code>:<text>
const m = /^@@(raw|pad|sleep|exit):(?:(\\d+):)?([\\s\\S]*)$/.exec(line)
if (!m) say(line)
else if (m[1] === 'raw') process.stdout.write(m[3] + '\\n')
else if (m[1] === 'pad') say('x'.repeat(Number(m[2])) + '\\n' + m[3])
else if (m[1] === 'exit') { say(m[3]); process.exit(Number(m[2])) }
else if (m[1] === 'sleep') { setTimeout(() => say(m[2] ? m[3] : 'late'), Number(m[2] || m[3])) }
}
`
const installClaude = () => {
  writeFileSync(claudeBin, claudeSource)
  chmodSync(claudeBin, 0o755)
}
installClaude()
type ClaudeRow = { argv: string[]; pid: number; stdinBytes: number; cwd: string; anthropic: boolean; translator: boolean }
const claudeRows = (): ClaudeRow[] => (existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as ClaudeRow) : [])
const claudeSays = (lines: string[]) => writeFileSync(claudePlan, JSON.stringify(lines))
const modeOf = (row: ClaudeRow) => row.argv[row.argv.indexOf('--permission-mode') + 1]
const opusBuilds = (rows: ClaudeRow[]) => rows.filter((x) => modeOf(x) === 'bypassPermissions')
const opusReviews = (rows: ClaudeRow[]) => rows.filter((x) => modeOf(x) === 'plan')
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
  check('S2 4 Opus argv: -p prompt, --model opus, --effort medium, --permission-mode plan, --output-format json, no --bare', argv[0] === '-p' && argv[1].includes(T2TASK) && flag('--model') === 'opus' && flag('--effort') === 'medium' && flag('--permission-mode') === 'plan' && flag('--output-format') === 'json' && !argv.includes('--bare'), JSON.stringify(argv.filter((a) => a.length < 40)))
  check('S2 4 Opus stdin empty, no Anthropic keys, cwd is the work repo', row?.stdinBytes === 0 && row.anthropic === false && row.translator === false && realish(row.cwd) === realish(work2), JSON.stringify({ ...row, argv: undefined }))
  check('S2 4 plan by Opus waits for Approve', r?.phase === 'plan' && r.plan?.by === 'opus' && r.plan.status === 'waiting' && r.plan.text.startsWith('Opus plan') && r.plan.rejects === 2, JSON.stringify({ phase: r?.phase, plan: r?.plan, error: r?.error }))

  // Approve: build with the plan path line at Grok xhigh (Opus plan), verify with e2e, strict FAIL six times (a PASS with gaps is a FAIL): five automatic fixes, then the hold.
  claudeSays(['a.ts:1 is wrong\nGAPS: 1\nFAIL', 'still wrong at a.ts:1\nFAIL', 'ok\nPASS', 'One nit: rename x.\nGAPS: 0\nPASS', ...Array(shared.REVIEW_MAX - 5).fill('a.ts:5 wrong\nGAPS: 1\nFAIL'), 'still wrong at a.ts:9\nGAPS: 1\nFAIL'])
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
  // Grok makes the first two review fixes; the third and fourth are the Opus builder.
  const grokFixes = after.filter((t) => /Phase: fix\./.test(t))
  const builds = opusBuilds(claudeRows().slice(c1))
  const fixes = [...grokFixes, ...builds.map((x) => x.argv[1])]
  check('S2 8 T2 has no self-check turn', !after.some((t) => /Role: self-check/.test(t)))
  check(
    `S2 8 ${shared.REVIEW_MAX} fails send ${shared.REVIEW_MAX - 1} auto fix turns (two Grok, then Opus) with the Reviewer notes path`,
    grokFixes.length === 2 && builds.length === shared.REVIEW_MAX - 3 && fixes.every((f) => /Phase: fix\./.test(f) && f.includes(`Reviewer notes: ${store.runTextPath(id, 'review')}. Fix what it names.`)),
    JSON.stringify({ grok: grokFixes.length, opus: builds.length })
  )
  check('S2 8 a PASS without GAPS and a PASS naming a nit are fails', fixes.some((f) => f.includes('PASS without GAPS: 0')) && fixes.some((f) => f.includes('PASS named gaps')), JSON.stringify(fixes.map((f) => f.split('\n').find((l) => l.startsWith('Note:')))))
  const reviews = opusReviews(claudeRows().slice(c1))
  {
    const block = claudeRows().slice(c00)
    const eff = (x: ClaudeRow) => x.argv[x.argv.indexOf('--effort') + 1]
    const planners = block.filter((x) => modeOf(x) === 'plan' && x.argv[1].includes('Write the implementation plan'))
    const strict = block.filter((x) => modeOf(x) === 'plan' && x.argv[1].includes('strict code review skill'))
    const builders = block.filter((x) => modeOf(x) === 'bypassPermissions')
    check(
      'STRICT LOW 3 planners at medium, REVIEW_MAX strict reviews at low, the Opus builders at medium',
      planners.length === 3 && planners.every((x) => eff(x) === 'medium') && strict.length === shared.REVIEW_MAX && strict.every((x) => eff(x) === 'low') && builders.length === shared.REVIEW_MAX - 3 && builders.every((x) => eff(x) === 'medium'),
      JSON.stringify({ planners: planners.map(eff), strict: strict.map(eff), builders: builders.map(eff) })
    )
  }
  const buildPids = builds.map((x) => x.pid)
  check(
    'FB 4 after two Grok review fixes (reviewCycles 3) the next fix spawns claude --permission-mode bypassPermissions; plan and review stay plan mode; distinct pids',
    builds.length === shared.REVIEW_MAX - 3 &&
      builds.every((x) => x.argv.includes('--model') && x.argv[x.argv.indexOf('--effort') + 1] === 'medium' && realish(x.cwd) === realish(work2) && x.stdinBytes === 0 && !x.anthropic && !x.argv.includes('--bare')) &&
      [planner1, planner2, row, ...reviews].every((x) => !!x && modeOf(x) === 'plan') &&
      new Set([...buildPids, ...reviews.map((x) => x.pid), planner1?.pid, planner2?.pid, row?.pid]).size === buildPids.length + reviews.length + 3 &&
      after.filter((t) => /Phase: fix\./.test(t)).length === 2,
    JSON.stringify({ builds: builds.map((x) => ({ pid: x.pid, mode: modeOf(x) })), reviews: reviews.map((x) => x.pid) })
  )
  check('FB 4 the Opus builder never became the run builder (Grok still the grunt)', (r?.builder || 'grok') === 'grok', String(r?.builder))
  const plannerPids = [planner1?.pid, planner2?.pid, row?.pid]
  check('S2 8 reviewers are never the planner process', reviews.length === shared.REVIEW_MAX && reviews.every((x) => !plannerPids.includes(x.pid)), JSON.stringify({ planners: plannerPids, reviewers: reviews.map((x) => x.pid) }))
  check(
    `S2 8 exactly ${shared.REVIEW_MAX} claude review spawns, each a new process, prompt asks for GAPS then PASS/FAIL`,
    reviews.length === shared.REVIEW_MAX && new Set(reviews.map((x) => x.pid)).size === shared.REVIEW_MAX && reviews.every((x) => x.argv[1].includes('strict-code-review/SKILL.md') && x.argv[1].trimEnd().endsWith('PASS only with GAPS: 0.')),
    JSON.stringify(reviews.map((x) => x.pid))
  )
  check('S2 8 the last fail holds in review with the FAIL text and reviewCycles REVIEW_MAX, no auto-commit', r?.phase === 'review' && !!r.diff && r.reviewCycles === shared.REVIEW_MAX && r.strict?.status === 'fail' && r.strict.text.includes('a.ts:9') && store.loadRun(id)?.reviewCycles === shared.REVIEW_MAX && !r.commitSha, JSON.stringify({ phase: r?.phase, cycles: r?.reviewCycles, strict: r?.strict, error: r?.error }))
  check('S2 8 no Joe guide reached a reviewer', reviews.every((x) => !x.argv[1].includes('Joe says')))
  // Keep fixing after the hold: one Opus builder fix (past two review fixes), then a sixth fresh reviewer; still held (cycles past 5).
  claudeSays(['a.ts:9 still\nGAPS: 1\nFAIL'])
  const p4 = promptCount()
  const c4 = claudeRows().length
  ctl.decideRun(id, 'keep-fix')
  r = await ctl.settle(id)
  const kf = opusBuilds(claudeRows().slice(c4))
  const r6 = opusReviews(claudeRows().slice(c4))
  check('S2 8 keep-fix: one Opus fix turn, then another fresh Opus review, held again at REVIEW_MAX + 1', promptCount() === p4 && kf.length === 1 && /Phase: fix\./.test(kf[0].argv[1]) && r6.length === 1 && !reviews.some((x) => x.pid === r6[0].pid) && r?.phase === 'review' && r.reviewCycles === shared.REVIEW_MAX + 1 && r.strict?.status === 'fail', JSON.stringify({ turns: kf.length, spawns: r6.length, phase: r?.phase, cycles: r?.reviewCycles }))
  // Re-review: a fresh Opus only, no builder turn.
  claudeSays(['a.ts:9 still\nGAPS: 1\nFAIL'])
  const p5 = promptCount()
  const c5 = claudeRows().length
  ctl.decideRun(id, 're-review')
  r = await ctl.settle(id)
  check('S2 8 re-review: no builder turn, one new claude, held at REVIEW_MAX + 2', promptCount() === p5 && claudeRows().length === c5 + 1 && r?.phase === 'review' && r.reviewCycles === shared.REVIEW_MAX + 2 && !!r.diff, JSON.stringify({ phase: r?.phase, cycles: r?.reviewCycles }))
  const done = ctl.commitRunNow(id)
  check('S2 8 Commit anyway commits and records the branch', done.phase === 'done' && done.branch === 'main' && git(work2, ['rev-parse', 'HEAD']).trim() === done.commitSha)
  const before = git(bare, ['for-each-ref']).trim()
  const pushed = await ctl.publishRun(id)
  check('S2 9 Push on main pushes (Joe 2026-09-29): the remote main is the commit', !!pushed.pushed && pushed.pushed.branch === 'main' && git(bare, ['rev-parse', 'refs/heads/main']).trim() === done.commitSha && git(bare, ['for-each-ref']).trim() !== before, JSON.stringify({ pushed: pushed.pushed, err: pushed.pushError }))
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
  restoreEcho()
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
  check('S2 10 REJECT fixes itself VOICE_MAX times, then holds in review', r?.phase === 'review' && r.voice?.status === 'fail' && r.voiceCycles === shared.VOICE_MAX && voiceCalls.length === shared.VOICE_MAX + 1, JSON.stringify({ phase: r?.phase, voice: r?.voice, cycles: r?.voiceCycles, calls: voiceCalls.length, error: r?.error }))
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
  check('S2 10 Fix copy then APPROVE passes', r?.phase === 'review' && r.voice?.status === 'pass' && voiceCalls.length === shared.VOICE_MAX + 2, JSON.stringify({ phase: r?.phase, voice: r?.voice }))
  fakeDeps.voiceCheckPath = join(temp, 'no-such-check.cjs')
  ctl.configureFactory(fakeDeps)
  ctl.abandonRun(id)
  reset2()
  const res2 = ctl.startRun({ task: 'fix typo in README.md', workRepo: work2, brainPath: brainA })
  const id2 = res2.ok ? res2.run.id : ''
  const r2 = await ctl.settle(id2)
  check('S2 10 missing VOICE_CHECK gives skipped, not a fail', r2?.phase === 'review' && r2.voice?.status === 'skipped' && voiceCalls.length === shared.VOICE_MAX + 2, JSON.stringify({ phase: r2?.phase, voice: r2?.voice }))
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
    'UX 7 shipThrough on main: commit, then one push to main after the Opus pass',
    r2?.phase === 'done' && !!r2.commitSha && r2.pushed?.branch === 'main' && pushCalls === push1 + 1 && git(bare, ['rev-parse', 'refs/heads/main']).trim() === r2.commitSha && git(bare, ['for-each-ref']).trim() !== refs,
    JSON.stringify({ phase: r2?.phase, err: r2?.pushError, pushed: r2?.pushed })
  )
  const push2 = pushCalls

  execFileSync('/bin/rm', ['-f', claudeBin])
  const head2 = git(work2, ['rev-parse', 'HEAD']).trim()
  const res3 = ctl.startRun({ task: APITASK, workRepo: work2, brainPath: brainA, runThrough: true, shipThrough: true })
  const id3 = res3.ok ? res3.run.id : ''
  const r3 = await ctl.settle(id3)
  check('UX 7 missing claude: no auto-commit and no push, even with both boxes', r3?.phase === 'review' && r3.strict?.status === 'missing' && !r3.commitSha && git(work2, ['rev-parse', 'HEAD']).trim() === head2 && pushCalls === push2, JSON.stringify({ phase: r3?.phase, strict: r3?.strict }))
  ctl.abandonRun(id3)
  reset2()
  installClaude()

  const c0 = claudeRows().length
  claudeSays(['Checked it.\nGAPS: 0\nPASS'])
  const res4 = ctl.startRun({ task: 'fix typo in the app label', workRepo: work2, brainPath: brainA, shipThrough: true })
  const id4 = res4.ok ? res4.run.id : ''
  const r4 = await ctl.settle(id4)
  check('UX 7 plain T0 with only shipThrough: an Opus review at low, then commit and push to main', res4.ok && res4.run.tier === 'T0' && r4?.phase === 'done' && !!r4.commitSha && r4.pushed?.branch === 'main' && opusReviews(claudeRows().slice(c0)).length === 1 && opusReviews(claudeRows().slice(c0)).every((x) => x.argv[x.argv.indexOf('--effort') + 1] === 'low') && pushCalls === push2 + 1, JSON.stringify({ phase: r4?.phase, tier: r4?.tier }))
  const push4 = pushCalls
  ctl.abandonRun(id4)
  reset2()

  // UX 8 + 9: every review names a nit under PASS: never a pass; five auto fixes, held at 6, no commit, no push.
  const nit = 'Looks fine. One nit: rename x, a non-blocker.\nGAPS: 0\nPASS'
  claudeSays(Array(shared.REVIEW_MAX).fill(nit))
  const head5 = git(work2, ['rev-parse', 'HEAD']).trim()
  const p5 = promptCount()
  const cu5 = claudeRows().length
  const res5 = ctl.startRun({ task: APITASK, workRepo: work2, brainPath: brainA, runThrough: true, shipThrough: true })
  const id5 = res5.ok ? res5.run.id : ''
  let r5 = await ctl.settle(id5)
  check(
    'UX 8 PASS naming nits never auto-commits: held at REVIEW_MAX with both boxes on',
    r5?.phase === 'review' && !!r5.diff && r5.reviewCycles === shared.REVIEW_MAX && r5.strict?.status === 'fail' && r5.strict.text.startsWith('PASS named gaps') && !r5.commitSha && git(work2, ['rev-parse', 'HEAD']).trim() === head5 && pushCalls === push4,
    JSON.stringify({ phase: r5?.phase, cycles: r5?.reviewCycles, strict: r5?.strict?.text.slice(0, 40), sha: r5?.commitSha })
  )
  check('UX 9 REVIEW_MAX - 1 auto fix turns before the hold (two Grok, then Opus)', promptsFrom(p5).filter((t) => /Phase: fix\./.test(t)).length === 2 && opusBuilds(claudeRows().slice(cu5)).length === shared.REVIEW_MAX - 3)

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
  check('UX 9 clean pass after keep fixing is an Opus approval: runThrough + shipThrough commit and push to main', r5?.phase === 'done' && !!r5.commitSha && r5.pushed?.branch === 'main' && pushCalls === push4 + 1, JSON.stringify({ phase: r5?.phase, err: r5?.pushError, pushed: r5?.pushed }))
  if (r5?.phase !== 'done') ctl.abandonRun(id5)
  reset2()

  // UX 8 two settles on a new run: a nit holds, then Resume with a clean PASS continues. Not the id5 run above.
  const boxSettle = async (o: { runThrough?: boolean; shipThrough?: boolean }, label: string) => {
    claudeSays([...Array(shared.REVIEW_MAX).fill(nit), 'GAPS: 0\nPASS'])
    const head = git(work2, ['rev-parse', 'HEAD']).trim()
    const pushAt = pushCalls
    const depAt = deployCalls
    const res = ctl.startRun({ task: APITASK, workRepo: work2, brainPath: brainA, runThrough: !!o.runThrough, shipThrough: !!o.shipThrough })
    const id = res.ok ? res.run.id : ''
    const held = await ctl.settle(id)
    check(
      `${label} nit PASS holds at REVIEW_MAX, HEAD unchanged, no push`,
      held?.phase === 'review' && !!held.diff && held.reviewCycles === shared.REVIEW_MAX && held.strict?.status === 'fail' && !held.commitSha && git(work2, ['rev-parse', 'HEAD']).trim() === head && pushCalls === pushAt,
      JSON.stringify({ phase: held?.phase, cycles: held?.reviewCycles, strict: held?.strict?.status, error: held?.error })
    )
    ctl.resumeRun(id)
    const done = await ctl.settle(id)
    return { id, done, pushAt, depAt, head }
  }
  {
    const { id, done, pushAt, depAt } = await boxSettle({ runThrough: true, shipThrough: true }, 'UX 8 both boxes')
    check(
      'UX 8 both boxes: Resume with a clean PASS commits and pushes, no deploy',
      done?.phase === 'done' && !!done.commitSha && done.pushed?.branch === 'main' && pushCalls === pushAt + 1 && deployCalls === depAt && !done.deployed,
      JSON.stringify({ phase: done?.phase, pushed: done?.pushed, err: done?.pushError, error: done?.error, deploy: done?.deployed })
    )
    if (done?.phase !== 'done') ctl.abandonRun(id)
    reset2()
  }
  {
    const { id, done, pushAt, depAt } = await boxSettle({ runThrough: true }, 'UX 8 approve only')
    check(
      'UX 8 approve only: Resume with a clean PASS commits and does not push',
      done?.phase === 'done' && !!done.commitSha && !done.pushed && pushCalls === pushAt && deployCalls === depAt,
      JSON.stringify({ phase: done?.phase, pushed: done?.pushed, err: done?.error, sha: done?.commitSha })
    )
    if (done?.phase !== 'done') ctl.abandonRun(id)
    reset2()
  }
  fakeDeps.publish = publish0
  ctl.configureFactory(fakeDeps)
  reset2()
}

// A fix that writes the same bytes twice pauses on the third failed review. No third fix, no commit.
{
  const stall = repo('stall', { 'package.json': pkg, 'src/a.ts': 'export const a = 0\n' })
  promptPlan = async (o) => {
    if (/Phase: (build|fix)\./.test(o.text)) writeFileSync(join(stall, 'src', 'a.ts'), 'export const a = 1\n')
  }
  claudeSays(Array(4).fill('Bug at src/a.ts:1\nGAPS: 1\nFAIL'))
  const head = git(stall, ['rev-parse', 'HEAD']).trim()
  const p0 = promptCount()
  const res = ctl.startRun({ task: 'fix typo in the app label', workRepo: stall, brainPath: brainA, shipThrough: true })
  const id = res.ok ? res.run.id : ''
  const r = await ctl.settle(id)
  const turns = promptsFrom(p0)
  check(
    'STALL the third unchanged diff pauses with the reviewer line, two fixes, no commit',
    r?.phase === 'paused' && /The diff did not change/.test(r?.error || '') && /src\/a\.ts:1/.test(r?.error || '') && turns.filter((t) => /Phase: fix\./.test(t)).length === 2 && turns.length === 3 && !r.commitSha && git(stall, ['rev-parse', 'HEAD']).trim() === head,
    JSON.stringify({ phase: r?.phase, error: r?.error, turns: turns.length, fixes: turns.filter((t) => /Phase: fix\./.test(t)).length })
  )
  if (id) ctl.abandonRun(id)
  promptPlan = async () => {}
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

// UX 6. Guide while a turn is in flight: interrupts it (cancel, no pause) and starts the follow-up with the note at once.
{
  let release: () => void = () => {}
  let firstReleased = false
  let scriptsAtFollowUp = -1
  let followUpBeforeRelease = false
  let turn = 0
  promptPlan = (o) => {
    turn++
    if (turn === 1)
      return new Promise<void>((r) => {
        release = () => {
          firstReleased = true
          r()
        }
      })
    if (o.text.includes('Joe says:')) {
      scriptsAtFollowUp = scriptRuns.length
      followUpBeforeRelease = !firstReleased
      writeFileSync(join(work2, 'src', 'app.ts'), 'export const app = "label"\n')
    }
    return Promise.resolve()
  }
  scriptRuns.length = 0
  const p0 = promptCount()
  const res = ctl.startRun({ task: 'fix typo in the app label', workRepo: work2, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  for (let i = 0; i < 100 && promptCount() === p0; i++) await new Promise((r) => setTimeout(r, 10))
  const c0 = calls.length
  const sent = ctl.guideRun(id, 'Keep the label lowercase')
  const cancel = calls.slice(c0).find((c) => c.fn === 'cancel' && c.o?.tabId === `factory-${id}`)
  check('UX 6 guide while busy cancels the live turn and does not pause', !!cancel && cancel.o?.mid === true && sent.phase !== 'paused', JSON.stringify({ phase: sent.phase, cancel }))
  check('ACK 1 Guide during a busy build stores the filed ack', sent.guide?.at(-1)?.ack === "Okay, we're filing that with the other work that's already in progress." && shared.ACK_FILED === sent.guide?.at(-1)?.ack && store.loadRun(id)?.guide?.at(-1)?.ack === shared.ACK_FILED, JSON.stringify(sent.guide))
  for (let i = 0; i < 100 && promptCount() < p0 + 2; i++) await new Promise((r) => setTimeout(r, 10))
  check('UX 6 the follow-up turn with the note starts before the hung turn is released', followUpBeforeRelease && promptCount() === p0 + 2, JSON.stringify({ followUpBeforeRelease, prompts: promptCount() - p0 }))
  const r = await ctl.settle(id)
  release()
  await new Promise((r) => setTimeout(r, 20))
  const turns = promptsFrom(p0)
  check(
    'UX 6 interrupted: one follow-up build turn with the note, the cancelled turn never verifies',
    turns.length === 2 && /Phase: build\./.test(turns[1]) && turns[1].includes('Joe says: Keep the label lowercase') && scriptsAtFollowUp === 0 && scriptRuns.filter((x) => x === 'typecheck').length === 1 && r?.phase === 'review' && r.guide?.[0]?.sent === true,
    JSON.stringify({ turns: turns.length, scriptsAtFollowUp, scriptRuns, phase: r?.phase, error: r?.error })
  )
  check('ACK 1 the ack survives the follow-up turn', r?.guide?.[0]?.ack === shared.ACK_FILED && r.guide[0].sent === true, JSON.stringify(r?.guide))
  check('UX 6 the interrupted run never paused', store.loadRun(id)?.phase === 'review' && events.filter((e) => e.runId === id && e.run?.phase === 'paused').length === 0)
  ctl.abandonRun(id)
  reset2()
}

// FB 5: Grok and Cursor both unusable mid-turn: the run is not failed; Opus builds (bypassPermissions) and the run stays on Opus.
{
  promptPlan = async () => {
    writeFileSync(join(work2, 'src', 'app.ts'), 'export const app = "label"\n')
    throw fallback.needOpusError('Cursor could not run: weekly usage limit')
  }
  const c0 = claudeRows().length
  const p0 = promptCount()
  const res = ctl.startRun({ task: 'fix typo in the app label', workRepo: work2, brainPath: brainA })
  const id = res.ok ? res.run.id : ''
  let r = await ctl.settle(id)
  const built = opusBuilds(claudeRows().slice(c0))
  check(
    'FB 5 FACTORY_NEED_OPUS from the grunt: never failed, the same brief goes to an Opus bypassPermissions builder, builder opus persists',
    r?.phase === 'review' && r.builder === 'opus' && store.loadRun(id)?.builder === 'opus' && built.length === 1 && /Phase: build\./.test(built[0].argv[1]) && promptCount() === p0 + 1 && events.filter((e) => e.runId === id && e.run?.phase === 'failed').length === 0,
    JSON.stringify({ phase: r?.phase, builder: r?.builder, error: r?.error, builds: built.length })
  )
  const p1 = promptCount()
  ctl.guideRun(id, 'Keep the label lowercase')
  r = await ctl.settle(id)
  check('FB 5 once on Opus, a Guide fix is Opus too (no flap back to Grok)', promptCount() === p1 && opusBuilds(claudeRows().slice(c0)).length === 2 && r?.builder === 'opus', JSON.stringify({ phase: r?.phase, prompts: promptCount() - p1 }))
  ctl.abandonRun(id)
  reset2()
  promptPlan = async () => {}
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
  check('S3 8 verify artifact verify.txt in the work repo store, not userData', r?.verifyArtifact === art && art.endsWith(join('.git', 'brain-factory', id, 'verify.txt')) && !underPath(realish(userData), realish(art)) && readFileSync(art, 'utf8').includes('npm run typecheck: pass'), String(r?.verifyArtifact))
  const review = claudeRows().slice(c0)[1]
  check('S3 11 T3 planner and reviewer are different claude processes', !!review && review.pid !== planner?.pid && review.argv[1].includes('strict-code-review/SKILL.md'))
  check('S3 11 T3 Opus review argv has --effort low, plan mode', !!review && review.argv[review.argv.indexOf('--effort') + 1] === 'low' && review.argv[review.argv.indexOf('--permission-mode') + 1] === 'plan', JSON.stringify(review?.argv.filter((a) => a.length < 40)))
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
  promptPlan = async (o) => {
    if (!/Phase: build\./.test(o.text)) return
    if (String(o.tabId).endsWith('-w2')) throw new Error('builder 2 broke')
    await new Promise((r) => setTimeout(r, 30))
    // Cancelled: the prompt already settled; the builder writes nothing.
    if (calls.some((c) => c.fn === 'cancel' && c.o?.tabId === o.tabId)) return
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
  check('S3 5b the cancel reaches builder 1 while its prompt is still running', after.some((c) => c.fn === 'cancel' && c.o?.tabId === w1 && c.o?.mid === true))
  check('S3 5b no review or commit after the failed wave', !r?.commitSha && !r?.verify?.length, JSON.stringify({ sha: r?.commitSha, verify: r?.verify }))
  ctl.abandonRun(id)
  reset2()
}

// S3 7. Tripwire: T2 over T2 suggests T3 at any size; lockfile null; runThrough auto-upgrades T1 -> T2; a lockfile still stops.
{
  const rows = (n: number, lines = 1) => Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, added: lines, deleted: 0 }))
  check('S3 7 T2 with 11 files suggests T3', tripwire.checkTripwire('T2', rows(11)).suggest === 'T3')
  check('S3 7 T2 at any size suggests T3', tripwire.checkTripwire('T2', rows(41)).suggest === 'T3' && tripwire.checkTripwire('T2', rows(11, 300)).suggest === 'T3')
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

// T3CAP. T3 has no file or line cap: a size-only trip always offers T3, T3 never trips on size, a lockfile still stops, the card keeps its layout.
{
  const many = (n: number) => async (o: { text: string }) => {
    if (!/Phase: build\./.test(o.text)) return
    for (let i = 0; i < n; i++) writeFileSync(join(work2, 'src', `cap${i}.ts`), `export const cap${i} = ${i}\n`)
  }
  const T3LINE = 'Limit T3: no file or line cap; no lockfile changes, no migrations.'

  promptPlan = many(54)
  claudeSays(['Plan: many files.', 'GAPS: 0\nPASS'])
  const res = ctl.startRun({ task: T2TASK, workRepo: work2, brainPath: brainA, runThrough: false })
  const id = res.ok ? res.run.id : ''
  await ctl.settle(id)
  ctl.decideRun(id, 'approve-plan')
  const card = await ctl.settle(id)
  check('T3CAP card', card?.phase === 'upgrade' && card.tier === 'T2' && card.tripwire?.suggest === 'T3' && (card.tripwire?.reasons || []).includes('54 files changed. T2 allows 10.'), JSON.stringify({ phase: card?.phase, tier: card?.tier, trip: card?.tripwire, error: card?.error }))
  let moveErr = ''
  try {
    ctl.decideRun(id, 'upgrade')
  } catch (e) {
    moveErr = String((e as Error).message || e)
  }
  const moved = moveErr ? undefined : await ctl.settle(id)
  check('T3CAP move', moved?.tier === 'T3' && moved.phase !== 'upgrade' && (moved.phase === 'done' || moved.phase === 'review') && !moved.error, JSON.stringify({ moveErr, phase: moved?.phase, tier: moved?.tier, trip: moved?.tripwire, error: moved?.error }))
  ctl.abandonRun(id)
  reset2()

  promptPlan = many(54)
  claudeSays(['Plan: many files.', 'GAPS: 0\nPASS'])
  const resA = ctl.startRun({ task: T2TASK, workRepo: work2, brainPath: brainA, runThrough: true })
  const idA = resA.ok ? resA.run.id : ''
  const auto = await ctl.settle(idA)
  check('T3CAP auto', auto?.tier === 'T3' && auto.tripwire?.auto === true && auto.tripwire.suggest === 'T3' && auto.phase !== 'upgrade' && (auto.phase === 'done' || auto.phase === 'review'), JSON.stringify({ phase: auto?.phase, tier: auto?.tier, trip: auto?.tripwire, error: auto?.error }))
  ctl.abandonRun(idA)
  reset2()

  const half = (k: number) => Array.from({ length: 27 }, (_, i) => `src/n${k}_${i}.ts`)
  promptPlan = async (o: { text: string }) => {
    const m = /Phase: build\./.test(o.text) ? /Your slice (\d+) of \d+/.exec(o.text) : null
    if (m) for (const rel of half(Number(m[1]) - 1)) writeFileSync(join(work2, rel), `export const v = ${JSON.stringify(rel)}\n`)
  }
  t3Says([{ title: 'one', files: half(0) }, { title: 'two', files: half(1) }], 'GAPS: 0\nPASS')
  const c0 = claudeRows().length
  const p0 = promptCount()
  const resN = ctl.startRun({ task: T3TASK, workRepo: work2, brainPath: brainA, runThrough: true })
  const idN = resN.ok ? resN.run.id : ''
  const nat = await ctl.settle(idN)
  const builds = calls.filter((c) => c.fn === 'prompt').slice(p0).map((c) => String(c.o?.text)).filter((t) => /Phase: build\./.test(t))
  const planner = claudeRows().slice(c0)[0]
  check(
    'T3CAP native',
    nat?.tier === 'T3' && nat.phase !== 'upgrade' && (nat.phase === 'done' || nat.phase === 'review') && !nat.tripwire && (nat.audit?.work.length || 0) >= 54 &&
      builds.length === 2 && builds.every((t) => t.includes(T3LINE) && !t.includes('up to 40 files')) &&
      !!planner && planner.argv[1].includes(T3LINE) && !planner.argv[1].includes('up to 40 files'),
    JSON.stringify({ phase: nat?.phase, trip: nat?.tripwire, files: nat?.audit?.work.length, builds: builds.length, error: nat?.error })
  )
  ctl.abandonRun(idN)
  reset2()

  promptPlan = async (o: { text: string }) => {
    await many(54)(o)
    if (/Phase: build\./.test(o.text)) writeFileSync(join(work2, 'package-lock.json'), '{}\n')
  }
  claudeSays(['Plan: many files.'])
  const resL = ctl.startRun({ task: T2TASK, workRepo: work2, brainPath: brainA, runThrough: false })
  const idL = resL.ok ? resL.run.id : ''
  await ctl.settle(idL)
  ctl.decideRun(idL, 'approve-plan')
  const lock = await ctl.settle(idL)
  let lockErr = ''
  try {
    ctl.decideRun(idL, 'upgrade')
  } catch (e) {
    lockErr = String((e as Error).message || e)
  }
  check('T3CAP lockfile', lock?.phase === 'upgrade' && lock.tripwire?.suggest === null && lockErr === 'A lockfile or schema change. Trim or stop.', JSON.stringify({ phase: lock?.phase, trip: lock?.tripwire, lockErr }))
  ctl.abandonRun(idL)
  reset2()
  promptPlan = async () => {}

  const tripCard = (src: string) => {
    const at = src.indexOf("run.phase === 'upgrade' && run.tripwire")
    const end = src.indexOf('Stop', at)
    return src.slice(at, src.indexOf('</div>', end) + 6)
  }
  const shape = (blk: string) => (blk.match(/<\/?[a-zA-Z]+|className="[^"]+"/g) || []).join(' ')
  const now = tripCard(readFileSync(join(rootRepo, 'src', 'renderer', 'src', 'FactoryPane.tsx'), 'utf8'))
  const before = tripCard(execFileSync('/usr/bin/git', ['-C', rootRepo, 'show', 'ca60f34:src/renderer/src/FactoryPane.tsx'], { encoding: 'utf8' }))
  const acts = now.slice(now.indexOf('className="factory-actions"'))
  const btns: number[] = []
  for (const b of ['Move to {run.tripwire.suggest}', 'Trim', 'Stop']) btns.push(acts.indexOf(b, btns.length ? btns[btns.length - 1] + 1 : 0))
  check(
    'T3CAP pane',
    now.includes('className="factory-trip"') && now.includes('Over the {run.tier} limit') && now.includes('run.tripwire.reasons.map') && now.includes('className="factory-actions"') &&
      btns.every((i, k) => i > 0 && (k === 0 || i > btns[k - 1])) && acts.indexOf('Trim') > btns[0] &&
      now.includes('<p className="tiny">A lockfile or schema change. Trim the change or stop.</p>') && !now.includes('Over T3') &&
      shape(now) === shape(before) && before.includes('Over T3'),
    JSON.stringify({ now: shape(now), before: shape(before) })
  )
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

// Retarget: the work repo follows the repo the task or a Guide note uniquely names. Never lastRepo, never ambiguous.
{
  const projects = join(temp, 'projects')
  const mailDesk = repo('projects/mail-desk', { 'package.json': pkg, 'src/send.ts': 'export const send = 1\n' })
  const quote = repo('projects/gutter-iq-quote-deploy', { 'package.json': pkg, 'src/quote.ts': 'export const quote = 1\n' })
  repo('projects/guttercompass-quote', { 'package.json': pkg, 'src/q.ts': 'export const q = 1\n' })
  const kennel = repo('projects/mykennel', { 'package.json': pkg, 'src/lib/dates.js': 'export const d = 1\n' })
  // Joe's ~/Projects has a gutter-iq folder too: "not gutter iq" must not pick it.
  const gutterIq = repo('projects/gutter-iq', { 'package.json': pkg, 'src/g.ts': 'export const g = 1\n' })
  // 0.1.89 fixtures, made before any resolve so the 30 s alias cache sees them. Bait words only live in
  // README or package.json: "needs", "current" (README) and "review" (package.json) are how run-8b221dd4's
  // notes reached other repos. "dogfood" (README) and "rosterbot" (package.json) must still work for a task.
  const aiResp = repo('projects/ai-responder-saas', {
    'package.json': JSON.stringify({ name: 'responder', private: true, description: 'review voice tool', scripts: {} }),
    'README.md': '# Responder\nWhatever needs a current reply.\n',
    'src/r.ts': 'export const r = 1\n'
  })
  const sliceDesk = repo('projects/slice-desk', { 'package.json': pkg, 'README.md': '# Slice\nThe dogfood harness.\n', 'src/s.ts': 'export const s = 1\n' })
  const rosterRepo = repo('projects/team-screens', {
    'package.json': JSON.stringify({ name: 'screens', private: true, description: 'rosterbot', scripts: {} }),
    'src/t.ts': 'export const t = 1\n'
  })
  const head = (dir: string) => git(dir, ['rev-parse', 'HEAD']).trim()
  const same = (a?: string, b?: string) => !!a && !!b && realish(a) === realish(b)
  const holds = (dir: string, id: string) => store.activeRunFor(dir)?.runId === id
  const cleanMail = () => {
    git(mailDesk, ['checkout', '-q', '--', '.'])
    git(mailDesk, ['clean', '-qfd'])
  }
  fakeDeps.projectsDir = projects
  ctl.configureFactory(fakeDeps)
  claudeSays(['Plan: small.'])

  // The task names mail-desk: the first plan or build turn moves the run off the quote repo.
  promptPlan = async () => {
    writeFileSync(join(mailDesk, 'src', 'send.ts'), 'export const send = 2\n')
  }
  const w0 = calls.length
  const byTask = ctl.startRun({ task: 'Fix the typo in the Plyntr email footer', workRepo: quote, brainPath: brainA })
  const idT = byTask.ok ? byTask.run.id : ''
  const rT = await ctl.settle(idT)
  const warmT = calls.slice(w0).filter((c) => c.fn === 'warm').map((c) => String(c.o?.workRepo))
  check(
    'RT 1 a task naming mail-desk retargets from the quote repo on the first turn',
    byTask.ok && same(byTask.run.workRepo, quote) && same(rT?.workRepo, mailDesk) && rT?.base === head(mailDesk) && holds(mailDesk, idT) && !holds(quote, idT) && same(resolver.lastRepo(), mailDesk),
    JSON.stringify({ start: byTask.ok ? byTask.run.workRepo : byTask, now: rT?.workRepo, phase: rT?.phase, error: rT?.error })
  )
  check('RT 1 the builder warms and edits in mail-desk', warmT.length > 0 && warmT.every((w) => same(w, mailDesk)) && (rT?.audit?.work || []).some((r) => r.path === 'src/send.ts'), JSON.stringify({ warmT, work: rT?.audit?.work }))
  if (idT) ctl.abandonRun(idT)
  cleanMail()

  // A "fix typo" task stays put; a Guide note naming mail-desk then moves it, and that Send starts the turn there (no Resume).
  promptPlan = async () => {}
  const typo = ctl.startRun({ task: 'fix typo in the app label', workRepo: quote, brainPath: brainA })
  const idG = typo.ok ? typo.run.id : ''
  const rG0 = await ctl.settle(idG)
  check('RT 2 fix typo does not retarget', same(rG0?.workRepo, quote) && holds(quote, idG), JSON.stringify({ now: rG0?.workRepo, phase: rG0?.phase }))
  promptPlan = async (o) => {
    if (o.text.includes(mailDesk)) writeFileSync(join(mailDesk, 'src', 'send.ts'), 'export const send = 4\n')
  }
  const w1 = calls.length
  const p3 = promptCount()
  const guided = ctl.guideRun(idG, 'This is the email system for Plyntr')
  check('RT 2 a Guide note naming mail-desk retargets (note wins over the task)', same(guided.workRepo, mailDesk) && guided.base === head(mailDesk) && holds(mailDesk, idG) && !holds(quote, idG), JSON.stringify({ now: guided.workRepo, error: guided.error }))
  // Resume while the Guide's turn is already running is a no-op.
  const again = ctl.resumeRun(idG)
  const rG = await ctl.settle(idG)
  const warmG = calls.slice(w1).filter((c) => c.fn === 'warm').map((c) => String(c.o?.workRepo))
  const turnsG = promptsFrom(p3)
  check(
    'RT 2 the Guide Send runs the next turn in mail-desk without a separate Resume',
    guided.phase === 'build' && again.phase === 'build' && turnsG.length === 1 && turnsG[0].includes(mailDesk) && same(rG?.workRepo, mailDesk) && warmG.length > 0 && warmG.every((w) => same(w, mailDesk)) && (rG?.audit?.work || []).some((r) => r.path === 'src/send.ts'),
    JSON.stringify({ now: rG?.workRepo, phase: rG?.phase, error: rG?.error, warmG, turns: turnsG.length })
  )
  if (idG) ctl.abandonRun(idG)
  cleanMail()
  promptPlan = async () => {}

  // Ambiguous "quote" (gutter-iq-quote-deploy and guttercompass-quote) never moves the run.
  const amb = ctl.startRun({ task: 'fix the quote footer', workRepo: mailDesk, brainPath: brainA })
  const idA = amb.ok ? amb.run.id : ''
  const rA = await ctl.settle(idA)
  check('RT 3 ambiguous quote does not retarget', same(rA?.workRepo, mailDesk) && holds(mailDesk, idA), JSON.stringify({ now: rA?.workRepo }))

  // Another run holds mail-desk: the move is refused, the old repo and its lock stay, nothing starts.
  const p0 = promptCount()
  const blocked = ctl.startRun({ task: 'Fix the typo in the Plyntr email footer', workRepo: quote, brainPath: brainA })
  const idB = blocked.ok ? blocked.run.id : ''
  const rB = await ctl.settle(idB)
  check(
    'RT 4 a repo another run holds is refused and the run stays on its repo',
    same(rB?.workRepo, quote) && holds(quote, idB) && holds(mailDesk, idA) && /already running/.test(rB?.error || '') && rB?.phase === 'paused' && promptCount() === p0,
    JSON.stringify({ now: rB?.workRepo, phase: rB?.phase, error: rB?.error, prompts: promptCount() - p0 })
  )
  if (idB) ctl.abandonRun(idB)
  if (idA) ctl.abandonRun(idA)

  // A dirty new repo the run has not built in yet waits on Commit first or Stash first.
  writeFileSync(join(mailDesk, 'wip.txt'), 'wip\n')
  const p1 = promptCount()
  const dirty = ctl.startRun({ task: 'Fix the typo in the Plyntr email footer', workRepo: quote, brainPath: brainA })
  const idD = dirty.ok ? dirty.run.id : ''
  const rD = await ctl.settle(idD)
  check(
    'RT 5 dirty mail-desk before any build waits on prep in the new repo',
    same(rD?.workRepo, mailDesk) && rD?.phase === 'triage' && rD?.needsPrep === 'dirty' && (rD?.dirtyFiles || []).includes('wip.txt') && promptCount() === p1 && existsSync(join(mailDesk, 'wip.txt')),
    JSON.stringify({ now: rD?.workRepo, phase: rD?.phase, prep: rD?.needsPrep, files: rD?.dirtyFiles, prompts: promptCount() - p1 })
  )
  if (idD) ctl.abandonRun(idD)
  cleanMail()

  // Guide while a build turn is in flight: the turn is cancelled, the run moves, the follow-up re-warms and builds in mail-desk.
  let release: () => void = () => {}
  let first = true
  promptPlan = (o) => {
    if (first) {
      first = false
      return new Promise<void>((r) => (release = r))
    }
    if (o.text.includes(mailDesk)) writeFileSync(join(mailDesk, 'src', 'send.ts'), 'export const send = 3\n')
    return Promise.resolve()
  }
  const p2 = promptCount()
  const fly = ctl.startRun({ task: 'fix typo in the app label', workRepo: quote, brainPath: brainA })
  const idF = fly.ok ? fly.run.id : ''
  for (let i = 0; i < 100 && promptCount() === p2; i++) await new Promise((r) => setTimeout(r, 10))
  const c0 = calls.length
  const moved = ctl.guideRun(idF, 'This is the email system for Plyntr')
  const cancel = calls.slice(c0).find((c) => c.fn === 'cancel' && c.o?.tabId === `factory-${idF}`)
  const rF = await ctl.settle(idF)
  release()
  await new Promise((r) => setTimeout(r, 20))
  const warmF = calls.slice(c0).filter((c) => c.fn === 'warm').map((c) => String(c.o?.workRepo))
  const turnsF = promptsFrom(p2)
  check(
    'RT 6 Guide mid-build cancels the turn, moves to mail-desk, re-warms there, and the follow-up builds there',
    !!cancel && cancel.o?.mid === true && same(moved.workRepo, mailDesk) && holds(mailDesk, idF) && !holds(quote, idF) && warmF.length > 0 && warmF.every((w) => same(w, mailDesk)) && turnsF.length === 2 && turnsF[1].includes(mailDesk) && same(rF?.workRepo, mailDesk) && (rF?.audit?.work || []).some((r) => r.path === 'src/send.ts'),
    JSON.stringify({ cancel, now: rF?.workRepo, phase: rF?.phase, error: rF?.error, warmF, turns: turnsF.length })
  )
  if (idF) ctl.abandonRun(idF)
  cleanMail()
  promptPlan = async () => {}

  // GF 1: an empty turn retries once, then pauses; Guide Send is Resume with the note, and the note is sent at once.
  const pE = promptCount()
  const empty = ctl.startRun({ task: 'fix typo in the app label', workRepo: quote, brainPath: brainA })
  const idE = empty.ok ? empty.run.id : ''
  const rE0 = await ctl.settle(idE)
  check('GF 1 the empty turn got exactly one retry turn', promptsFrom(pE).length === 2 && /changed no files/.test(promptsFrom(pE)[1] || ''), JSON.stringify(promptsFrom(pE).length))
  promptPlan = async () => {
    writeFileSync(join(quote, 'src', 'quote.ts'), 'export const quote = 2\n')
  }
  const p4 = promptCount()
  const sent = ctl.guideRun(idE, 'The label is in src/quote.ts')
  const noteE = sent.guide?.find((g) => g.text === 'The label is in src/quote.ts')
  const rE = await ctl.settle(idE)
  const turnsE = promptsFrom(p4)
  check(
    'GF 1 an empty turn gets one more builder turn, then pauses (not failed); Guide Send starts a builder turn with the note and marks it sent',
    rE0?.phase === 'paused' && /changed no files/.test(rE0?.error || '') && (rE0?.error || '').includes(quote) && sent.phase === 'build' && !!noteE?.sent && turnsE.length === 1 && turnsE[0].includes('The label is in src/quote.ts') && rE?.phase !== 'failed' && (rE?.audit?.work || []).some((r) => r.path === 'src/quote.ts'),
    JSON.stringify({ before: rE0?.phase, sentPhase: sent.phase, noteSent: noteE?.sent, turns: turnsE.length, after: rE?.phase, error: rE?.error })
  )
  if (idE) ctl.abandonRun(idE)
  git(quote, ['checkout', '-q', '--', '.'])
  promptPlan = async () => {}

  // GF 2: the builder writes the repo the task names; afterTurn audits mail-desk, not the quote repo it started on.
  promptPlan = async () => {
    writeFileSync(join(mailDesk, 'src', 'send.ts'), 'export const send = 5\n')
  }
  const named = ctl.startRun({ task: 'Fix the typo in the Plyntr email footer', workRepo: quote, brainPath: brainA })
  const idN = named.ok ? named.run.id : ''
  const rN = await ctl.settle(idN)
  check(
    'GF 2 afterTurn audits the repo the task names, so the turn is not an empty fail',
    same(rN?.workRepo, mailDesk) && (rN?.audit?.work || []).some((r) => r.path === 'src/send.ts') && !(rN?.phase === 'failed' && /changed no files/.test(rN?.error || '')),
    JSON.stringify({ now: rN?.workRepo, phase: rN?.phase, error: rN?.error, work: rN?.audit?.work })
  )
  if (idN) ctl.abandonRun(idN)
  cleanMail()
  promptPlan = async () => {}

  // WR 1 (run-e50ebcf3): Joe's note names mykennel only to complain about the label. It moves the run to mail-desk, and stays.
  const KENNEL_NOTE = 'why are we now showing the work repo as mykennel. we are working on the email system for plyntr'
  promptPlan = async (o) => {
    if (o.text.includes(mailDesk)) writeFileSync(join(mailDesk, 'src', 'send.ts'), 'export const send = 6\n')
  }
  for (const from of [kennel, quote]) {
    const w = ctl.startRun({ task: 'fix typo in the app label', workRepo: from, brainPath: brainA })
    const idW = w.ok ? w.run.id : ''
    await ctl.settle(idW)
    // The live prefs: lastRepo was mykennel when the note came in.
    resolver.rememberRepo(kennel)
    const noted = ctl.guideRun(idW, KENNEL_NOTE)
    const rW = await ctl.settle(idW)
    ctl.dropMemory()
    const back = ctl.restoreRun(idW)
    check(
      `WR 1 from ${from === kennel ? 'mykennel' : 'quote-deploy'}: the mykennel complaint moves to mail-desk, not mykennel, and stays after the turn and a restore`,
      same(noted.workRepo, mailDesk) && same(rW?.workRepo, mailDesk) && holds(mailDesk, idW) && !holds(kennel, idW) && same(back?.workRepo, mailDesk) && (rW?.audit?.work || []).some((r) => r.path === 'src/send.ts'),
      JSON.stringify({ noted: noted.workRepo, now: rW?.workRepo, back: back?.workRepo, phase: rW?.phase, error: rW?.error })
    )
    if (idW) ctl.abandonRun(idW)
    cleanMail()
  }

  // WR 1 restore: a 0.1.84 run on mykennel with the note already stored (never read) moves to mail-desk when the app restores it.
  promptPlan = async () => {}
  const old = ctl.startRun({ task: 'fix typo in the app label', workRepo: kennel, brainPath: brainA })
  const idO = old.ok ? old.run.id : ''
  const rO = await ctl.settle(idO)
  resolver.rememberRepo(kennel)
  if (rO) store.saveRun({ ...rO, guide: [{ at: Date.now(), text: KENNEL_NOTE, sent: true }] })
  ctl.dropMemory()
  const restored = ctl.restoreRun(idO)
  check(
    'WR 1 restoreRun reconciles: the stored note moves the paused run to mail-desk without a Guide',
    same(restored?.workRepo, mailDesk) && restored?.phase === 'paused' && holds(mailDesk, idO) && !holds(kennel, idO),
    JSON.stringify({ now: restored?.workRepo, phase: restored?.phase, error: restored?.error })
  )
  if (idO) ctl.abandonRun(idO)

  // Stuck pin: a sent "grok exited" note on simplerealign does not hold the run. A question names both folders.
  // An add-to-the-run sentence stays unsent while paused. Resume takes the task's repo and the uncommitted file, no builder.
  // These folders are created here and removed after, so "Plyntr" in earlier and later tasks still means mail-desk.
  {
    const simpleRepo = repo('projects/simplerealign', { 'package.json': pkg, 'src/page.ts': 'export const page = 1\n' })
    const configRepo = repo('projects/plyntr-configurator', { 'package.json': pkg, 'src/ridge.ts': 'export const ridge = 1\n' })
    promptPlan = async () => {}
    const pin = ctl.startRun({ task: 'fix typo in the app label', workRepo: simpleRepo, brainPath: brainA })
    const idP = pin.ok ? pin.run.id : ''
    const parked = await ctl.settle(idP)
    const live = ctl.getRun(idP)
    if (live) {
      live.task = `Fix the ridge in ${configRepo}`
      live.guide = [...(live.guide || []), { at: Date.now(), text: 'give me a simple rundown of where the factory stopped', sent: true, ack: 'grok exited 1', repo: simpleRepo }]
      store.saveRun(live)
    }
    const asked = await conductor.conduct(idP, 'what is going on with this run')
    const askNote = asked.guide?.find((g) => g.text === 'what is going on with this run')
    check(
      'PIN a question names the folder it is looking in and the folder the task names',
      parked?.phase === 'paused' && asked.phase === 'paused' && same(asked.workRepo, simpleRepo) && askNote?.ask === true && askNote.repo === '' && (askNote.ack || '').includes(simpleRepo) && (askNote.ack || '').includes(configRepo),
      JSON.stringify({ phase: asked.phase, repo: asked.workRepo, ack: askNote?.ack })
    )
    const gen = ctl.factoryGen(idP)
    const pAsk = promptCount()
    const filed = await conductor.conduct(idP, 'we forgot the soffit, add this to the plan')
    const soffit = filed.guide?.find((g) => g.text.includes('soffit'))
    check(
      'PIN add-to-the-run on a paused run stays paused, unsent, and on simplerealign',
      filed.phase === 'paused' && ctl.factoryGen(idP) === gen && promptCount() === pAsk && soffit?.sent === false && soffit?.repo === '' && /Filed with the plan/.test(soffit?.ack || '') && same(filed.workRepo, simpleRepo),
      JSON.stringify({ phase: filed.phase, sent: soffit?.sent, repo: soffit?.repo, ack: soffit?.ack, work: filed.workRepo })
    )
    writeFileSync(join(configRepo, 'src', 'soffit.ts'), 'export const soffit = 1\n')
    claudeSays(['GAPS: 0\nPASS'])
    const pResume = promptCount()
    ctl.resumeRun(idP)
    const moved = await ctl.settle(idP)
    check(
      'PIN resume drops the stuck repo, keeps the uncommitted file, and does not start a builder',
      promptCount() === pResume && same(moved?.workRepo, configRepo) && (moved?.audit?.work || []).some((row) => row.path === 'src/soffit.ts') && (moved?.phase === 'review' || moved?.phase === 'verify' || moved?.phase === 'done'),
      JSON.stringify({ phase: moved?.phase, repo: moved?.workRepo, prompts: promptCount() - pResume, work: moved?.audit?.work, error: moved?.error })
    )
    if (idP) ctl.abandonRun(idP)
    rmSync(simpleRepo, { recursive: true, force: true })
    rmSync(configRepo, { recursive: true, force: true })
    promptPlan = async () => {}
  }

  // WR 1 restore dirty: a run saved mid-plan comes back paused; the dirty mail-desk it moves to waits on Commit/Stash first.
  writeFileSync(join(mailDesk, 'wip.txt'), 'wip\n')
  const oldD = ctl.startRun({ task: 'fix typo in the app label', workRepo: kennel, brainPath: brainA })
  const idOD = oldD.ok ? oldD.run.id : ''
  const rOD = await ctl.settle(idOD)
  resolver.rememberRepo(kennel)
  if (rOD) store.saveRun({ ...rOD, phase: 'plan', resumePhase: 'plan', diff: undefined, audit: undefined, error: undefined, guide: [{ at: Date.now(), text: KENNEL_NOTE, sent: true }] })
  ctl.dropMemory()
  const pOD = promptCount()
  const restoredD = ctl.restoreRun(idOD)
  const rOD2 = await ctl.settle(idOD)
  check(
    'WR 1 restore mid-plan into a dirty mail-desk shows Commit first or Stash first',
    same(restoredD?.workRepo, mailDesk) && restoredD?.needsPrep === 'dirty' && (restoredD?.dirtyFiles || []).includes('wip.txt') && holds(mailDesk, idOD) && !holds(kennel, idOD) && promptCount() === pOD && rOD2?.needsPrep === 'dirty' && existsSync(join(mailDesk, 'wip.txt')),
    JSON.stringify({ now: restoredD?.workRepo, phase: restoredD?.phase, prep: restoredD?.needsPrep, files: restoredD?.dirtyFiles, prompts: promptCount() - pOD })
  )
  if (idOD) ctl.abandonRun(idOD)
  cleanMail()

  // WR 2: "mail desk" (two words) from quote-deploy lands on mail-desk.
  const wr2 = ctl.startRun({ task: 'fix typo in the app label', workRepo: quote, brainPath: brainA })
  const id2 = wr2.ok ? wr2.run.id : ''
  await ctl.settle(id2)
  const g2 = ctl.guideRun(id2, 'this is not gutter iq this is the mail desk for plyntr')
  const r2 = await ctl.settle(id2)
  check('WR 2 "the mail desk for plyntr" from quote-deploy moves to mail-desk', same(g2.workRepo, mailDesk) && same(r2?.workRepo, mailDesk) && holds(mailDesk, id2) && !holds(gutterIq, id2), JSON.stringify({ now: r2?.workRepo, error: r2?.error }))
  if (id2) ctl.abandonRun(id2)
  cleanMail()

  // VF 1: npm test is red on a file this turn never touched (square-tax): not failed, the run goes on to review.
  const run0 = fakeDeps.runScript
  let testTail = ''
  fakeDeps.runScript = async (_r, script) => {
    scriptRuns.push(script)
    return script === 'test' ? { code: 1, out: testTail } : { code: 0, out: 'ok' }
  }
  ctl.configureFactory(fakeDeps)
  promptPlan = async (o) => {
    if (/Role: self-check/.test(o.text)) return
    writeFileSync(join(mailDesk, 'src', 'send.ts'), 'export const send = "API error: try again"\n')
  }
  claudeSays(['GAPS: 0\nPASS'])
  testTail = 'ok 1645 tests\nnot ok 1 - tests/square-tax.test.js\n  ReferenceError: resolveSquareTaxForInvoice is not defined'
  const pV = promptCount()
  const vf = ctl.startRun({ task: 'fix the API error message in the email send', workRepo: mailDesk, brainPath: brainA })
  const idV = vf.ok ? vf.run.id : ''
  const rV = await ctl.settle(idV)
  const fixV = promptsFrom(pV).filter((t) => /Phase: fix\./.test(t))
  check(
    'VF 1 a test fail naming only tests/square-tax.test.js is not failed; the fail row stays and review is reached',
    vf.ok && vf.run.tier !== 'T0' && rV?.phase !== 'failed' && (rV?.phase === 'review' || rV?.phase === 'done') && rV?.verify?.some((v) => v.script === 'test' && v.status === 'fail') === true && fixV.length === 0,
    JSON.stringify({ tier: vf.ok ? vf.run.tier : vf, phase: rV?.phase, error: rV?.error, verify: rV?.verify, fixes: fixV.length })
  )
  if (idV) ctl.abandonRun(idV)
  cleanMail()

  // VF 1b: a fail that names the changed file gets one builder fix turn, then review with the row still red. Never a loop.
  testTail = 'not ok 1 - src/send.ts\n  AssertionError: expected send'
  claudeSays(['GAPS: 0\nPASS'])
  const pV2 = promptCount()
  const cV2 = claudeRows().length
  // Approve and Ship in advance: the red row on src/send.ts still holds the diff for Joe.
  const vf2 = ctl.startRun({ task: 'fix the API error message in the email send', workRepo: mailDesk, brainPath: brainA, runThrough: true, shipThrough: true })
  const idV2 = vf2.ok ? vf2.run.id : ''
  const rV2 = await ctl.settle(idV2)
  const fixV2 = promptsFrom(pV2).filter((t) => /Phase: fix\./.test(t) && t.includes('Verify failed: npm run test'))
  const strictV2 = claudeRows().slice(cV2).map((c) => c.argv[c.argv.indexOf('-p') + 1] || '').filter((t) => t.includes('strict code review'))
  check(
    'VF 1b a fail naming src/send.ts gets one auto fix turn with the verify note, then review (not failed)',
    rV2?.phase === 'review' && fixV2.length === 1 && rV2?.verify?.some((v) => v.script === 'test' && v.status === 'fail') === true,
    JSON.stringify({ phase: rV2?.phase, error: rV2?.error, fixes: fixV2.length, strict: rV2?.strict?.status })
  )
  check(
    'VF 1b Approve and Ship in advance do not commit or push while the fail row names a changed file',
    !rV2?.commitSha && !rV2?.pushed && !!rV2?.diff,
    JSON.stringify({ phase: rV2?.phase, commit: rV2?.commitSha, pushed: rV2?.pushed })
  )
  check(
    'VF 1b the Opus strict prompt carries the red verify row',
    rV2?.strict?.status !== 'pass' || strictV2.some((t) => /npm run test: fail\nnot ok 1 - src\/send\.ts/.test(t)),
    JSON.stringify({ tier: rV2?.tier, strict: rV2?.strict?.status, prompts: strictV2.length })
  )
  if (idV2) ctl.abandonRun(idV2)
  cleanMail()
  fakeDeps.runScript = run0
  ctl.configureFactory(fakeDeps)
  promptPlan = async () => {}

  // ---- 0.1.89: notes never pick a repo from README/package.json words; empty turns heal; OUTSIDE; pushWarn ----
  const REAL_NOTES = [
    "there's one thing that im also thinking about that should be added into this email system. sometimes there are multiple recent threads that have to do with each other and would inform a response to the email. can we have the system do a scan and if it finds related threads to make sure it understands at least the basics and whether that informs the current email response it is working on?",
    'have a opus 5.5 medium fix and then another independent opus medium review until approval is possible. and obviously our voice check must approve as well',
    "I'm not sure what is going on but have Opus 5.5 medium fix whatever needs to be fixed and then have it review it and approve it and get this. I don't know why we keep failing"
  ]
  const lastWarm = (from: number) => calls.slice(from).filter((c) => c.fn === 'warm').map((c) => String(c.o?.workRepo)).pop()
  const tabOf = (id: string) => `factory-${id}`
  promptPlan = async () => {}

  // HJ 1 (run-8b221dd4): the three real notes, on a run in mail-desk, stay in mail-desk.
  {
    const h = ctl.startRun({ task: 'fix typo in the app label', workRepo: mailDesk, brainPath: brainA })
    const idH = h.ok ? h.run.id : ''
    await ctl.settle(idH)
    resolver.rememberRepo(mailDesk)
    const hops: string[] = []
    let w = calls.length
    for (const note of REAL_NOTES) {
      w = calls.length
      const g = ctl.guideRun(idH, note)
      const r = await ctl.settle(idH)
      hops.push(`${g.workRepo}|${r?.workRepo}`)
    }
    const rH = store.loadRun(idH)
    check(
      'HJ 1 the three real run-8b221dd4 notes keep the run on mail-desk (no README or package.json word picks a repo)',
      same(rH?.workRepo, mailDesk) && holds(mailDesk, idH) && !holds(aiResp, idH) && hops.every((x) => x.split('|').every((p) => same(p, mailDesk))) && (lastWarm(w) === undefined || same(lastWarm(w), mailDesk)),
      JSON.stringify({ hops, now: rH?.workRepo })
    )
    if (idH) ctl.abandonRun(idH)
  }

  // HJ 3: a task (not a note) still resolves by README and by package.json words on its first turn.
  for (const [task, want, label] of [
    ['wire the dogfood harness', sliceDesk, 'README'],
    ['update the rosterbot screen', rosterRepo, 'package.json']
  ] as const) {
    const t = ctl.startRun({ task, workRepo: quote, brainPath: brainA })
    const idT3 = t.ok ? t.run.id : ''
    const r = await ctl.settle(idT3)
    check(`HJ 3 a task whose only hit is a ${label} word moves off the quote repo to it`, same(r?.workRepo, want) && holds(want, idT3), JSON.stringify({ now: r?.workRepo, error: r?.error }))
    if (idT3) ctl.abandonRun(idT3)
  }

  // EH 1: run starts on mail-desk; mail-desk HEAD then moves; a path note sends the run to quote; the builder
  // writes mail-desk only. The run heals back: stored base, lock, warm, no retry prompt; a later note stays.
  {
    const e = ctl.startRun({ task: 'fix typo in the app label', workRepo: mailDesk, brainPath: brainA })
    const idE1 = e.ok ? e.run.id : ''
    const base0 = e.ok ? e.run.base : ''
    await ctl.settle(idE1)
    writeFileSync(join(mailDesk, 'CHANGELOG.md'), 'moved head\n')
    git(mailDesk, ['add', 'CHANGELOG.md'])
    git(mailDesk, ['commit', '-q', '-m', 'advance head'])
    promptPlan = async (o) => {
      if (o.tabId === tabOf(idE1)) writeFileSync(join(mailDesk, 'src', 'send.ts'), 'export const send = 11\n')
    }
    const p0 = promptCount()
    const w0 = calls.length
    const moved = ctl.guideRun(idE1, `Work in ${quote} now`)
    const r = await ctl.settle(idE1)
    const turns = promptsFrom(p0)
    check(
      'EH 1 empty turn in quote heals back to mail-desk with the stored base, lock, audit, moved line, and no retry',
      same(moved.workRepo, quote) && same(r?.workRepo, mailDesk) && r?.base === base0 && base0 !== head(mailDesk) && holds(mailDesk, idE1) && !holds(quote, idE1) &&
        (r?.audit?.work || []).some((x) => x.path === 'src/send.ts') && /Moved back to mail-desk/.test(r?.moved || '') && turns.length === 1 && !turns.some((t) => /changed no files/.test(t)),
      JSON.stringify({ moved: moved.workRepo, now: r?.workRepo, base: r?.base, base0, phase: r?.phase, error: r?.error, turns: turns.length, m: r?.moved })
    )
    promptPlan = async () => {}
    // Base is the stored one, so the fixture's CHANGELOG commit counts too: a T0 trips to the tier card.
    if (r?.phase === 'upgrade') {
      ctl.decideRun(idE1, 'upgrade')
      await ctl.settle(idE1)
    }
    const gS = ctl.guideRun(idE1, 'make it shorter')
    const r2 = await ctl.settle(idE1)
    const dbg = { mid: r?.phase, gs: gS.phase, after: r2?.phase, err: r2?.error }
    // The heal sets warm=false: the builder's next warm (self-check or this note's turn) is in mail-desk.
    check('EH 1 after a heal, a note with no repo words stays on mail-desk, the builder re-warms there, and the moved line clears', same(r2?.workRepo, mailDesk) && holds(mailDesk, idE1) && same(lastWarm(w0), mailDesk) && !r2?.moved, JSON.stringify({ now: r2?.workRepo, warm: lastWarm(w0), dbg }))
    if (idE1) ctl.abandonRun(idE1)
    cleanMail()
  }

  // EH 1b: mail-desk already dirty (after Start); the turn changes that same file's bytes only -> heals.
  {
    const e = ctl.startRun({ task: 'fix typo in the app label', workRepo: mailDesk, brainPath: brainA })
    const idE = e.ok ? e.run.id : ''
    await ctl.settle(idE)
    writeFileSync(join(mailDesk, 'src', 'send.ts'), 'export const send = 12\n')
    promptPlan = async (o) => {
      if (o.tabId === tabOf(idE)) writeFileSync(join(mailDesk, 'src', 'send.ts'), 'export const send = 13\n')
    }
    ctl.guideRun(idE, `Work in ${quote} now`)
    const r = await ctl.settle(idE)
    check('EH 1b an already-dirty file whose bytes change during the turn heals back to mail-desk', same(r?.workRepo, mailDesk) && holds(mailDesk, idE), JSON.stringify({ now: r?.workRepo, phase: r?.phase, error: r?.error }))
    promptPlan = async () => {}
    if (idE) ctl.abandonRun(idE)
    cleanMail()
  }

  // EH 2: dirt made after Start that the turn leaves byte-identical -> no heal; one retry, then paused.
  // EH 2b: the turn writes the brain and an unrelated repo -> no heal to either.
  for (const variant of ['EH 2', 'EH 2b'] as const) {
    const e = ctl.startRun({ task: 'fix typo in the app label', workRepo: mailDesk, brainPath: brainA })
    const idE = e.ok ? e.run.id : ''
    await ctl.settle(idE)
    writeFileSync(join(mailDesk, 'wip2.txt'), 'wip\n')
    promptPlan = async (o) => {
      if (variant === 'EH 2b' && o.tabId === tabOf(idE)) {
        writeFileSync(join(brainA, 'scratch-eh2b.txt'), String(Date.now()))
        writeFileSync(join(gutterIq, 'src', 'g.ts'), `export const g = ${Date.now()}\n`)
      }
    }
    const p0 = promptCount()
    ctl.guideRun(idE, `Work in ${quote} now`)
    const r = await ctl.settle(idE)
    const turns = promptsFrom(p0)
    check(
      `${variant} no heal: stays on quote, exactly one retry, then paused with changed no files${variant === 'EH 2b' ? ' (brain and unrelated repo writes ignored)' : ''}`,
      same(r?.workRepo, quote) && holds(quote, idE) && !r?.moved && turns.length === 2 && /changed no files/.test(turns[1] || '') && r?.phase === 'paused' && /changed no files/.test(r?.error || '') && !same(r?.workRepo, brainA),
      JSON.stringify({ now: r?.workRepo, phase: r?.phase, error: r?.error, turns: turns.length, moved: r?.moved })
    )
    promptPlan = async () => {}
    if (idE) ctl.abandonRun(idE)
    cleanMail()
    git(gutterIq, ['checkout', '-q', '--', '.'])
    try {
      execFileSync('/bin/rm', ['-f', join(brainA, 'scratch-eh2b.txt')])
    } catch {
      /* gone */
    }
  }

  // EH 4: the task names mail-desk; a path note moves quote -> mykennel before mail-desk is ever entered;
  // the builder writes mail-desk only -> heal lands on mail-desk (a task candidate, not history).
  {
    promptPlan = async () => {}
    const e = ctl.startRun({ task: 'Fix the typo in the Plyntr email footer', workRepo: quote, brainPath: brainA })
    const idE = e.ok ? e.run.id : ''
    const g = ctl.guideRun(idE, `Work in ${kennel} now`)
    await ctl.settle(idE)
    const before = store.loadRun(idE)
    const mailHead = head(mailDesk)
    promptPlan = async (o) => {
      if (o.tabId === tabOf(idE)) writeFileSync(join(mailDesk, 'src', 'send.ts'), 'export const send = 14\n')
    }
    ctl.guideRun(idE, 'keep going')
    const r = await ctl.settle(idE)
    check(
      'EH 4 a task candidate never entered: heal lands on mail-desk with base = its HEAD',
      same(g.workRepo, kennel) && !(before?.repos || []).some((x) => same(x.repo, mailDesk)) && same(r?.workRepo, mailDesk) && r?.base === mailHead && holds(mailDesk, idE) && !holds(kennel, idE),
      JSON.stringify({ g: g.workRepo, before: before?.repos, now: r?.workRepo, base: r?.base, phase: r?.phase, error: r?.error })
    )
    promptPlan = async () => {}
    if (idE) ctl.abandonRun(idE)
    cleanMail()
  }

  // EH 3: another run holds mail-desk: no heal, exactly one retry, then paused; locks unchanged.
  {
    const b = ctl.startRun({ task: 'fix typo in the app label', workRepo: mailDesk, brainPath: brainA })
    const idB3 = b.ok ? b.run.id : ''
    await ctl.settle(idB3)
    ctl.guideRun(idB3, `Work in ${quote} now`)
    await ctl.settle(idB3)
    const a = ctl.startRun({ task: 'fix typo in the app label', workRepo: mailDesk, brainPath: brainA })
    const idA3 = a.ok ? a.run.id : ''
    await ctl.settle(idA3)
    promptPlan = async (o) => {
      if (o.tabId === tabOf(idB3)) writeFileSync(join(mailDesk, 'src', 'send.ts'), `export const send = ${Date.now()}\n`)
    }
    const p0 = calls.filter((c) => c.fn === 'prompt' && c.o?.tabId === tabOf(idB3)).length
    ctl.guideRun(idB3, 'keep going')
    const r = await ctl.settle(idB3)
    const turns = calls.filter((c) => c.fn === 'prompt' && c.o?.tabId === tabOf(idB3)).slice(p0).map((c) => String(c.o?.text))
    check(
      'EH 3 a heal onto a repo another run holds is refused: one retry, paused, locks unchanged',
      a.ok && same(r?.workRepo, quote) && holds(quote, idB3) && holds(mailDesk, idA3) && !r?.moved && turns.length === 2 && /changed no files/.test(turns[1] || '') && r?.phase === 'paused',
      JSON.stringify({ a: a.ok, now: r?.workRepo, phase: r?.phase, error: r?.error, turns: turns.length })
    )
    promptPlan = async () => {}
    if (idB3) ctl.abandonRun(idB3)
    if (idA3) ctl.abandonRun(idA3)
    cleanMail()
  }

  // F6: a run saved before 0.1.89 (no repos field) restores paused on its repo, no throw, no move.
  {
    const o = ctl.startRun({ task: 'fix typo in the app label', workRepo: mailDesk, brainPath: brainA })
    const idO6 = o.ok ? o.run.id : ''
    const r0 = await ctl.settle(idO6)
    if (r0) {
      const old = { ...r0 } as Record<string, unknown>
      delete old.repos
      delete old.pushWarn
      store.saveRun(old as never)
    }
    ctl.dropMemory()
    let threw = ''
    let back: ReturnType<typeof ctl.restoreRun> = null
    try {
      back = ctl.restoreRun(idO6)
    } catch (err) {
      threw = String(err)
    }
    check('F6 a run with no repos field restores paused on mail-desk with no throw and no move', !threw && same(back?.workRepo, mailDesk) && back?.phase === 'paused' && holds(mailDesk, idO6) && !back?.moved, JSON.stringify({ threw, now: back?.workRepo, phase: back?.phase }))
    if (idO6) ctl.abandonRun(idO6)
  }

  // RV 1-3: OUTSIDE items become follow-ups, never gaps; a later FAIL still fails; follow-ups clear with strict.
  {
    promptPlan = async (o) => {
      if (/Role: self-check/.test(o.text)) return
      writeFileSync(join(mailDesk, 'src', 'send.ts'), `export const send = "API error: ${Date.now()}"\n`)
    }
    claudeSays(['a.ts is fine.\nOUTSIDE:\n- Split into separate changes\n- A follow-up to run real threads before/after\nGAPS: 0\nPASS'])
    const v = ctl.startRun({ task: 'fix the API error message in the email send', workRepo: mailDesk, brainPath: brainA })
    const idR = v.ok ? v.run.id : ''
    const r1 = await ctl.settle(idR)
    check(
      'RV 1 OUTSIDE bullets (one says follow-up) are follow-ups; GAPS: 0 PASS still passes; strict.text has no bullet',
      r1?.strict?.status === 'pass' && r1.followUps?.length === 2 && !/Split into|follow-up to run/.test(r1.strict.text),
      JSON.stringify({ strict: r1?.strict, followUps: r1?.followUps, phase: r1?.phase })
    )
    // RV 3a: the next fix turn clears follow-ups at once, with strict. RV 2 / 2b: what each fix turn is handed.
    const handed: string[] = []
    promptPlan = async (o) => {
      if (/Role: self-check/.test(o.text)) return
      if (/Phase: fix\./.test(o.text) && existsSync(store.runTextPath(idR, 'review'))) handed.push(readFileSync(store.runTextPath(idR, 'review'), 'utf8'))
      writeFileSync(join(mailDesk, 'src', 'send.ts'), `export const send = "API error: ${Date.now()}"\n`)
    }
    const cyc0 = r1?.reviewCycles || 0
    claudeSays([
      'a.ts:3 off by one\nOUTSIDE:\n- Get sign-off on the flow\nb.ts:9 missing null check\nGAPS: 1\nFAIL',
      'OUTSIDE:\n- Split changes\nGAPS: 0\nPASS\nnit: rename x\nGAPS: 1\nFAIL',
      'GAPS: 0\nPASS'
    ])
    const g = ctl.guideRun(idR, 'tighten the error wording')
    check('RV 3 a new fix turn clears followUps the moment strict clears', !g.strict && !g.followUps, JSON.stringify({ strict: g.strict, followUps: g.followUps }))
    const r2 = await ctl.settle(idR)
    const [h1 = '', h2 = ''] = handed
    check(
      'RV 2 the fix turn after a FAIL is handed both defects and GAPS: 1, never the OUTSIDE bullet',
      h1.includes('a.ts:3 off by one') && h1.includes('b.ts:9 missing null check') && /GAPS: 1/.test(h1) && !h1.includes('sign-off on the flow'),
      JSON.stringify({ handed: handed.length, h1: h1.slice(0, 300) })
    )
    check(
      'RV 2b a GAPS/PASS line ends the block: the later nit and FAIL count (a fail and a fix turn), the bullet is gone',
      (r2?.reviewCycles || 0) - cyc0 === 2 && h2.includes('nit: rename x') && /GAPS: 1\s*\nFAIL/.test(h2) && !h2.includes('Split changes') && r2?.strict?.status === 'pass' && !r2.followUps,
      JSON.stringify({ cycles: (r2?.reviewCycles || 0) - cyc0, strict: r2?.strict?.status, h2: h2.slice(0, 300), followUps: r2?.followUps })
    )
    // RV 2c: a blank line after the bullets ends the block: a `- nit:` bullet under GAPS: 0 PASS still fails.
    const cyc1 = r2?.reviewCycles || 0
    claudeSays(['OUTSIDE:\n- Split changes\n\n- nit: rename x\nGAPS: 0\nPASS', 'GAPS: 0\nPASS'])
    ctl.guideRun(idR, 'reword once more')
    const r2c = await ctl.settle(idR)
    // From review 3 on Opus makes the fix (no promptPlan), so read what was saved for it; a pass never overwrites it.
    const h3 = existsSync(store.runTextPath(idR, 'review')) ? readFileSync(store.runTextPath(idR, 'review'), 'utf8') : ''
    check(
      'RV 2c a defect bullet after a blank line is a gap, not a follow-up: one fail, the saved review for the fix names the nit',
      (r2c?.reviewCycles || 0) - cyc1 === 1 && h3.includes('- nit: rename x') && !h3.includes('Split changes') && r2c?.strict?.status === 'pass',
      JSON.stringify({ cycles: (r2c?.reviewCycles || 0) - cyc1, h3: h3.slice(0, 200), strict: r2c?.strict?.status })
    )
    // RV 3b: no reviewer at all -> followUps empty.
    execFileSync('/bin/rm', ['-f', claudeBin])
    claudeSays([])
    ctl.guideRun(idR, 'one more pass')
    const r3 = await ctl.settle(idR)
    check('RV 3 a missing reviewer leaves no follow-ups', r3?.strict?.status === 'missing' && !r3.followUps, JSON.stringify({ strict: r3?.strict?.status, followUps: r3?.followUps }))
    installClaude()
    promptPlan = async () => {}
    if (idR) ctl.abandonRun(idR)
    cleanMail()
  }

  // PW 1-5: pushWarn names the real remote and branch, from Start and after a move.
  {
    const noRemote = repo('projects/pw-local', { 'package.json': pkg, 'src/p.ts': 'export const p = 1\n' })
    const pwBare = join(temp, 'pw-origin.git')
    mkdirSync(pwBare)
    git(pwBare, ['init', '-q', '--bare', '-b', 'main'])
    const onMain = repo('projects/pw-main', { 'package.json': pkg, 'src/p.ts': 'export const p = 1\n' })
    git(onMain, ['remote', 'add', 'origin', pwBare])
    const onFeature = repo('projects/pw-feature', { 'package.json': pkg, 'src/p.ts': 'export const p = 1\n' })
    git(onFeature, ['remote', 'add', 'origin', pwBare])
    git(onFeature, ['checkout', '-q', '-b', 'factory/x'])
    const onMaster = repo('projects/pw-master', { 'package.json': pkg, 'src/p.ts': 'export const p = 1\n' })
    git(onMaster, ['checkout', '-q', '-b', 'master'])
    git(onMaster, ['remote', 'add', 'upstream', pwBare])
    const warnOf = (workRepo: string, shipThrough: boolean) => {
      const s0 = ctl.startRun({ task: 'fix typo in the app label', workRepo, brainPath: brainA, shipThrough })
      const w = s0.ok ? s0.run.pushWarn : `start failed: ${s0.error}`
      if (s0.ok) ctl.abandonRun(s0.run.id)
      return w
    }
    const w1 = warnOf(noRemote, false)
    const w2 = warnOf(onMain, true)
    const w3 = warnOf(onMain, false)
    const w5 = warnOf(onFeature, true)
    profiles.saveProfile(onMaster, { publish: { remote: 'upstream' } })
    const w4a = warnOf(onMaster, true)
    git(onMaster, ['remote', 'rename', 'upstream', 'origin'])
    const w4b = warnOf(onMaster, true)
    check('PW 1 no remote: says so and names origin', w1 === 'No remote named origin. Factory commits here but cannot push.', String(w1))
    check('PW 2 Ship in advance on main with a remote: no warning (main pushes)', w2 === undefined, String(w2))
    check('PW 3 no Ship in advance on main: no warning', w3 === undefined, String(w3))
    check('PW 4 remote upstream on master: no warning (master pushes); with only origin, no remote named upstream', w4a === undefined && w4b === 'No remote named upstream. Factory commits here but cannot push.', JSON.stringify({ w4a, w4b }))
    check('PW 5 feature branch with a remote: no warning', w5 === undefined, String(w5))
    // A move from the no-remote repo onto the feature branch repo clears the line.
    const m = ctl.startRun({ task: 'fix typo in the app label', workRepo: noRemote, brainPath: brainA })
    const idM = m.ok ? m.run.id : ''
    await ctl.settle(idM)
    const mv = ctl.guideRun(idM, `Work in ${onFeature} now`)
    await ctl.settle(idM)
    check('PW 5 a move onto a repo that can push clears pushWarn', m.ok && !!m.run.pushWarn && same(mv.workRepo, onFeature) && !mv.pushWarn, JSON.stringify({ start: m.ok ? m.run.pushWarn : m, after: mv.pushWarn, now: mv.workRepo }))
    if (idM) ctl.abandonRun(idM)
  }

  // Card: the pane renders the three new lines inside the existing card.
  {
    const pane = readFileSync(join(rootRepo, 'src', 'renderer', 'src', 'FactoryPane.tsx'), 'utf8')
    check('PANE 0.1.89 renders run.pushWarn, run.moved, and Follow-ups outside this change', /\{run\.pushWarn\}/.test(pane) && /\{run\.moved\}/.test(pane) && pane.includes('Follow-ups outside this change') && /run\.followUps\.map/.test(pane))
  }

  fakeDeps.projectsDir = undefined
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

// ---- Factory evals pass (plans/20260929-factory-evals-build.md): usage, code stays home, brain log, shadow ----
const opusMod = (await import(src('factory/opus.ts'))) as typeof import('../src/main/factory/opus.ts')
const tllm = (await import(src('factory/triage-llm.ts'))) as typeof import('../src/main/factory/triage-llm.ts')
const shadowMod = (await import(src('factory/shadow.ts'))) as typeof import('../src/main/factory/shadow.ts')
const brainLog = (await import(src('factory/brain-log.ts'))) as typeof import('../src/main/factory/brain-log.ts')
{
  const brainEv = repo('brain-ev', { 'AGENTS.md': '# Brain EV\n' })
  const EVTASK = 'fix the API error message'
  const commonDir = (r: string) => git(r, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  const storeOf = (r: string, id: string) => join(commonDir(r), 'brain-factory', id)
  const filesUnder = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])) : []
  const hits = (dir: string, needle: string) => filesUnder(dir).filter((f) => readFileSync(f, 'utf8').includes(needle))
  const evPkg = JSON.stringify({ name: 'ev', private: true, scripts: { typecheck: 'x', test: 'x' } })
  const evRepo = (name: string) => repo(name, { 'package.json': evPkg, 'src/a.ts': 'export const a = 0\n' })
  const clean = (r: string) => {
    git(r, ['checkout', '-q', '--', '.'])
    git(r, ['clean', '-qfd'])
  }
  let acpUsage: { model?: string; effort?: string; usage?: Record<string, unknown> | null } | null = null
  let evScript: ((script: string) => { code: number; out: string } | null) | null = null
  const basePrompt = fakeDeps.driver.prompt
  const baseScript = fakeDeps.runScript
  const evDeps: typeof fakeDeps = {
    ...fakeDeps,
    driver: {
      ...fakeDeps.driver,
      prompt: async (o) => {
        if (acpUsage) o.onUsage?.(acpUsage)
        return basePrompt(o)
      }
    },
    runScript: async (r, script, env) => evScript?.(script) || (baseScript ? baseScript(r, script, env) : { code: 0, out: 'ok' }),
    publish: async (r, t) => gates.publish(r, t)
  }
  const use = (over: Partial<typeof fakeDeps> = {}) => ctl.configureFactory({ ...evDeps, ...over })
  use()
  const writer = (r: string, mark = 'CODEMARK_DIFF') => {
    let n = 0
    promptPlan = async (o) => {
      if (/Phase: (build|fix)\./.test(o.text)) {
        writeFileSync(join(r, 'src', 'a.ts'), `export const a = ${++n} // ${mark}\n`)
        writeFileSync(join(r, 'NOTES.md'), `Release note ${n}\n`)
      }
    }
  }
  const evStart = async (r: string, says: string[], o: { through?: boolean; ship?: boolean; task?: string } = {}) => {
    claudeSays(says)
    const res = ctl.startRun({ task: o.task || EVTASK, workRepo: r, brainPath: brainEv, runThrough: !!o.through, shipThrough: !!o.ship })
    const id = res.ok ? res.run.id : ''
    return { id, r: await ctl.settle(id), res }
  }
  const reviewRows = (run: Awaited<ReturnType<typeof ctl.settle>>) => (run?.usage || []).filter((u) => u.phase === 'review')

  // a. JSON verdicts and usage rows.
  const evA = evRepo('ev-a')
  writer(evA)
  {
    const { r } = await evStart(evA, ['Checked.\nGAPS: 0\nPASS'], { through: true })
    const rv = (r?.usage || []).find((u) => u.phase === 'review')
    const tr = (r?.usage || []).find((u) => u.phase === 'triage')
    check('EV a full JSON envelope PASS commits; row ok with served model and counts', r?.phase === 'done' && !!r.commitSha && rv?.ok === true && rv.model === 'claude-fake-served' && rv.inTokens === 111 && rv.cacheRead === 3333 && rv.cli === 'claude', JSON.stringify({ phase: r?.phase, rv }))
    check('EV a triage row is written when grok is missing (ok false, no model)', tr?.ok === false && tr.model === '' && tr.cli === 'grok', JSON.stringify(tr))
  }
  {
    const { r } = await evStart(evA, ['@@pad:500000:GAPS: 0\nPASS'], { through: true })
    check('EV a 500k result (over the old 400k slice, under the cap) still commits', r?.phase === 'done' && !!r.commitSha && reviewRows(r)[0]?.ok === true, JSON.stringify({ phase: r?.phase, rows: reviewRows(r) }))
  }
  {
    use({ opusMax: 100_000 })
    const p0 = promptCount()
    const { r } = await evStart(evA, ['@@pad:500000:GAPS: 0\nPASS', 'GAPS: 0\nPASS'], { through: true })
    const fix = promptsFrom(p0).find((t) => /Phase: fix\./.test(t)) || ''
    const rows = reviewRows(r)
    check('EV a over the cap: NO_VERDICT, a fix turn, ok false, commit only after the next clean review', rows.length === 2 && rows[0].ok === false && rows[1].ok === true && /did not end with PASS or FAIL/.test(fix) && r?.reviewCycles === 1 && r?.phase === 'done', JSON.stringify({ rows, cycles: r?.reviewCycles, phase: r?.phase }))
    use()
  }
  {
    const { r } = await evStart(evA, ['Bug at src/a.ts:1\nGAPS: 2\nFAIL', 'GAPS: 0\nPASS'], { through: true })
    const rows = reviewRows(r)
    check('EV a FAIL inside result starts a fix turn, no commit on it', rows.length === 2 && rows[0].ok === true && r?.reviewCycles === 1 && r?.phase === 'done', JSON.stringify({ rows, cycles: r?.reviewCycles }))
  }
  {
    use({ opusTimeoutMs: 1500 })
    const { r } = await evStart(evA, ['@@raw:GAPS: 0\nPASS', '@@sleep:4000', '@@exit:3:GAPS: 0\nPASS', 'GAPS: 0\nPASS'], { through: true })
    const rows = reviewRows(r)
    const opusBuild = (r?.usage || []).filter((u) => u.phase === 'build' && u.cli === 'claude')
    check('EV a plain stdout ending PASS is NO_VERDICT (row ok false)', rows[0]?.ok === false && rows[0].model === '', JSON.stringify(rows[0]))
    check('EV a timeout leaves a row: ok false, ms at the timeout, no model', rows[1]?.ok === false && rows[1].ms >= 1400 && rows[1].ms < 4000 && rows[1].model === '', JSON.stringify(rows[1]))
    check('EV a exit 3 leaves a row: ok false, no model', rows[2]?.ok === false && rows[2].model === '', JSON.stringify(rows[2]))
    check('EV a the run commits only after the clean fourth review', rows.length === 4 && rows[3].ok === true && r?.phase === 'done' && r.reviewCycles === 3, JSON.stringify({ n: rows.length, phase: r?.phase, cycles: r?.reviewCycles }))
    check('EV a the Opus builder turn leaves a claude build row', opusBuild.length >= 1 && opusBuild.every((u) => u.ok && u.model === 'claude-fake-served'), JSON.stringify(opusBuild))
    use()
  }
  {
    use({ claudeBin: () => join(temp, 'no-such-claude') })
    const { id, r } = await evStart(evA, [], { through: true })
    const rv = reviewRows(r)[0]
    check('EV a missing claude leaves a row: ok false, no model; no commit', r?.strict?.status === 'missing' && !r.commitSha && rv?.ok === false && rv.model === '', JSON.stringify({ strict: r?.strict?.status, rv }))
    ctl.abandonRun(id)
    clean(evA)
    use()
  }
  {
    const fakeGrok = join(temp, 'fake-grok-triage')
    writeFileSync(
      fakeGrok,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'text', data: JSON.stringify({ size: 'T1', risk: 'elevated', reason: 'fake' }) }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'end', stopReason: 'end_turn', usage: { input_tokens: 21, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, reasoning_tokens: 2 }, num_turns: 1, total_cost_usd: 0.001, modelUsage: { 'grok-fake-served': { costUSD: 0.001 } } }) + '\\n')
`
    )
    chmodSync(fakeGrok, 0o755)
    triageBin = fakeGrok
    acpUsage = { model: 'grok-acp-fake', effort: 'high', usage: { input_tokens: 50, output_tokens: 5 } }
    const { r } = await evStart(evA, ['GAPS: 0\nPASS'], { through: true })
    restoreEcho()
    acpUsage = null
    const tr = (r?.usage || []).find((u) => u.phase === 'triage')
    const builds = (r?.usage || []).filter((u) => u.phase === 'build' && u.cli === 'grok')
    check('EV a triage row carries the model from the grok end event', tr?.ok === true && tr.model === 'grok-fake-served' && tr.inTokens === 21 && tr.outTokens === 5, JSON.stringify(tr))
    check('EV a ACP build row has tokens and model when the turn reports usage', builds.length >= 1 && builds.every((u) => u.inTokens === 50 && u.model === 'grok-acp-fake' && u.turns === 1 && u.effort === 'high'), JSON.stringify(builds))
    const { r: r2 } = await evStart(evA, ['GAPS: 0\nPASS'], { through: true })
    const b2 = (r2?.usage || []).filter((u) => u.phase === 'build' && u.cli === 'grok')
    check('EV a ACP build row has ms and turns, 0 tokens, when the turn reports none', b2.length >= 1 && b2.every((u) => u.inTokens === 0 && u.outTokens === 0 && u.turns === 1 && u.ms >= 0 && u.ok), JSON.stringify(b2))
  }

  // b. Code stays home: every code-bearing field lands in the repo store and never in userData.
  const evB = evRepo('ev-b')
  const evBbare = join(temp, 'ev-b-origin.git')
  mkdirSync(evBbare)
  git(evBbare, ['init', '-q', '--bare', '-b', 'main'])
  git(evB, ['remote', 'add', 'origin', evBbare])
  git(evB, ['checkout', '-q', '-b', 'factory/ev-b'])
  let bId = ''
  {
    profiles.saveProfile(evB, { voice: { on: true } })
    voiceCode = 2
    voiceText = 'REJECT: CODEMARK_VOICE reads like an ad\n'
    let testCalls = 0
    evScript = (script) => {
      if (script === 'typecheck') return { code: 1, out: 'other/file.ts: CODEMARK_TAIL2 broken next door' }
      if (script === 'test' && ++testCalls === 1) return { code: 1, out: 'FAIL src/a.ts:1 CODEMARK_TAIL' }
      return null
    }
    const snaps: { phase: string; leak: number; stored: number; mark: string }[] = []
    let n = 0
    promptPlan = async (o) => {
      if (/Phase: fix\./.test(o.text) && bId) {
        const mark = o.text.includes('CODEMARK_TAIL') ? 'CODEMARK_TAIL' : 'CODEMARK_STRICT'
        snaps.push({ phase: 'fix', mark, leak: hits(userData, mark).length, stored: hits(storeOf(evB, bId), mark).length })
      }
      if (/Phase: (build|fix)\./.test(o.text)) {
        writeFileSync(join(evB, 'src', 'a.ts'), `export const a = ${++n} // CODEMARK_DIFF\n`)
        writeFileSync(join(evB, 'NOTES.md'), `Release note ${n}\n`)
      }
    }
    claudeSays(['CODEMARK_STRICT at src/a.ts:1\nGAPS: 1\nFAIL', ...Array(shared.VOICE_MAX + 2).fill('GAPS: 0\nPASS')])
    const res = ctl.startRun({ task: EVTASK, workRepo: evB, brainPath: brainEv, runThrough: false, shipThrough: false })
    bId = res.ok ? res.run.id : ''
    const r = await ctl.settle(bId)
    const dir = storeOf(evB, bId)
    check('EV b fix notes carrying the verify tail and the strict text never touch userData; the repo store has them', snaps.length >= 2 && ['CODEMARK_TAIL', 'CODEMARK_STRICT'].every((m) => snaps.some((x) => x.mark === m)) && snaps.every((x) => x.leak === 0 && x.stored > 0), JSON.stringify(snaps))
    check('EV b held on the voice REJECT with diff, strict pass, unrelated red row', r?.phase === 'review' && r.voice?.status === 'fail' && !!r.diff?.includes('CODEMARK_DIFF') && r.strict?.status === 'pass' && r.verify?.some((v) => v.status === 'fail' && v.tail?.includes('CODEMARK_TAIL2')) === true, JSON.stringify({ phase: r?.phase, voice: r?.voice, strict: r?.strict?.status, diffHasNotes: r?.diff?.includes('NOTES.md') }))
    check('EV b userData has no CODEMARK after the held review', hits(userData, 'CODEMARK').length === 0, JSON.stringify(hits(userData, 'CODEMARK')))
    check('EV b repo store holds diff, voice tail, verify tail, and the strict FAIL (review.md)', ['CODEMARK_DIFF', 'CODEMARK_VOICE', 'CODEMARK_TAIL2', 'CODEMARK_STRICT'].every((m) => hits(dir, m).length > 0) && existsSync(join(dir, 'review.md')), JSON.stringify(filesUnder(dir)))
    check('EV b the repo store is inside .git and the work tree shows none of it', underPath(realish(join(evB, '.git')), realish(dir)) && !git(evB, ['status', '--porcelain', '--untracked-files=all']).includes('brain-factory'))
    evScript = null
    voiceCode = 0
    voiceText = ''
  }
  // d. Restart: every code field comes back from the repo store.
  {
    ctl.dropMemory()
    const back = ctl.restoreRun(bId)
    check('EV d restore brings back diff, voice tail, verify tail from the repo store', !!back?.diff?.includes('CODEMARK_DIFF') && !!back?.voice?.tail?.includes('CODEMARK_VOICE') && back?.verify?.some((v) => v.tail?.includes('CODEMARK_TAIL2')) === true, JSON.stringify({ diff: !!back?.diff, voice: back?.voice }))
    check('EV d a fix brief reviewPath exists on disk after restore', existsSync(store.runTextPath(bId, 'review')) && readFileSync(store.runTextPath(bId, 'review'), 'utf8').includes('CODEMARK_STRICT'))
  }
  // b (cont). Multi-line push and deploy errors.
  {
    const evP = evRepo('ev-p')
    const pbare = join(temp, 'ev-p-origin.git')
    mkdirSync(pbare)
    git(pbare, ['init', '-q', '--bare', '-b', 'main'])
    git(evP, ['remote', 'add', 'origin', pbare])
    git(evP, ['checkout', '-q', '-b', 'factory/ev-p'])
    profiles.saveProfile(evP, { deploy: { cmd: 'echo deploy' } })
    writer(evP)
    const { id } = await evStart(evP, ['GAPS: 0\nPASS'])
    ctl.commitRunNow(id, { by: 'joe' })
    use({ publish: async () => ({ ok: false, out: 'push line 1\npush line 2\nCODEMARK_PUSH rejected\n' }) })
    let r = await ctl.publishRun(id, { by: 'joe' })
    const pushErr = r.pushError || ''
    const pushLeak = hits(userData, 'CODEMARK').length
    use({ deploy: async () => ({ ok: false, out: 'deploy 1\ndeploy 2\nCODEMARK_DEPLOY failed\n' }) })
    r = await ctl.publishRun(id, { by: 'joe' })
    r = await ctl.deployRun(id)
    const dir = storeOf(evP, id)
    check('EV b multi-line pushError and deployError: line 1 in userData, full text in the repo store', pushErr.includes('CODEMARK_PUSH') && pushLeak === 0 && !!r.pushed && (r.deployError || '').includes('CODEMARK_DEPLOY') && hits(userData, 'CODEMARK').length === 0 && hits(dir, 'CODEMARK_DEPLOY').length > 0, JSON.stringify({ phase: r.phase, pushed: !!r.pushed, pushErr: pushErr.slice(0, 80), leaks: hits(userData, 'CODEMARK') }))
    use()
  }
  {
    const evErr = evRepo('ev-err')
    promptPlan = async (o) => {
      if (/Phase: build\./.test(o.text)) throw new Error('build broke\nCODEMARK_ERROR at src/a.ts:1')
    }
    const { id, r } = await evStart(evErr, [])
    check('EV b a multi-line error keeps line 1 in userData and the rest in the repo store', r?.phase === 'failed' && (r.error || '').includes('CODEMARK_ERROR') && hits(userData, 'CODEMARK').length === 0 && hits(storeOf(evErr, id), 'CODEMARK_ERROR').length > 0, JSON.stringify({ phase: r?.phase, leaks: hits(userData, 'CODEMARK') }))
    ctl.abandonRun(id)
  }
  {
    const evPlan = evRepo('ev-plan')
    const { id, r } = await evStart(evPlan, ['Plan CODEMARK_PLAN: add src/b.ts and a route.'], { task: 'Add a new page for team settings with a new route and shared types' })
    ctl.dropMemory()
    const back = ctl.restoreRun(id)
    check('EV b plan text: repo store only; restore brings it back and planPath exists', r?.phase === 'plan' && hits(userData, 'CODEMARK').length === 0 && hits(storeOf(evPlan, id), 'CODEMARK_PLAN').length > 0 && !!back?.plan?.text.includes('CODEMARK_PLAN') && existsSync(store.runTextPath(id, 'plan')), JSON.stringify({ phase: r?.phase, plan: back?.plan?.text?.slice(0, 40) }))
    ctl.abandonRun(id)
  }
  {
    const evT3 = evRepo('ev-t3')
    evScript = () => ({ code: 0, out: 'CODEMARK_VERIFYTXT all good' })
    promptPlan = async (o) => {
      const m = /Your slice (\d+) of \d+: [^.]+\. Edit only these files; other builders own the rest: (.+)/.exec(o.text)
      for (const rel of (m?.[2] || '').split(', ').map((x) => x.trim()).filter(Boolean)) writeFileSync(join(evT3, rel), `export const v = 1\n`)
    }
    t3Says([{ title: 'x', files: ['src/x.ts'] }, { title: 'y', files: ['src/y.ts'] }], 'GAPS: 0\nPASS')
    const res = ctl.startRun({ task: T3TASK, workRepo: evT3, brainPath: brainEv, runThrough: true })
    const id = res.ok ? res.run.id : ''
    const r = await ctl.settle(id)
    evScript = null
    check('EV b T3 verify.txt with the full output is in the repo store only', r?.phase === 'done' && hits(storeOf(evT3, id), 'CODEMARK_VERIFYTXT').length > 0 && hits(userData, 'CODEMARK').length === 0, JSON.stringify({ phase: r?.phase, error: r?.error }))
  }
  // c. Linked worktree work repo.
  {
    const evC = evRepo('ev-c')
    const wt = join(temp, 'ev-c-wt')
    git(evC, ['worktree', 'add', '-q', wt, '-b', 'wt'])
    writer(wt)
    const { id, r } = await evStart(wt, ['GAPS: 0\nPASS'], { through: true })
    const dir = join(commonDir(evC), 'brain-factory', id)
    check('EV c worktree: store under the common git dir, worktree clean after commit, no userData leak', r?.phase === 'done' && existsSync(join(dir, 'code.json')) && git(wt, ['status', '--porcelain', '--untracked-files=all']).trim() === '' && hits(userData, 'CODEMARK').length === 0, JSON.stringify({ phase: r?.phase, dir, files: filesUnder(dir) }))
  }
  // d (cont). A note paused mid fix comes back after restart.
  {
    const evD = evRepo('ev-d')
    let once = 0
    evScript = (script) => (script === 'test' && ++once === 1 ? { code: 1, out: 'FAIL src/a.ts:1 CODEMARK_NOTE' } : null)
    let did = ''
    let n = 0
    promptPlan = async (o) => {
      if (/Phase: fix\./.test(o.text) && did) {
        ctl.pauseRun(did)
        return
      }
      if (/Phase: build\./.test(o.text)) writeFileSync(join(evD, 'src', 'a.ts'), `export const a = ${++n}\n`)
    }
    claudeSays([])
    const res = ctl.startRun({ task: EVTASK, workRepo: evD, brainPath: brainEv })
    did = res.ok ? res.run.id : ''
    await ctl.settle(did)
    evScript = null
    const leak = hits(userData, 'CODEMARK').length
    ctl.dropMemory()
    const back = ctl.restoreRun(did)
    check('EV d a paused fix note comes back from the repo store, never in userData', back?.phase === 'paused' && !!back.note?.includes('CODEMARK_NOTE') && leak === 0, JSON.stringify({ phase: back?.phase, note: back?.note?.slice(0, 60), leak }))
    ctl.abandonRun(did)
  }
  // e. Migration of old-format runs.
  {
    const evE = evRepo('ev-e')
    const tmpl = store.loadRun(bId)
    const runsDir = join(store.factoryDir(), 'runs')
    const old = (id: string, repoPath: string) => {
      const rec = {
        ...tmpl,
        id,
        workRepo: repoPath,
        diff: '+CODEMARK_MIG_DIFF',
        note: 'CODEMARK_MIG_NOTE',
        plan: { text: 'CODEMARK_MIG_PLAN', by: 'opus', status: 'approved', rejects: 0, reasons: [] },
        strict: { status: 'fail', text: 'CODEMARK_MIG_STRICT' },
        verify: [{ script: 'test', status: 'fail', tail: 'CODEMARK_MIG_TAIL' }],
        voice: { script: 'voice', status: 'fail', tail: 'CODEMARK_MIG_VOICE' },
        error: 'line one\nCODEMARK_MIG_ERROR',
        pushError: 'push one\nCODEMARK_MIG_PUSH',
        deployError: 'deploy one\nCODEMARK_MIG_DEPLOY',
        phase: 'done'
      }
      writeFileSync(join(runsDir, `${id}.json`), JSON.stringify(rec))
      for (const k of ['plan.md', 'review.md', 'verify.txt']) writeFileSync(join(runsDir, `${id}.${k}`), `CODEMARK_MIG_FILE ${k}`)
    }
    old('run-mig-have', evE)
    const gone = join(temp, 'ev-gone')
    old('run-mig-gone', gone)
    const have = store.loadRun('run-mig-have')
    const lost = store.loadRun('run-mig-gone')
    const leftovers = readdirSync(runsDir).filter((f) => f.startsWith('run-mig-') && !f.endsWith('.json'))
    check('EV e old run with its repo: userData clean, repo store has every marker, fields come back', hits(userData, 'CODEMARK_MIG').length === 0 && hits(storeOf(evE, 'run-mig-have'), 'CODEMARK_MIG').length >= 3 && !!have?.diff?.includes('CODEMARK_MIG_DIFF') && !!have?.plan?.text.includes('CODEMARK_MIG_PLAN') && !!have?.error?.includes('CODEMARK_MIG_ERROR'), JSON.stringify({ leaks: hits(userData, 'CODEMARK_MIG'), have: !!have }))
    check('EV e old run whose repo is gone: loads, text files gone, code fields empty', !!lost && leftovers.length === 0 && lost.diff === undefined && !lost.plan?.text && !lost.strict?.text && !lost.verify?.some((v) => v.tail) && !lost.voice?.tail && lost.note === undefined && lost.error === 'line one', JSON.stringify({ leftovers, lost: lost && { diff: lost.diff, error: lost.error } }))
  }
  // f. Brain log.
  {
    mkdirSync(join(brainEv, 'clients', 'ev-f2'), { recursive: true })
    symlinkSync(tmpdir(), join(brainEv, 'escape'))
    check('EV f profile brainFolder clients/acme is used', brainLog.logFolder(brainEv, '/x/ev-f1', 'clients/acme') === join('clients', 'acme'))
    check('EV f ../evil, /tmp/x and a symlink out of the brain fall through', ['../evil', '/tmp/x', 'escape'].every((f) => brainLog.logFolder(brainEv, '/x/ev-f1', f) === join('projects', 'ev-f1')))
    check('EV f an existing clients/<repo> folder is used', brainLog.logFolder(brainEv, '/x/ev-f2') === join('clients', 'ev-f2'))
    check('EV f no folder: projects/<repo> (created on write)', brainLog.logFolder(brainEv, '/x/ev-f3') === join('projects', 'ev-f3') && !existsSync(join(brainEv, 'projects', 'ev-f3')))
    const evF = evRepo('ev-f3')
    const fbare = join(temp, 'ev-f-origin.git')
    mkdirSync(fbare)
    git(fbare, ['init', '-q', '--bare', '-b', 'main'])
    git(evF, ['remote', 'add', 'origin', fbare])
    git(evF, ['checkout', '-q', '-b', 'factory/ev-f'])
    writer(evF)
    const { id, r } = await evStart(evF, ['GAPS: 0\nPASS'])
    ctl.pauseRun(id)
    ctl.resumeRun(id)
    await ctl.settle(id)
    ctl.commitRunNow(id, { by: 'joe' })
    await ctl.settle(id)
    const pushed = await ctl.publishRun(id, { by: 'joe' })
    const logFile = join(brainEv, 'projects', 'ev-f3', 'factory-log.md')
    const body = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    check('EV f one entry per run through pause, resume, done, a second settle and a Push; it names the SHA and the push; no code', r?.phase === 'review' && body.split(`<!-- factory-run:${id} -->`).length === 2 && body.includes(String(pushed.commitSha).slice(0, 12)) && body.includes('pushed to origin/factory/ev-f') && !body.includes('CODEMARK'), body.slice(-600))
    const evN = evRepo('ev-n')
    let rid = ''
    promptPlan = async (o) => {
      if (/Phase: build\./.test(o.text)) {
        writeFileSync(join(evN, 'src', 'a.ts'), 'export const a = 9\n')
        mkdirSync(join(brainEv, 'projects', 'ev-n'), { recursive: true })
        writeFileSync(join(brainEv, 'projects', 'ev-n', 'factory-log.md'), '# Factory log: ev-n\n')
        writeFileSync(join(brainEv, 'projects', 'ev-n', 'stray.md'), 'stray\n')
        mkdirSync(join(brainEv, 'notes'), { recursive: true })
        writeFileSync(join(brainEv, 'notes', 'stray.md'), 'stray\n')
      }
    }
    const nres = await evStart(evN, ['GAPS: 0\nPASS'])
    rid = nres.id
    const audit = nres.r?.audit?.brain || []
    check('EV f audit: strays in the same folder and elsewhere are listed, factory-log.md is not', audit.includes('projects/ev-n/stray.md') && audit.includes('notes/stray.md') && !audit.some((p) => p.endsWith('factory-log.md')), JSON.stringify(audit))
    ctl.abandonRun(rid)
    rmSync(join(brainEv, 'notes'), { recursive: true, force: true })
    rmSync(join(brainEv, 'projects', 'ev-n', 'stray.md'), { force: true })
  }
  // g. Shadow ledger: judgments, not runs.
  {
    const evG = evRepo('ev-g')
    const gbare = join(temp, 'ev-g-origin.git')
    mkdirSync(gbare)
    git(gbare, ['init', '-q', '--bare', '-b', 'main'])
    git(evG, ['remote', 'add', 'origin', gbare])
    git(evG, ['checkout', '-q', '-b', 'factory/ev-g'])
    writer(evG)
    const gIds: string[] = []
    const A = await evStart(evG, ['GAPS: 0\nPASS'])
    gIds.push(A.id)
    ctl.commitRunNow(A.id, { by: 'joe' })
    const B = await evStart(evG, ['GAPS: 0\nPASS', 'GAPS: 0\nPASS'])
    gIds.push(B.id)
    ctl.guideRun(B.id, 'Make the message friendlier.')
    await ctl.settle(B.id)
    const bAfter = ctl.getRun(B.id)
    ctl.commitRunNow(B.id, { by: 'joe' })
    const C = await evStart(evG, Array(shared.REVIEW_MAX).fill('Bug at src/a.ts:1\nGAPS: 1\nFAIL'))
    gIds.push(C.id)
    const cHeld = C.r?.reviewCycles === shared.REVIEW_MAX && C.r?.phase === 'review'
    ctl.commitRunNow(C.id, { by: 'joe' })
    profiles.saveProfile(evG, { voice: { on: true } })
    voiceCode = 2
    const D = await evStart(evG, Array(shared.VOICE_MAX + 2).fill('GAPS: 0\nPASS'))
    gIds.push(D.id)
    ctl.abandonRun(D.id, { by: 'joe' })
    voiceCode = 0
    profiles.saveProfile(evG, { voice: { on: false } })
    clean(evG)
    claudeSays([])
    const E = ctl.startRun({ task: EVTASK, workRepo: evG, brainPath: brainEv })
    const eId = E.ok ? E.run.id : ''
    gIds.push(eId)
    ctl.abandonRun(eId, { by: 'joe' })
    await ctl.settle(eId)
    clean(evG)
    const F = await evStart(evG, ['Bug\nGAPS: 1\nFAIL', 'GAPS: 0\nPASS'])
    gIds.push(F.id)
    ctl.commitRunNow(F.id, { by: 'joe' })
    let gid = ''
    let n = 0
    promptPlan = async (o) => {
      if (/Phase: build\./.test(o.text)) {
        writeFileSync(join(evG, 'src', 'a.ts'), `export const a = ${100 + ++n}\n`)
        if (gid && n === 1) ctl.guideRun(gid, 'Also keep the old wording in the log line.')
      }
    }
    claudeSays(['GAPS: 0\nPASS'])
    const G = ctl.startRun({ task: EVTASK, workRepo: evG, brainPath: brainEv })
    gid = G.ok ? G.run.id : ''
    gIds.push(gid)
    const gRun = await ctl.settle(gid)
    ctl.commitRunNow(gid, { by: 'joe' })
    writer(evG)
    const H = await evStart(evG, ['GAPS: 0\nPASS'], { through: true, ship: false })
    gIds.push(H.id)
    const hPushed = await ctl.publishRun(H.id, { by: 'joe' })
    const runs = gIds.map((i) => store.loadRun(i)).filter((x): x is NonNullable<typeof x> => !!x)
    const line = shadowMod.agreement(runs).map(shadowMod.agreementLine)[0]
    const js = runs.flatMap((x) => x.shadow?.judgments || [])
    check('EV g B: a Guide on a passing gate is a disagreement, the next gate is its own judgment', (store.loadRun(B.id)?.shadow?.judgments || []).map((j) => `${j.action}:${j.agree}`).join(',') === 'guide:false,commit:true' && bAfter?.phase === 'review', JSON.stringify(store.loadRun(B.id)?.shadow))
    check('EV g C: held fail then Commit anyway is a disagreement', cHeld && store.loadRun(C.id)?.shadow?.judgments.map((j) => `${j.action}:${j.agree}`).join(',') === 'commit:false', JSON.stringify(store.loadRun(C.id)?.shadow))
    check('EV g E: abandon during triage is noGate, no judgment', store.loadRun(eId)?.shadow?.noGate === true && !store.loadRun(eId)?.shadow?.judgments.length)
    check('EV g F: a fail cycle then pass keeps the pass gate', store.loadRun(F.id)?.shadow?.gate?.strict === 'pass' && store.loadRun(F.id)?.shadow?.judgments.length === 1)
    check('EV g G: a queued note during build is not a judgment', gRun?.phase === 'review' && store.loadRun(gid)?.shadow?.judgments.length === 1, JSON.stringify(store.loadRun(gid)?.shadow))
    check('EV g H: auto-commit counts auto 1, Joe’s real Push is the judgment', !!hPushed.pushed && store.loadRun(H.id)?.shadow?.auto === 1 && store.loadRun(H.id)?.shadow?.judgments.map((j) => j.action).join(',') === 'push')
    check('EV g one judgment per gate', new Set(js.map((j) => j.gate)).size === js.length)
    check('EV g agreement prints agree 6/8, streak 4, auto 1, noGate 1', line === 'agree 6/8, streak 4, auto 1, noGate 1', line)
    const evI = evRepo('ev-i')
    const ibare = join(temp, 'ev-i-origin.git')
    mkdirSync(ibare)
    git(ibare, ['init', '-q', '--bare', '-b', 'main'])
    git(evI, ['remote', 'add', 'origin', ibare])
    git(evI, ['checkout', '-q', '-b', 'factory/ev-i'])
    writer(evI)
    const I = await evStart(evI, ['GAPS: 0\nPASS'], { through: true, ship: true })
    const again = await ctl.publishRun(I.id, { by: 'joe' })
    const iShadow = store.loadRun(I.id)?.shadow
    check('EV g I: auto-commit and auto-push on one gate is auto 1, zero judgments; a later Push click adds none', !!I.r?.pushed && !!again.pushed && iShadow?.auto === 1 && iShadow.judgments.length === 0, JSON.stringify(iShadow))
  }
  // Diff review round 1 fixes: a refused auto-commit is not an auto-ship; a Guide that starts no turn is no judgment; a failed migration loses nothing.
  {
    const evR = evRepo('ev-refuse')
    writeFileSync(join(evR, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(evR, '.git', 'hooks', 'pre-commit'), 0o755)
    writer(evR)
    const { id, r } = await evStart(evR, ['GAPS: 0\nPASS'], { through: true })
    check('EV g a refused auto-commit (git hook exits 1) is not an automatic ship', r?.phase === 'review' && /Commit failed/.test(r.error || '') && !r.commitSha && (r.shadow?.auto || 0) === 0 && !!r.shadow?.gate?.wouldShip, JSON.stringify({ phase: r?.phase, error: r?.error, shadow: r?.shadow }))
    ctl.abandonRun(id)
    clean(evR)
  }
  {
    const evK = evRepo('ev-keep')
    const evHeld = evRepo('ev-held')
    use({ projectsDir: temp })
    writer(evHeld)
    const holder = await evStart(evHeld, ['GAPS: 0\nPASS'])
    const lock = { ok: store.activeRunFor(evHeld)?.runId === holder.id }
    writer(evK)
    const { id, r } = await evStart(evK, ['GAPS: 0\nPASS'])
    const p0 = promptCount()
    const after = ctl.guideRun(id, `Do this in ${evHeld} instead.`)
    await ctl.settle(id)
    const now = ctl.getRun(id)
    check('EV g a Guide whose repo move is refused starts no turn and records no judgment', lock.ok && r?.phase === 'review' && promptCount() === p0 && (now?.shadow?.judgments.length || 0) === 0 && now?.phase === 'review' && /already running/.test(now?.error || '') && !!after, JSON.stringify({ lock: lock.ok, phase: now?.phase, shadow: now?.shadow, error: now?.error }))
    ctl.abandonRun(holder.id)
    ctl.abandonRun(id)
    clean(evK)
    clean(evHeld)
    use()
  }
  {
    const evM = evRepo('ev-mig-fail')
    const runsDir = join(store.factoryDir(), 'runs')
    const tmpl = store.loadRun(bId)
    const mid = 'run-mig-fail'
    writeFileSync(join(runsDir, `${mid}.json`), JSON.stringify({ ...tmpl, id: mid, workRepo: evM, diff: '+CODEMARK_MIGFAIL', note: undefined, error: undefined, pushError: undefined, deployError: undefined, phase: 'done' }))
    writeFileSync(join(runsDir, `${mid}.review.md`), 'CODEMARK_MIGFAIL review')
    const block = join(commonDir(evM), 'brain-factory', mid)
    mkdirSync(dirname(block), { recursive: true })
    writeFileSync(block, 'a file where the store folder should be')
    const first = store.loadRun(mid)
    const kept = existsSync(join(runsDir, `${mid}.review.md`)) && readFileSync(join(runsDir, `${mid}.json`), 'utf8').includes('CODEMARK_MIGFAIL')
    rmSync(block, { force: true })
    const second = store.loadRun(mid)
    const moved = !existsSync(join(runsDir, `${mid}.review.md`)) && !readFileSync(join(runsDir, `${mid}.json`), 'utf8').includes('CODEMARK_MIGFAIL') && hits(storeOf(evM, mid), 'CODEMARK_MIGFAIL').length === 2
    check('EV e a failed migration copy keeps userData as it was; the next load moves it', !!first?.diff?.includes('CODEMARK_MIGFAIL') && kept && !!second?.diff?.includes('CODEMARK_MIGFAIL') && moved, JSON.stringify({ first: !!first?.diff, kept, moved }))
  }
  // LV. Live model display: every call type shows while it runs and clears however it ends.
  {
    type LC = NonNullable<ReturnType<typeof ctl.getRun>>['live']
    const waitFor = async (pred: () => boolean, ms = 20000) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (pred()) return true
        await new Promise((r) => setTimeout(r, 20))
      }
      return pred()
    }
    const liveOf = (id: string): NonNullable<LC> => ctl.getRun(id)?.live || []
    const tuple = (c: NonNullable<LC>[number]) => `${c.phase}|${c.cli}|${c.model}|${c.effort}`
    const one = async (id: string, want: string) => {
      const ok = await waitFor(() => liveOf(id).length === 1 && tuple(liveOf(id)[0]) === want)
      return { ok, id: liveOf(id)[0]?.id || '', got: liveOf(id).map(tuple) }
    }
    const withInfo = (info?: (tab: string) => { model?: string; effort?: string }) => use({ driver: { ...evDeps.driver, ...(info ? { info } : {}) } })
    const slowGrok = join(temp, 'fake-grok-slow')
    writeFileSync(
      slowGrok,
      `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'text', data: JSON.stringify({ size: 'T2', risk: 'elevated', reason: 'fake' }) }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'end', usage: { input_tokens: 9, output_tokens: 1 }, num_turns: 1, total_cost_usd: 0.001, modelUsage: { 'grok-fake-served': { costUSD: 0.001 } } }) + '\\n')
}, 1500)
`
    )
    chmodSync(slowGrok, 0o755)
    const releases: (() => void)[] = []
    const blockOn = (r: string, re = /Phase: (build|fix)\./, then?: () => void) => {
      let n = 0
      promptPlan = async (o) => {
        if (!re.test(o.text)) return
        writeFileSync(join(r, 'src', 'a.ts'), `export const a = ${200 + ++n}\n`)
        await new Promise<void>((res) => releases.push(res))
        then?.()
      }
    }
    const releaseAll = () => {
      while (releases.length) releases.shift()?.()
    }

    // a. In flight, each call type, one row at a time.
    const evL = evRepo('ev-live')
    withInfo(() => ({ model: 'grok-acp-fake', effort: 'high' }))
    triageBin = slowGrok
    process.env.FAKE_CLAUDE_DELAY = '1500'
    blockOn(evL, /Phase: build\./)
    claudeSays(['Plan: small, one file.', 'GAPS: 0\nPASS'])
    const ev0 = events.length
    const aRes = ctl.startRun({ task: 'Add a new API endpoint for team settings with shared types', workRepo: evL, brainPath: brainEv, runThrough: true })
    const aId = aRes.ok ? aRes.run.id : ''
    const t = await one(aId, 'triage|grok|grok (CLI default)|low')
    const p = await one(aId, 'plan|claude|opus|medium')
    const b = await one(aId, 'build|grok|grok-acp-fake|high')
    const before = events.length
    await new Promise((r) => setTimeout(r, 2000))
    const quiet = events.length === before
    releaseAll()
    const rv = await one(aId, 'review|claude|opus|low')
    const aEnd = await ctl.settle(aId)
    restoreEcho()
    process.env.FAKE_CLAUDE_DELAY = '0'
    check('LV a triage, plan, ACP build, and review each show as the only live row while they run', [t, p, b, rv].every((x) => x.ok) && new Set([t.id, p.id, b.id, rv.id]).size === 4, JSON.stringify([t, p, b, rv]))
    check('LV a live is empty after the run', aEnd?.phase === 'done' && !aEnd.live?.length, JSON.stringify({ phase: aEnd?.phase, live: aEnd?.live }))
    const flips = (() => {
      let had = false
      let n = 0
      for (const e of events.slice(ev0) as { runId: string; run?: { live?: { id: string }[] } }[]) {
        if (e.runId !== aId || !e.run) continue
        const has = !!e.run.live?.some((c) => c.id === b.id)
        if (has !== had) n++
        had = has
      }
      return n
    })()
    check('LV f one ACP call flips live twice (set, clear); a 2 s wait while blocked emits nothing', flips === 2 && quiet, JSON.stringify({ flips, quiet }))
    const aDone = store.loadRun(aId)
    check('LV f Models line comes from served models, each phase/model/effort once', shared.modelsLine(aDone?.usage).includes('review claude-fake-served low') && shared.modelsLine(aDone?.usage).includes('triage grok-fake-served low'), shared.modelsLine(aDone?.usage))
    const row = (phase: 'review' | 'build', model: string, effort: string) => ({ phase, cli: 'claude' as const, model, effort, inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0, costEq: 0, ms: 0, turns: 1, ok: true, at: 0 })
    check('LV f modelsLine dedupes the same triple', shared.modelsLine([row('review', 'm1', 'medium'), row('review', 'm1', 'medium'), row('build', 'm2', 'high')]) === 'review m1 medium; build m2 high')

    // a (cont). The Opus builder turn.
    const evO = evRepo('ev-live-opus')
    writer(evO)
    process.env.FAKE_CLAUDE_BUILD_SLEEP = '1500'
    claudeSays(['a\nGAPS: 1\nFAIL', 'b\nGAPS: 1\nFAIL', 'c\nGAPS: 1\nFAIL', 'GAPS: 0\nPASS'])
    const oRes = ctl.startRun({ task: EVTASK, workRepo: evO, brainPath: brainEv, runThrough: true })
    const oId = oRes.ok ? oRes.run.id : ''
    const ob = await one(oId, 'build|claude|opus|medium')
    const oEnd = await ctl.settle(oId)
    process.env.FAKE_CLAUDE_BUILD_SLEEP = '0'
    check('LV a the Opus builder turn shows as the only live row, then clears', ob.ok && oEnd?.phase === 'done' && !oEnd.live?.length, JSON.stringify({ ob, phase: oEnd?.phase, live: oEnd?.live }))

    // b. Every ending: present while blocked, empty after.
    const ending = async (name: string, o: { repoName: string; says: string[]; delay?: string; want: string; act: (id: string) => Promise<void> | void; over?: Partial<typeof fakeDeps>; build?: boolean; info?: boolean }) => {
      const r = evRepo(o.repoName)
      if (o.build) blockOn(r)
      else writer(r)
      if (o.info === false) use(o.over || {})
      else use({ ...(o.over || {}), driver: { ...evDeps.driver, info: () => ({ model: 'grok-acp-fake', effort: 'high' }) } })
      process.env.FAKE_CLAUDE_DELAY = o.delay || '0'
      claudeSays(o.says)
      const res = ctl.startRun({ task: EVTASK, workRepo: r, brainPath: brainEv, runThrough: true })
      const id = res.ok ? res.run.id : ''
      const seen = o.want ? await one(id, o.want) : { ok: true, id: '', got: [] }
      process.env.FAKE_CLAUDE_DELAY = '0'
      await o.act(id)
      const end = await ctl.settle(id)
      check(`LV b ${name}: live while blocked, empty after`, seen.ok && !end?.live?.length, JSON.stringify({ seen, phase: end?.phase, live: end?.live }))
      releaseAll()
      if (end && !['done', 'abandoned'].includes(end.phase)) ctl.abandonRun(id)
      use()
      return { id, end, seen }
    }
    await ending('claude timeout', { repoName: 'ev-lv-timeout', says: ['GAPS: 0\nPASS', 'GAPS: 0\nPASS'], delay: '4000', want: 'review|claude|opus|low', over: { opusTimeoutMs: 800 }, act: () => {} })
    await ending('claude exit 3', { repoName: 'ev-lv-exit', says: ['@@exit:3:GAPS: 0\nPASS', 'GAPS: 0\nPASS'], delay: '1200', want: 'review|claude|opus|low', act: () => {} })
    await ending('missing claude binary', { repoName: 'ev-lv-missing', says: [], want: '', over: { claudeBin: () => join(temp, 'no-such-claude') }, act: () => {} })
    const thrower = evRepo('ev-lv-throw')
    promptPlan = async (o) => {
      if (!/Phase: build\./.test(o.text)) return
      writeFileSync(join(thrower, 'src', 'a.ts'), 'export const a = 9\n')
      await new Promise<void>((res) => releases.push(res))
      throw new Error('ACP turn broke')
    }
    use()
    claudeSays([])
    const thRes = ctl.startRun({ task: EVTASK, workRepo: thrower, brainPath: brainEv, runThrough: true })
    const thId = thRes.ok ? thRes.run.id : ''
    const th = await one(thId, 'build|grok|grok|')
    releaseAll()
    const thEnd = await ctl.settle(thId)
    check('LV b ACP turn that throws: live while blocked, empty after', th.ok && thEnd?.phase === 'failed' && !thEnd.live?.length, JSON.stringify({ th, phase: thEnd?.phase, live: thEnd?.live }))
    check('LV e no driver.info: the row falls back to the builder name, no throw', th.ok, JSON.stringify(th))
    ctl.abandonRun(thId)
    const ab = await ending('Abandon during a blocked build', {
      repoName: 'ev-lv-abandon',
      says: [],
      want: 'build|grok|grok-acp-fake|high',
      build: true,
      act: async (id) => {
        // d. While blocked, every in-memory read carries the row; the disk file has it; loadRun does not.
        const file = join(store.factoryDir(), 'runs', `${id}.json`)
        const disk = readFileSync(file, 'utf8')
        check(
          'LV d in-memory reads keep live mid-call; the file has it; loadRun drops it',
          liveOf(id).length === 1 &&
            (ctl.restoreRun(id)?.live?.length || 0) === 1 &&
            (ctl.listFactoryRuns().find((x) => x.id === id)?.live?.length || 0) === 1 &&
            disk.includes('"live"') &&
            !store.loadRun(id)?.live,
          JSON.stringify({ mem: liveOf(id).length, disk: disk.includes('"live"'), load: store.loadRun(id)?.live })
        )
        ctl.abandonRun(id)
      }
    })
    check('LV b Abandon ends abandoned', ab.end?.phase === 'abandoned')
    await ending('Pause during a sleeping review', {
      repoName: 'ev-lv-pause',
      says: ['GAPS: 0\nPASS'],
      delay: '4000',
      want: 'review|claude|opus|low',
      act: (id) => {
        ctl.pauseRun(id)
      }
    })
    {
      const r = evRepo('ev-lv-guide')
      blockOn(r)
      withInfo(() => ({ model: 'grok-acp-fake', effort: 'high' }))
      claudeSays(['GAPS: 0\nPASS'])
      const res = ctl.startRun({ task: EVTASK, workRepo: r, brainPath: brainEv, runThrough: true })
      const id = res.ok ? res.run.id : ''
      const first = await one(id, 'build|grok|grok-acp-fake|high')
      const tab = liveOf(id)[0]?.tab
      ctl.guideRun(id, 'Also keep the old wording in the log line.')
      const second = await waitFor(() => liveOf(id).length === 1 && liveOf(id)[0].id !== first.id && liveOf(id)[0].tab === tab)
      releaseAll()
      await waitFor(() => !liveOf(id).length || releases.length > 0)
      releaseAll()
      const end = await ctl.settle(id)
      releaseAll()
      check('LV b Guide Send during a blocked build: the follow-up turn has its own row on the same tab, empty after', first.ok && second && !end?.live?.length, JSON.stringify({ first, live: end?.live, phase: end?.phase }))
      if (end && !['done', 'abandoned'].includes(end.phase)) ctl.abandonRun(id)
      use()
    }

    // c. T3: two workers blocked at once, each its own row; one release leaves the other.
    {
      const r = evRepo('ev-lv-t3')
      const byTab = new Map<string, () => void>()
      promptPlan = async (o) => {
        const m = /Your slice (\d+) of \d+: [^.]+\. Edit only these files; other builders own the rest: (.+)/.exec(o.text)
        if (!m) return
        for (const rel of m[2].split(', ').map((x) => x.trim()).filter(Boolean)) writeFileSync(join(r, rel), 'export const v = 1\n')
        await new Promise<void>((res) => byTab.set(String(o.tabId), res))
      }
      withInfo((tab) => ({ model: `grok-${tab.endsWith('w1') ? 'one' : 'two'}`, effort: 'xhigh' }))
      t3Says([{ title: 'x', files: ['src/x.ts'] }, { title: 'y', files: ['src/y.ts'] }], 'GAPS: 0\nPASS')
      const res = ctl.startRun({ task: T3TASK, workRepo: r, brainPath: brainEv, runThrough: true })
      const id = res.ok ? res.run.id : ''
      const two = await waitFor(() => liveOf(id).filter((c) => c.phase === 'build').length === 2)
      const rows = liveOf(id)
      const w1 = rows.find((c) => c.tab?.endsWith('-w1'))
      byTab.get(String(w1?.tab))?.()
      const left = await waitFor(() => liveOf(id).length === 1 && !!liveOf(id)[0].tab?.endsWith('-w2'))
      for (const f of byTab.values()) f()
      const end = await ctl.settle(id)
      check('LV c T3: two worker rows with their own ids; releasing one leaves exactly the other; empty after', two && rows.length === 2 && rows[0].id !== rows[1].id && w1?.model === 'grok-one' && left && !end?.live?.length, JSON.stringify({ rows: rows.map((c) => [c.tab, c.model]), end: end?.phase }))
      use()
    }

    // d (cont). After a restart a stale live row never shows.
    {
      const file = join(store.factoryDir(), 'runs', `${oId}.json`)
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      raw.live = [{ id: 'stale', phase: 'review', cli: 'claude', model: 'opus', effort: 'medium', since: 1 }]
      writeFileSync(file, JSON.stringify(raw))
      ctl.dropMemory()
      check('LV d after dropMemory, restoreRun and getRun show no stale live', !ctl.restoreRun(oId)?.live && !ctl.getRun(oId)?.live)
    }

    // e (cont). The real factoryInfo reads the ACP tab.
    {
      const mk = (tabId: string, model: string, effort: string) => ({ tabId, sessionId: `s-${tabId}`, promptId: null, appTools: [], text: '', alwaysApprove: false, model, effort })
      const tabA = mk('factory-run-lvinfo', 'grok-4.7-build', 'xhigh')
      const tabW = mk('factory-run-lvinfo-w1', 'grok-4.6-build', 'high')
      acp.registerPoolForCheck({ kind: 'grok', lane: 'factory', cwd: join(temp, 'lv-info-brain'), boot: Promise.resolve(), tabs: new Map([[tabA.tabId, tabA], [tabW.tabId, tabW]]), bySid: new Map(), rpc: { dead: false, request: async () => ({}), notify: () => {}, kill: () => {} } } as never)
      const a = acp.factoryInfo(tabA.tabId)
      const w = acp.factoryInfo(tabW.tabId)
      check('LV e factoryInfo returns the ACP tab model and effort (run tab and worker), {} for an unknown tab', a.model === 'grok-4.7-build' && a.effort === 'xhigh' && w.model === 'grok-4.6-build' && w.effort === 'high' && JSON.stringify(acp.factoryInfo('nope')) === '{}', JSON.stringify({ a, w }))
    }

    // g. Pane: the existing header line holds the new text; nothing else moved.
    {
      const pane = readFileSync(join(rootRepo, 'src', 'renderer', 'src', 'FactoryPane.tsx'), 'utf8')
      const head = pane.slice(pane.indexOf('Work repo: <strong>'), pane.indexOf('</p>', pane.indexOf('Work repo: <strong>')))
      check('LV g Now and Models sit inside the existing Work repo header line', head.includes('nowLine(c)') && head.includes('Models: ${modelsLine(run.usage)}') && pane.includes("const live = run.phase !== 'done' && run.phase !== 'abandoned'"), head)
    }
    use()
  }

  // VL. The voice loop fixes itself: 5 automatic grunt fixes with voice notes, then a hold; Fix copy and Guide keep it going.
  {
    const voiceMod = (await import(src('factory/voice.ts'))) as typeof import('../src/main/factory/voice.ts')
    const REJ = { code: 2, out: '1. Gate 1: contrast framing (noul 0.59)\n2. Gate 2: register match (score 0.61)\nREJECT CODEMARK_VOICEOUT\n' }
    const APP = { code: 0, out: 'APPROVE\n' }
    const copyRepo = (name: string) => {
      const r = evRepo(name)
      profiles.saveProfile(r, { voice: { on: true } })
      return r
    }
    const copyWriter = (r: string, onFix?: (n: number) => void) => {
      let n = 0
      let fixes = 0
      promptPlan = async (o) => {
        if (!/Phase: (build|fix)\./.test(o.text)) return
        if (/Phase: fix\./.test(o.text)) onFix?.(++fixes)
        n++
        writeFileSync(join(r, 'page.html'), `<button class="go">Start now ${n}</button>\n`)
        writeFileSync(join(r, 'NOTES.md'), `Release note ${n}\n`)
      }
    }
    const fixPrompts = (from: number) => promptsFrom(from).filter((t) => /Phase: fix\./.test(t))
    const TYPO = 'fix typo in NOTES.md'
    use()

    // VL 1: REJECT, REJECT, APPROVE with Approve in advance: no click, two fixes with voice notes, then commit.
    {
      const r = copyRepo('ev-vl1')
      copyWriter(r)
      voiceSays.length = 0
      voiceSays.push(REJ, REJ, APP)
      const v0 = voiceCalls.length
      const p0 = promptCount()
      const res = ctl.startRun({ task: TYPO, workRepo: r, brainPath: brainEv, runThrough: true })
      const id = res.ok ? res.run.id : ''
      const end = await ctl.settle(id)
      const fixes = fixPrompts(p0)
      const notePaths = fixes.map((t) => /Voice notes: (.+?\.md)\. Rewrite only/.exec(t)?.[1] || '')
      const notes = notePaths[0] && existsSync(notePaths[0]) ? readFileSync(notePaths[0], 'utf8') : ''
      const bodies = voiceCalls.slice(v0).map((c) => c.body)
      check('VL 1 two automatic fix turns, each with a Voice notes path in the repo store', fixes.length === 2 && notePaths.every((p) => !!p && existsSync(p) && underPath(realish(join(r, '.git', 'brain-factory')), realish(p))), JSON.stringify({ n: fixes.length, notePaths }))
      check('VL 1 voice notes carry the checked copy, the real gate line, the hint, and the house rules', notes.includes('Start now') && notes.includes('Gate 1: contrast framing (noul 0.59)') && notes.includes('contrast framing: state the positive claim') && notes.includes('context/business/voice/anti-patterns.md'), notes.slice(0, 400))
      check('VL 1 the voice check is fed visible words, never tags', bodies.length === 3 && bodies.every((b) => b.includes('Start now') && !b.includes('<')), JSON.stringify(bodies))
      check('VL 1 ends committed with voiceCycles 2; no voice output in userData', end?.phase === 'done' && !!end.commitSha && end.voiceCycles === 2 && hits(userData, 'CODEMARK_VOICEOUT').length === 0, JSON.stringify({ phase: end?.phase, cycles: end?.voiceCycles, leaks: hits(userData, 'CODEMARK_VOICEOUT') }))
    }

    // VL 2 + 2b: six REJECTs hold after five grunt fixes; Fix copy grants a fresh budget.
    {
      const r = copyRepo('ev-vl2')
      copyWriter(r)
      voiceSays.length = 0
      for (let i = 0; i <= shared.VOICE_MAX; i++) voiceSays.push(REJ)
      const p0 = promptCount()
      const c0 = claudeRows().length
      const res = ctl.startRun({ task: TYPO, workRepo: r, brainPath: brainEv, runThrough: true })
      const id = res.ok ? res.run.id : ''
      const held = await ctl.settle(id)
      const fixes = fixPrompts(p0)
      check('VL 2 VOICE_MAX + 1 REJECTs: VOICE_MAX automatic fixes, then a hold at voiceCycles VOICE_MAX, no commit', fixes.length === shared.VOICE_MAX && held?.phase === 'review' && held.voice?.status === 'fail' && held.voiceCycles === shared.VOICE_MAX && !held.commitSha && new RegExp(`attempt ${shared.VOICE_MAX} of ${shared.VOICE_MAX}`).test(fixes[shared.VOICE_MAX - 1] || ''), JSON.stringify({ n: fixes.length, phase: held?.phase, cycles: held?.voiceCycles }))
      check('VL 2 voice fixes never spawn the Opus builder', !claudeRows().slice(c0).some((x) => modeOf(x) === 'bypassPermissions'))
      const pq = promptCount()
      await ctl.settle(id)
      check('VL 2 settle is quiet after the hold (no sixth fix)', promptCount() === pq)
      voiceSays.length = 0
      voiceSays.push(REJ, APP)
      const p1 = promptCount()
      ctl.decideRun(id, 'fix-copy')
      const end = await ctl.settle(id)
      check('VL 2b Fix copy: its turn plus one automatic fix, then commit, voiceCycles 1', fixPrompts(p1).length === 2 && end?.phase === 'done' && !!end.commitSha && end.voiceCycles === 1, JSON.stringify({ n: fixPrompts(p1).length, phase: end?.phase, cycles: end?.voiceCycles }))
    }

    // VL 3a: a Guide under the cap never spends or resets the budget; the loop keeps fixing on its own.
    {
      const r = copyRepo('ev-vl3a')
      let id = ''
      copyWriter(r, (n) => {
        if (n === 1 && id) ctl.guideRun(id, 'Keep the button label short.')
      })
      voiceSays.length = 0
      voiceSays.push(REJ, REJ, REJ, APP)
      const res = ctl.startRun({ task: TYPO, workRepo: r, brainPath: brainEv, runThrough: true })
      id = res.ok ? res.run.id : ''
      const end = await ctl.settle(id)
      check('VL 3a Guide under the cap: REJECTs keep fixing on their own, voiceCycles counts only automatic fixes, then commit', end?.phase === 'done' && !!end.commitSha && end.voiceCycles === 3, JSON.stringify({ phase: end?.phase, cycles: end?.voiceCycles }))
    }

    // VL 3b: a Guide at the cap is one fix turn; the next REJECT holds again. A restart keeps the count and starts nothing.
    {
      const r = copyRepo('ev-vl3b')
      copyWriter(r)
      voiceSays.length = 0
      for (let i = 0; i <= shared.VOICE_MAX; i++) voiceSays.push(REJ)
      const res = ctl.startRun({ task: TYPO, workRepo: r, brainPath: brainEv, runThrough: true })
      const id = res.ok ? res.run.id : ''
      await ctl.settle(id)
      voiceSays.push(REJ)
      const p1 = promptCount()
      ctl.guideRun(id, 'Say it plainly.')
      const again = await ctl.settle(id)
      check('VL 3b Guide at the cap: exactly one fix turn, the next REJECT holds again at VOICE_MAX', fixPrompts(p1).length === 1 && again?.phase === 'review' && again.voice?.status === 'fail' && again.voiceCycles === shared.VOICE_MAX, JSON.stringify({ n: fixPrompts(p1).length, phase: again?.phase, cycles: again?.voiceCycles }))
      ctl.dropMemory()
      const back = ctl.restoreRun(id)
      const p2 = promptCount()
      await ctl.settle(id)
      check('VL 3b after a restart voiceCycles is still VOICE_MAX and nothing starts', back?.voiceCycles === shared.VOICE_MAX && promptCount() === p2, JSON.stringify({ cycles: back?.voiceCycles, phase: back?.phase }))
      voiceSays.push(APP)
      const p3 = promptCount()
      ctl.guideRun(id, 'Plainer, please.')
      const resumed = await ctl.settle(id)
      const fx = fixPrompts(p3)
      check('VL 3c a Guide on a restored (paused) voice hold carries the Voice notes path', fx.length === 1 && /Voice notes: .+\.md\. Rewrite only/.test(fx[0]) && resumed?.voice?.status === 'pass', JSON.stringify({ n: fx.length, first: (fx[0] || '').split('\n').filter((l) => l.startsWith('Voice notes') || l.startsWith('Reviewer notes')), voice: resumed?.voice?.status }))
      ctl.abandonRun(id)
    }

    // VL 4: Ship in advance never commits or pushes on a REJECT; it ships after the APPROVE.
    {
      const r = copyRepo('ev-vl4')
      const vbare = join(temp, 'ev-vl4-origin.git')
      mkdirSync(vbare)
      git(vbare, ['init', '-q', '--bare', '-b', 'main'])
      git(r, ['remote', 'add', 'origin', vbare])
      git(r, ['checkout', '-q', '-b', 'factory/voice'])
      const head0 = git(r, ['rev-parse', 'HEAD']).trim()
      const atFix: { head: string; refs: string }[] = []
      copyWriter(r, () => atFix.push({ head: git(r, ['rev-parse', 'HEAD']).trim(), refs: git(vbare, ['for-each-ref']).trim() }))
      voiceSays.length = 0
      voiceSays.push(REJ, REJ, APP)
      claudeSays(Array(3).fill('GAPS: 0\nPASS'))
      const res = ctl.startRun({ task: EVTASK, workRepo: r, brainPath: brainEv, runThrough: true, shipThrough: true })
      const id = res.ok ? res.run.id : ''
      const end = await ctl.settle(id)
      check('VL 4 on each REJECT: no commit and no push; after the APPROVE: one commit and one push', atFix.length === 2 && atFix.every((x) => x.head === head0 && x.refs === '') && end?.phase === 'done' && !!end.commitSha && !!end.pushed && git(vbare, ['rev-parse', 'refs/heads/factory/voice']).trim() === end.commitSha, JSON.stringify({ atFix, phase: end?.phase, pushed: end?.pushed, err: end?.pushError }))
    }

    check('VL 5 copyAdds keeps visible HTML words and md lines', voiceMod.copyAdds('diff --git a/p.html b/p.html\n+++ b/p.html\n+<button class="x">Start &amp; go</button>\n+<div>\ndiff --git a/n.md b/n.md\n+++ b/n.md\n+Plain md line\n') === 'Start & go\nPlain md line')
    {
      const r = copyRepo('ev-vl6')
      copyWriter(r)
      voiceSays.length = 0
      voiceSays.push(APP)
      const res = ctl.startRun({ task: TYPO, workRepo: r, brainPath: brainEv })
      const id = res.ok ? res.run.id : ''
      await ctl.settle(id)
      let msg = ''
      try {
        ctl.decideRun(id, 'fix-copy')
      } catch (e) {
        msg = String((e as Error).message)
      }
      check('VL 6 Fix copy when voice did not hold refuses', msg === 'The voice check did not hold this run.', msg)
      ctl.abandonRun(id)
    }
    check('ST 6 twelve tries: the Opus hold line says 12 fixes; REVIEW_MAX 13, VOICE_MAX 12', ctl.HELD_LINE === 'Opus has not approved after 12 fixes. Gaps still count.' && ctl.VOICE_HELD_LINE === 'Voice has not approved after 12 fixes.' && shared.REVIEW_MAX === 13 && shared.VOICE_MAX === 12, ctl.HELD_LINE)
    voiceSays.length = 0
  }

  // PM. Push main by click and by Ship in advance; staging/prod/production and Kennel stay gated; Push anyway through the real IPC.
  {
    const fIpc = (await import(src('factory/ipc.ts'))) as typeof import('../src/main/factory/ipc.ts')
    fIpc.registerFactoryIpc()
    const fipc = (globalThis as { __fipc?: Map<string, (...a: unknown[]) => unknown> }).__fipc
    let pc = 0
    const pushDeps = { publish: async (r: string, t: Parameters<typeof gates.publish>[1], over?: Parameters<typeof gates.publish>[3]) => (pc++, gates.publish(r, t, undefined, over)) }
    use(pushDeps)
    const call = async (name: string, id: string) => {
      const fn = fipc?.get(name)
      if (!fn) throw new Error('no factory IPC handler ' + name)
      return (await fn({}, id)) as { ok: boolean; run?: import('../src/shared/factory.ts').RunRecord; offer?: boolean; block?: string | null; error?: string }
    }
    const remoteRepo = (name: string, branch = 'main') => {
      const r = evRepo(name)
      const b = join(temp, `${name}-origin.git`)
      mkdirSync(b)
      git(b, ['init', '-q', '--bare', '-b', 'main'])
      git(r, ['remote', 'add', 'origin', b])
      if (branch !== 'main') git(r, ['checkout', '-q', '-b', branch])
      writer(r)
      return { r, b, refs: () => git(b, ['for-each-ref']).trim(), at: (br: string) => (git(b, ['for-each-ref', `refs/heads/${br}`]).trim().split(' ')[0] || '') }
    }
    const PLAIN = 'Refresh the release notes and counter value'
    const PASS = 'GAPS: 0\nPASS'

    // PM 1: Approve in advance, Ship off: done and committed, not pushed; the click pushes main.
    {
      const x = remoteRepo('ev-pm1')
      const p0 = pc
      const { id, r } = await evStart(x.r, [PASS], { through: true })
      const before = { phase: r?.phase, sha: r?.commitSha, pushed: !!r?.pushed, calls: pc - p0, main: x.at('main') }
      const clicked = await call('factory:publish', id)
      check('PM 1 Approve in advance alone commits and does not push; the Push click pushes main once', before.phase === 'done' && !!before.sha && !before.pushed && before.calls === 0 && before.main === '' && clicked.ok && pc - p0 === 1 && x.at('main') === before.sha, JSON.stringify({ before, after: pc - p0, main: x.at('main') }))
    }
    // PM 2: plain T1 on main with Ship in advance: an Opus review at low, then a push. FAIL×REVIEW_MAX holds with no push.
    {
      const x = remoteRepo('ev-pm2')
      const c0 = claudeRows().length
      const { r } = await evStart(x.r, [PASS], { ship: true, task: PLAIN })
      const revs = opusReviews(claudeRows().slice(c0))
      check('PM 2 plain run with Ship in advance gets an Opus review at low, then pushes main', revs.length === 1 && revs[0].argv[revs[0].argv.indexOf('--effort') + 1] === 'low' && r?.phase === 'done' && r.pushed?.branch === 'main' && x.at('main') === r.commitSha, JSON.stringify({ revs: revs.length, phase: r?.phase, pushed: r?.pushed, err: r?.pushError }))
      const y = remoteRepo('ev-pm2b')
      const { id: heldId, r: held } = await evStart(y.r, [...Array(shared.REVIEW_MAX).fill('Bug\nGAPS: 1\nFAIL'), 'GAPS: 0\nPASS'], { ship: true, task: PLAIN })
      check('PM 2 Ship in advance with REVIEW_MAX fails holds at REVIEW_MAX, no push, remote unchanged', held?.phase === 'review' && held.reviewCycles === shared.REVIEW_MAX && !held.pushed && y.refs() === '', JSON.stringify({ phase: held?.phase, cycles: held?.reviewCycles, error: held?.error }))
      ctl.resumeRun(heldId)
      const cont = await ctl.settle(heldId)
      check('PM 2 Ship in advance resumes past REVIEW_MAX on a clean PASS: commit and push, no deploy', cont?.phase === 'done' && !!cont.commitSha && cont.pushed?.branch === 'main' && y.at('main') === cont.commitSha && !cont.deployed, JSON.stringify({ phase: cont?.phase, pushed: cont?.pushed, err: cont?.pushError, error: cont?.error }))
    }
    // PM 3: Ship in advance off, plain run: no Opus review, no push.
    {
      const x = remoteRepo('ev-pm3')
      const c0 = claudeRows().length
      const p0 = pc
      const { id, r } = await evStart(x.r, [], { task: PLAIN })
      check('PM 3 plain run without Ship in advance: no claude spawn, no push', claudeRows().length === c0 && pc === p0 && !r?.pushed && x.refs() === '', JSON.stringify({ spawns: claudeRows().length - c0, phase: r?.phase }))
      ctl.abandonRun(id)
    }
    // PM 4: staging, prod, production stay refused by click and by Ship in advance; Start names the branch.
    for (const br of ['staging', 'prod', 'production']) {
      const x = remoteRepo(`ev-pm4-${br}`, br)
      const { id, r, res } = await evStart(x.r, [PASS], { through: true, ship: true })
      const clicked = await call('factory:publish', id)
      check(`PM 4 ${br}: Ship in advance and the Push click both refuse; the remote is unchanged; Start names ${br}`, r?.phase === 'done' && !r.pushed && clicked.run?.pushError === `Brain does not push to ${br}. Push it from Terminal after review.` && x.refs() === '' && (res.ok ? res.run.pushWarn || '' : '').includes(br), JSON.stringify({ err: clicked.run?.pushError, warn: res.ok ? res.run.pushWarn : res }))
    }
    // PM 5: Kennel main, master, staging refused by click and auto; Start names the gate; factory/x pushes.
    for (const br of ['main', 'master', 'staging']) {
      const x = remoteRepo(`mykennel-web-${br}`, br)
      const c0 = claudeRows().length
      const { id, r, res } = await evStart(x.r, [PASS], { through: true, ship: true })
      const spawnsBefore = claudeRows().length
      const clicked = await call('factory:publish', id)
      check(`PM 5 Kennel ${br}: auto and the Push click refuse with the Kennel sentence; Start names the gate`, r?.phase === 'done' && !r.pushed && clicked.run?.pushError === gates.KENNEL_PUSH_REFUSAL && claudeRows().length === spawnsBefore && x.refs() === '' && (res.ok ? res.run.pushWarn || '' : '').includes('Kennel gate'), JSON.stringify({ err: clicked.run?.pushError, warn: res.ok ? res.run.pushWarn : res, spawns: spawnsBefore - c0 }))
    }
    {
      const x = remoteRepo('mykennel-web-feature', 'factory/x')
      const { r } = await evStart(x.r, [PASS], { through: true, ship: true })
      check('PM 5 Kennel on factory/x pushes as before', r?.pushed?.branch === 'factory/x' && x.at('factory/x') === r.commitSha, JSON.stringify({ pushed: r?.pushed, err: r?.pushError }))
    }
    // PM 6: guards on main.
    {
      const x = remoteRepo('ev-pm6')
      const { id, r } = await evStart(x.r, [PASS], { through: true })
      git(x.r, ['push', '-q', 'origin', 'main'])
      const clicked = await call('factory:publish', id)
      const direct = gates.publishBlock({ repo: x.r, remote: 'origin', branch: 'main', sha: r?.commitSha || '' })
      check('PM 6 already pushed by hand: the click and publishBlock both say already pushed; remote unchanged', clicked.run?.pushError === 'Already pushed to origin/main.' && direct === 'Already pushed to origin/main.' && x.at('main') === r?.commitSha, JSON.stringify({ err: clicked.run?.pushError, direct }))
      const y = remoteRepo('ev-pm6b')
      const { id: id2 } = await evStart(y.r, [PASS], { through: true })
      writeFileSync(join(y.r, 'extra.md'), 'by hand\n')
      git(y.r, ['add', '-A'])
      git(y.r, ['commit', '-q', '-m', 'by hand'])
      const moved = await call('factory:publish', id2)
      const z = evRepo('ev-pm6c')
      writer(z)
      const { id: id3 } = await evStart(z, [PASS], { through: true })
      const none = await call('factory:publish', id3)
      check('PM 6 branch moved and no remote are still refused on main', /moved since Factory committed/.test(moved.run?.pushError || '') && /no remote named origin/.test(none.run?.pushError || ''), JSON.stringify({ moved: moved.run?.pushError, none: none.run?.pushError }))
    }
    // PM 8: screen text.
    {
      const pane = readFileSync(join(rootRepo, 'src', 'renderer', 'src', 'FactoryPane.tsx'), 'utf8')
      check('PM 8 Ship checkbox text is the exact new sentence', pane.includes('Ship in advance: after an Opus review with no gaps, Brain commits and pushes. On its own it never pushes staging, prod, production, or Kennel main, master, and staging.'))
      check('PM 8 Ship sentence and strict wait line use the shared strict rule', pane.includes('const opusReviews = strictRequired(run)') && pane.includes("run.phase === 'review' && !run.diff && strictRequired(run) && !run.strict"))
    }
    // PM 9: Push anyway through the real IPC handlers.
    {
      const x = remoteRepo('ev-pm9-staging', 'staging')
      const { id, r } = await evStart(x.r, [PASS], { through: true, ship: true })
      const offer = await call('factory:publishAnywayFor', id)
      const plain = await call('factory:publish', id)
      const anyway = await call('factory:publishAnyway', id)
      check('PM 9 staging: auto and Push refuse; Push anyway is offered and pushes staging', r?.phase === 'done' && !r.pushed && offer.offer === true && !plain.run?.pushed && anyway.run?.pushed?.branch === 'staging' && x.at('staging') === r.commitSha, JSON.stringify({ offer: offer.offer, err: plain.run?.pushError, pushed: anyway.run?.pushed }))
    }
    const kennelGate = async (name: string, br: string, verdict: string) => {
      const x = remoteRepo(name, br)
      const { id, r } = await evStart(x.r, [PASS], { through: true })
      const offer = await call('factory:publishAnywayFor', id)
      claudeSays([verdict])
      const c0 = claudeRows().length
      const out = await call('factory:publishAnyway', id)
      const spawns = claudeRows().slice(c0)
      const medium = spawns.length === 1 && spawns[0].argv.includes('opus') && spawns[0].argv[spawns[0].argv.indexOf('--effort') + 1] === 'medium' && modeOf(spawns[0]) === 'plan'
      return { x, r, offer: offer.offer, out: out.run, medium, spawns: spawns.length }
    }
    {
      const k = await kennelGate('mykennel-web-anyway', 'main', PASS)
      check('PM 9 Kennel main: Push anyway runs one Opus 5.5 medium gate, then pushes', k.offer === true && k.medium && k.out?.pushed?.branch === 'main' && k.x.at('main') === k.r?.commitSha, JSON.stringify({ offer: k.offer, spawns: k.spawns, pushed: k.out?.pushed, err: k.out?.pushError }))
      const f = await kennelGate('mykennel-web-gatefail', 'main', 'Bug at src/a.ts:1\nGAPS: 1\nFAIL')
      check('PM 9 Kennel main: a gate FAIL pushes nothing', f.medium && !f.out?.pushed && (f.out?.pushError || '').startsWith('Kennel gate did not approve') && f.x.refs() === '', JSON.stringify({ err: f.out?.pushError }))
      const s2 = await kennelGate('mykennel-web-stg', 'staging', PASS)
      check('PM 9 Kennel staging (protected and Kennel): the gate PASS pushes staging', s2.offer === true && s2.medium && s2.out?.pushed?.branch === 'staging' && s2.x.at('staging') === s2.r?.commitSha, JSON.stringify({ err: s2.out?.pushError, spawns: s2.spawns }))
    }
    for (const [name, br] of [['mykennel-web-moved', 'main'], ['ev-pm9-moved', 'staging']] as const) {
      const x = remoteRepo(name, br)
      const { id } = await evStart(x.r, [PASS], { through: true })
      writeFileSync(join(x.r, 'extra.md'), 'by hand\n')
      git(x.r, ['add', '-A'])
      git(x.r, ['commit', '-q', '-m', 'by hand'])
      const offer = await call('factory:publishAnywayFor', id)
      const c0 = claudeRows().length
      const out = await call('factory:publishAnyway', id)
      check(`PM 9 ${br} moved: Push anyway is not offered, no gate runs, nothing pushes`, offer.offer === false && claudeRows().length === c0 && /moved since Factory committed/.test(out.run?.pushError || '') && x.refs() === '', JSON.stringify({ offer: offer.offer, err: out.run?.pushError }))
    }
    {
      const pane = readFileSync(join(rootRepo, 'src', 'renderer', 'src', 'FactoryPane.tsx'), 'utf8')
      const btn = pane.slice(pane.indexOf('{pushAnyway && run.branch ? ('), pane.indexOf('{pushBlock ? <span'))
      const ctlSrc = readFileSync(join(rootRepo, 'src', 'main', 'factory', 'controller.ts'), 'utf8')
      const fr = ctlSrc.slice(ctlSrc.indexOf('async function finishReview'), ctlSrc.indexOf('function liveFor'))
      check('PM 9 the anyway button: confirm gates publishAnyway, shown only on publishAnywayFor; finishReview never overrides', btn.includes('if (!window.confirm(ask)) return') && btn.indexOf('if (!window.confirm(ask)) return') < btn.indexOf('publishAnyway(run.id)') && pane.includes('publishAnywayFor(run.id)') && !fr.includes('allowProtected'))
    }
    use()
  }

  // Done contract: one definition of done, outside vs security, tripwire plans, triage hold.
  {
    restoreEcho()
    evScript = null
    process.env.FAKE_CLAUDE_DELAY = '0'
    use()
    const triageMod = (await import(src('factory/triage.ts'))) as typeof import('../src/main/factory/triage.ts')
    const doneMod = (await import(pathToFileURL(join(rootRepo, 'src/shared/factory-done.ts')).href)) as typeof import('../src/shared/factory-done.ts')
    const CONTRACT = doneMod.DONE_CONTRACT
    const T1TASK = 'Fix the date shown one day off in the order list'
    const HINDI = 'speed up the translation and make it more accurate for Hindi and other languages'
    const planSpawns = (from: number) => claudeRows().slice(from).filter((x) => String(x.argv[1] || '').includes('Write the implementation plan'))
    const reviewers = (from: number) => claudeRows().slice(from).filter((x) => String(x.argv[1] || '').includes('Use the strict code review skill'))
    const touch = (r: string) => {
      promptPlan = async (o) => {
        if (/Phase: (build|fix)\./.test(o.text)) writeFileSync(join(r, 'src', 'a.ts'), 'export const a = 4\n')
      }
    }
    const twelve = (r: string) => {
      promptPlan = async (o) => {
        if (!/Phase: (build|fix)\./.test(o.text)) return
        for (let i = 0; i < 12; i++) writeFileSync(join(r, 'src', `n${i}.ts`), `export const n${i} = 1\n`)
      }
    }
    const go = async (task: string, workRepo: string, through: boolean) => {
      const res = ctl.startRun({ task, workRepo, brainPath: brainEv, runThrough: through })
      const id = res.ok ? res.run.id : ''
      const run = id ? await ctl.settle(id) : null
      return { res, id, run }
    }
    const snap = (run: Awaited<ReturnType<typeof ctl.settle>>) =>
      JSON.stringify({
        phase: run?.phase,
        tier: run?.tier,
        err: run?.error,
        cycles: run?.reviewCycles,
        np: run?.needsProceed,
        plan: run?.plan?.status,
        strict: run?.strict?.status,
        ups: run?.followUps,
        llm: run?.triage?.llm,
        text: run?.strict?.text?.slice(0, 180)
      })

    const hist = opusMod.reviewAccept('Earlier rounds mentioned a follow-up about the changelog. No current defect remains.\nGAPS: 0\nPASS')
    const nit = opusMod.reviewAccept('nit: missing test\nGAPS: 0\nPASS')
    check('PASS history', hist.status === 'pass' && nit.status === 'fail', JSON.stringify({ hist: hist.status, nit: nit.status }))

    {
      const r = evRepo('ev-outside-split')
      touch(r)
      claudeSays(['OUTSIDE:\n- Split this into separate commits\nGAPS: 0\nPASS'])
      const p0 = promptCount()
      const { id, run } = await go(EVTASK, r, true)
      const prompts = promptsFrom(p0)
      check(
        'OUTSIDE split passes',
        run?.strict?.status === 'pass' &&
          (run.reviewCycles || 0) === 0 &&
          run.followUps?.includes('Split this into separate commits') === true &&
          !String(run.strict?.text || '').includes('Split this into separate commits') &&
          !prompts.some((t) => /Phase: fix\./.test(t)) &&
          run.phase === 'done',
        snap(run)
      )
      if (id) ctl.abandonRun(id)
    }

    {
      const r = evRepo('ev-outside-sec')
      touch(r)
      claudeSays(['OUTSIDE:\n- path traversal is unchecked\nGAPS: 0\nPASS', 'GAPS: 0\nPASS'])
      const p0 = promptCount()
      const { id, run } = await go(EVTASK, r, true)
      const prompts = promptsFrom(p0)
      check(
        'OUTSIDE security stays a gap',
        (run?.reviewCycles || 0) === 1 && prompts.some((t) => /Phase: fix\./.test(t)) && run?.strict?.status === 'pass' && run.phase === 'done',
        snap(run)
      )
      if (id) ctl.abandonRun(id)
    }

    {
      const r = evRepo('ev-blocking')
      touch(r)
      claudeSays(['Plan: cover the one file.', "test/utterance.test.js extensionOf('I', 'It was')\nGAPS: 1\nFAIL", 'GAPS: 0\nPASS'])
      const p0 = promptCount()
      const c0 = claudeRows().length
      const { id, run } = await go(T3TASK, r, true)
      const prompts = promptsFrom(p0)
      const fixes = prompts.filter((t) => /Phase: fix\./.test(t))
      const builds = prompts.filter((t) => /Phase: build\./.test(t))
      const revs = reviewers(c0)
      check(
        'BLOCKING fix carries the test',
        run?.reviewCycles === 1 && fixes.some((t) => t.includes('test/utterance.test.js') && t.includes(CONTRACT)) && run?.phase === 'done',
        JSON.stringify({ cycles: run?.reviewCycles, phase: run?.phase, err: run?.error, fix: fixes[0]?.includes('test/utterance.test.js') })
      )
      check(
        'DONE_CONTRACT shared',
        builds.some((t) => t.includes(CONTRACT)) &&
          fixes.some((t) => t.includes(CONTRACT)) &&
          revs.length >= 1 &&
          revs.every((row) => String(row.argv[1] || '').includes(CONTRACT) && !String(row.argv[1] || '').includes('Any gap is FAIL')),
        JSON.stringify({ builds: builds.length, fixes: fixes.length, revs: revs.length })
      )
      if (id) ctl.abandonRun(id)
    }

    {
      const r = evRepo('ev-t3-trip')
      twelve(r)
      claudeSays(['Plan: cover the files.', 'GAPS: 0\nPASS'])
      const c0 = claudeRows().length
      const { res, id, run } = await go(T1TASK, r, true)
      const plans = planSpawns(c0)
      check(
        'T3 tripwire plans',
        res.run?.tier === 'T1' &&
          run?.triage?.llm?.size === 'T1' &&
          run?.tier === 'T3' &&
          run.plan?.status === 'approved' &&
          !!run.plan?.text &&
          plans.length === 1 &&
          run.phase === 'done',
        JSON.stringify({ start: res.run?.tier, tier: run?.tier, llm: run?.triage?.llm, plan: run?.plan?.status, plans: plans.length, phase: run?.phase, err: run?.error })
      )
      if (id) ctl.abandonRun(id)
    }

    {
      const r = evRepo('ev-t3-keep')
      twelve(r)
      claudeSays(['Plan: cover the files.', 'GAPS: 0\nPASS'])
      const c0 = claudeRows().length
      const { id, run } = await go(T2TASK, r, true)
      const plans = planSpawns(c0)
      check(
        'T3 tripwire keeps an approved plan',
        run?.tier === 'T3' && run.plan?.status === 'approved' && plans.length === 1 && (run.phase === 'done' || run.phase === 'review'),
        JSON.stringify({ tier: run?.tier, plan: run?.plan?.status, plans: plans.length, phase: run?.phase, err: run?.error })
      )
      if (id) ctl.abandonRun(id)
    }

    {
      const retryLog = join(temp, 'retry-log.txt')
      writeFileSync(retryLog, '')
      process.env.RETRY_LOG = retryLog
      const missBin = join(temp, 'retry-miss-grok')
      const hitBin = join(temp, 'retry-hit-grok')
      writeFileSync(missBin, "#!/usr/bin/env node\nconst fs = require('fs')\nfs.appendFileSync(process.env.RETRY_LOG, 'miss\\n')\nprocess.stdout.write('nope\\n')\n")
      writeFileSync(
        hitBin,
        "#!/usr/bin/env node\nconst fs = require('fs')\nfs.appendFileSync(process.env.RETRY_LOG, 'hit\\n')\nprocess.stdout.write(JSON.stringify({ type: 'text', data: JSON.stringify({ size: 'T1', risk: 'none', reason: 'small' }) }) + '\\n')\n"
      )
      chmodSync(missBin, 0o755)
      chmodSync(hitBin, 0o755)
      const r = evRepo('ev-retry')
      touch(r)
      triageBin = missBin
      const p0 = promptCount()
      const held = await go(T1TASK, r, false)
      const heldPrompts = promptCount() - p0
      let threw = ''
      if (held.run?.phase === 'triage' && held.run.needsProceed && held.run.triage.llm?.skipped) {
        triageBin = hitBin
        try {
          ctl.decideRun(held.id, 'retry-triage')
        } catch (e) {
          threw = String((e as Error).message || e)
        }
      }
      const run = threw ? held.run : await ctl.settle(held.id)
      const log = readFileSync(retryLog, 'utf8')
      restoreEcho()
      delete process.env.RETRY_LOG
      const pane = readFileSync(join(rootRepo, 'src/renderer/src/FactoryPane.tsx'), 'utf8')
      const at = pane.indexOf("run.phase === 'triage' && run.needsProceed")
      const card = pane.slice(at, pane.indexOf('planWaiting', at))
      const actions = card.slice(card.indexOf('factory-actions'))
      const ghostAt = actions.lastIndexOf('llm?.skipped')
      const ghost = actions.slice(ghostAt, actions.indexOf(': null', ghostAt))
      const paneOk =
        card.includes("? 'Model triage did not answer' : `${run.triage.llm?.by === 'jev' ? 'Jev' : 'Grok'} says this is critical risk`") &&
        (card.match(/Proceed at/g) || []).length === 1 &&
        ghost.includes('Retry triage') &&
        ghost.includes("'retry-triage'") &&
        ghost.includes('className="ghost"') &&
        !ghost.includes('says this is critical risk')
      check(
        'RETRY_TRIAGE',
        !threw &&
          heldPrompts === 0 &&
          held.run?.needsProceed === true &&
          log.includes('miss') &&
          log.indexOf('miss') < log.indexOf('hit') &&
          run?.needsProceed !== true &&
          run?.triage.llm?.size === 'T1' &&
          !run?.triage.llm?.skipped &&
          paneOk,
        JSON.stringify({ threw, held: held.run?.phase, np: held.run?.needsProceed, heldPrompts, log, after: run?.phase, llm: run?.triage?.llm, paneOk })
      )
      if (held.id) ctl.abandonRun(held.id)
    }

    {
      const slowLog = join(temp, 'slow-argv.txt')
      writeFileSync(slowLog, '')
      process.env.SLOW_ARGV = slowLog
      const slowBin = join(temp, 'slow-grok')
      writeFileSync(
        slowBin,
        "#!/usr/bin/env node\nconst fs = require('fs')\nfs.appendFileSync(process.env.SLOW_ARGV, JSON.stringify(process.argv.slice(2)) + '\\n')\nsetTimeout(() => {\n  process.stdout.write(JSON.stringify({ type: 'text', data: JSON.stringify({ size: 'T3', risk: 'none', reason: 'program' }) }) + '\\n')\n  process.exit(0)\n}, 10000)\n"
      )
      chmodSync(slowBin, 0o755)
      const r = evRepo('ev-slow')
      const rules = triageMod.triage(HINDI)
      const expected = tllm.grokTriageArgs(tllm.triagePrompt(HINDI, rules))
      let early = false
      const c0 = claudeRows().length
      promptPlan = async (o) => {
        if (!/Phase: (build|fix)\./.test(o.text)) return
        if (planSpawns(c0).length === 0) early = true
        writeFileSync(join(r, 'src', 'a.ts'), 'export const a = 7\n')
      }
      triageBin = slowBin
      claudeSays(['Plan: the translation work.', 'GAPS: 0\nPASS'])
      const { res, id, run } = await go(HINDI, r, true)
      restoreEcho()
      delete process.env.SLOW_ARGV
      const loggedLine = existsSync(slowLog) ? readFileSync(slowLog, 'utf8').trim().split('\n')[0] || '' : ''
      let logged: string[] = []
      try {
        logged = JSON.parse(loggedLine) as string[]
      } catch {
        logged = []
      }
      const plans = planSpawns(c0)
      const flags = (a: string[]) => a.map((x, i) => (i === 1 ? `prompt:${x.length}` : x)).join(' ')
      check(
        'TRIAGE_SLOW_RAISED plan',
        rules.original === 'T1' &&
          rules.risk === 'none' &&
          res.run?.tier === 'T1' &&
          JSON.stringify(logged) === JSON.stringify(expected) &&
          run?.tier === 'T3' &&
          !!run.plan?.text &&
          plans.length === 1 &&
          String(plans[0]?.argv[1] || '').includes(CONTRACT) &&
          !early,
        JSON.stringify({ rules: rules.original, risk: rules.risk, start: res.run?.tier, tier: run?.tier, phase: run?.phase, err: run?.error, early, plans: plans.length, got: flags(logged), want: flags(expected) })
      )
      if (id) ctl.abandonRun(id)
    }

    const sleeper = join(temp, 'sleeper-grok')
    writeFileSync(sleeper, '#!/usr/bin/env node\nsetTimeout(() => {}, 70000)\n')
    chmodSync(sleeper, 0o755)
    const missed = async (name: string, task: string, through: boolean, says: string[]) => {
      restoreEcho()
      const r = evRepo(name)
      promptPlan = async () => {}
      claudeSays(says)
      const p0 = promptCount()
      const c0 = claudeRows().length
      triageBin = sleeper
      const out = await go(task, r, through)
      restoreEcho()
      if (out.id) ctl.abandonRun(out.id)
      return { ...out, prompts: promptCount() - p0, plans: planSpawns(c0).length }
    }
    {
      const m = await missed('ev-miss-t1', T1TASK, true, [])
      check(
        'TRIAGE_MISSED_HOLDS',
        m.run?.phase === 'triage' && m.run.needsProceed === true && m.prompts === 0,
        JSON.stringify({ phase: m.run?.phase, np: m.run?.needsProceed, prompts: m.prompts, err: m.run?.error, skipped: m.run?.triage?.llm?.skipped })
      )
    }
    {
      const m = await missed('ev-miss-t0', 'fix typo in footer', true, [])
      check(
        'TRIAGE_MISSED_T0_HOLDS',
        m.run?.phase === 'triage' && m.run.needsProceed === true && m.prompts === 0 && m.res.run?.tier === 'T0',
        JSON.stringify({ phase: m.run?.phase, np: m.run?.needsProceed, prompts: m.prompts, start: m.res.run?.tier, err: m.run?.error })
      )
    }
    {
      const m = await missed('ev-miss-t2', T2TASK, false, ['Plan: from a missed triage.'])
      check(
        'TRIAGE_MISSED_T2_PLANS',
        m.run?.phase === 'plan' && m.plans === 1 && m.prompts === 0,
        JSON.stringify({ phase: m.run?.phase, plans: m.plans, prompts: m.prompts, err: m.run?.error, tier: m.run?.tier })
      )
    }
    // Jev triage: first model call, Grok only when Jev misses. Fake askJev, never the network.
    {
      const tjev = (await import(src('factory/triage-jev.ts'))) as typeof import('../src/main/factory/triage-jev.ts')
      type JevAsk = import('../src/main/factory/triage-jev.ts').JevAsk
      type JevCall = Parameters<JevAsk>[0]
      const jevCalls: JevCall[] = []
      let jevSays: (o: JevCall) => ReturnType<JevAsk> = async () => null
      const fakeJev: JevAsk = (o) => {
        jevCalls.push(o)
        return jevSays(o)
      }
      const answer = (size: string, risk: string, sc = 0.9, rc = 0.8) => ({
        model: 'jev-fake-served',
        usage: { input_tokens: 600, output_tokens: 80 },
        answers: { size: { type: 'choice', choice: size, confidence: sc }, risk: { type: 'choice', choice: risk, confidence: rc } }
      })
      const grokLog = join(temp, 'jev-grok-log.txt')
      writeFileSync(grokLog, '')
      process.env.JEV_GROK_LOG = grokLog
      const logEcho = join(temp, 'jev-echo-grok')
      writeFileSync(
        logEcho,
        `#!/usr/bin/env node
require('fs').appendFileSync(process.env.JEV_GROK_LOG, Date.now() + '\\n')
const i = process.argv.indexOf('-p')
const prompt = i >= 0 ? String(process.argv[i + 1] || '') : ''
const m = /Rules said: (T[0-3]) \\((none|elevated|critical)\\)/.exec(prompt)
process.stdout.write(JSON.stringify({ type: 'text', data: JSON.stringify({ size: m ? m[1] : 'T1', risk: m ? m[2] : 'none', reason: 'agrees' }) }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'end', usage: { input_tokens: 9, output_tokens: 1 }, num_turns: 1, total_cost_usd: 0, modelUsage: { 'grok-fake-served': { costUSD: 0 } } }) + '\\n')
`
      )
      const failGrok = join(temp, 'jev-fail-grok')
      writeFileSync(failGrok, "#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.JEV_GROK_LOG, Date.now() + '\\n')\nprocess.exit(3)\n")
      chmodSync(logEcho, 0o755)
      chmodSync(failGrok, 0o755)
      const grokTimes = () => readFileSync(grokLog, 'utf8').trim().split('\n').filter(Boolean).map(Number)
      const jevRows = (run: Awaited<ReturnType<typeof ctl.settle>>) => (run?.usage || []).filter((u) => u.phase === 'triage' && u.cli === 'jev')
      const grokRows = (run: Awaited<ReturnType<typeof ctl.settle>>) => (run?.usage || []).filter((u) => u.phase === 'triage' && u.cli === 'grok')
      const left = (run: Awaited<ReturnType<typeof ctl.settle>>) => run?.phase !== 'triage' && run?.needsProceed !== true
      const jevGo = async (name: string, task: string, o: { through?: boolean; proceedCritical?: boolean; grok?: string; plan?: string[] } = {}) => {
        use({ askJev: fakeJev, jevTimeoutMs: 300 })
        triageBin = o.grok || logEcho
        const r = evRepo(name)
        touch(r)
        claudeSays(o.plan || ['GAPS: 0\nPASS'])
        const calls0 = jevCalls.length
        const grok0 = grokTimes().length
        const p0 = promptCount()
        const c0 = claudeRows().length
        const t0 = Date.now()
        const res = ctl.startRun({ task, workRepo: r, brainPath: brainEv, runThrough: !!o.through, proceedCritical: o.proceedCritical })
        const id = res.ok ? res.run.id : ''
        const run = id ? await ctl.settle(id) : null
        return { res, id, run, t0, jev: jevCalls.length - calls0, grok: grokTimes().length - grok0, grokAt: grokTimes()[grok0], prompts: promptCount() - p0, plans: planSpawns(c0).length }
      }

      {
        const task = 'fix the label on the save button'
        const rules = triageMod.triage(task)
        jevSays = async () => answer('T3', 'none')
        const g = await jevGo('jev-raises', task, { plan: ['Plan: the label work.'] })
        const call = jevCalls.at(-1)
        const row = jevRows(g.run)[0]
        check(
          'JEV_RAISES',
          rules.size === 'T0' &&
            rules.risk === 'none' &&
            g.jev === 1 &&
            JSON.stringify(call?.state) === JSON.stringify({ task }) &&
            call?.questions === tjev.JEV_TRIAGE_QUESTIONS &&
            g.run?.tier === 'T3' &&
            g.plans === 1 &&
            g.prompts === 0 &&
            g.grok === 0 &&
            row?.model === 'jev-fake-served' &&
            row.inTokens === 600 &&
            row.outTokens === 80 &&
            row.ok === true &&
            g.run?.triage.llm?.by === 'jev' &&
            g.run.triage.reasons.some((x) => x.startsWith('Jev raised this to T3')),
          JSON.stringify({ rules, jev: g.jev, grok: g.grok, plans: g.plans, prompts: g.prompts, row, run: snap(g.run), reasons: g.run?.triage.reasons })
        )
        if (g.id) ctl.abandonRun(g.id)
      }
      {
        const task = 'add a new page for Stripe checkout'
        const rules = triageMod.triage(task)
        jevSays = async () => answer('T0', 'none')
        const g = await jevGo('jev-never-lowers', task, { proceedCritical: true, plan: ['Plan: checkout page.'] })
        check(
          'JEV_NEVER_LOWERS',
          rules.size === 'T2' && rules.risk === 'critical' && g.jev === 1 && g.run?.tier === rules.size && g.run?.risk === rules.risk,
          JSON.stringify({ rules: { size: rules.size, risk: rules.risk }, jev: g.jev, run: snap(g.run), risk: g.run?.risk })
        )
        if (g.id) ctl.abandonRun(g.id)
      }
      {
        jevSays = async () => null
        const g = await jevGo('jev-miss', T1TASK, { through: true })
        const jr = jevRows(g.run)
        const gr = grokRows(g.run)
        check(
          'JEV_MISS_GROK_RUNS',
          g.jev === 1 && g.grok === 1 && g.run?.triage.llm?.by === 'grok' && jr.length === 1 && jr[0].ok === false && gr.length === 1 && gr[0].ok === true && left(g.run) && g.prompts > 0,
          JSON.stringify({ jev: g.jev, grok: g.grok, jr, gr, prompts: g.prompts, run: snap(g.run) })
        )
        if (g.id) ctl.abandonRun(g.id)
      }
      {
        jevSays = async () => {
          throw new Error('network down')
        }
        const g = await jevGo('jev-throws', T1TASK, { through: true })
        const jr = jevRows(g.run)
        check('JEV_THROWS', g.jev === 1 && g.grok === 1 && jr.length === 1 && jr[0].ok === false && left(g.run), JSON.stringify({ jev: g.jev, grok: g.grok, jr, run: snap(g.run) }))
        if (g.id) ctl.abandonRun(g.id)
      }
      {
        jevSays = async () => answer('T9', 'none')
        const g = await jevGo('jev-junk', T1TASK, { through: true })
        const jr = jevRows(g.run)
        check('JEV_JUNK', g.jev === 1 && g.grok === 1 && jr.length === 1 && jr[0].ok === false && left(g.run), JSON.stringify({ jev: g.jev, grok: g.grok, jr, run: snap(g.run) }))
        if (g.id) ctl.abandonRun(g.id)
      }
      {
        let sawAbort = false
        jevSays = (o) =>
          new Promise((_resolve, reject) => {
            o.signal?.addEventListener('abort', () => {
              sawAbort = true
              reject(new Error('aborted'))
            })
          })
        const g = await jevGo('jev-hangs', T1TASK, { through: true })
        const jr = jevRows(g.run)
        const signal = jevCalls.at(-1)?.signal
        check(
          'JEV_HANGS',
          g.jev === 1 &&
            g.grok === 1 &&
            !!g.grokAt &&
            g.grokAt - g.t0 < 2000 &&
            sawAbort &&
            signal?.aborted === true &&
            jr.length === 1 &&
            jr[0].ok === false &&
            !!g.run?.triage.reasons.includes('Jev skipped: Jev timed out after 0.3 s.') &&
            left(g.run),
          JSON.stringify({ jev: g.jev, grok: g.grok, after: g.grokAt ? g.grokAt - g.t0 : null, sawAbort, jr, reasons: g.run?.triage.reasons, run: snap(g.run) })
        )
        if (g.id) ctl.abandonRun(g.id)
      }
      {
        jevSays = async () => answer('T1', 'critical')
        const g = await jevGo('jev-critical', T1TASK, { through: true })
        check(
          'JEV_CRITICAL_HOLDS',
          g.jev === 1 && g.grok === 0 && g.run?.phase === 'triage' && g.run.needsProceed === true && g.prompts === 0 && g.run.triage.llm?.by === 'jev' && g.run.risk === 'critical',
          JSON.stringify({ jev: g.jev, grok: g.grok, prompts: g.prompts, run: snap(g.run) })
        )
        if (g.id) ctl.abandonRun(g.id)
      }
      {
        jevSays = async () => null
        const g = await jevGo('jev-both-miss', T1TASK, { through: true, grok: failGrok })
        const held = g.run
        const skipped = String(held?.triage.llm?.skipped || '')
        jevSays = async () => answer('T1', 'none')
        const jev0 = jevCalls.length
        const grok0 = grokTimes().length
        let threw = ''
        try {
          if (g.id) ctl.decideRun(g.id, 'retry-triage')
        } catch (e) {
          threw = String((e as Error).message || e)
        }
        const after = g.id && !threw ? await ctl.settle(g.id) : null
        check(
          'JEV_BOTH_MISS_HOLDS',
          g.jev === 1 &&
            g.grok === 1 &&
            held?.phase === 'triage' &&
            held.needsProceed === true &&
            skipped.includes('Jev did not answer') &&
            skipped.includes('grok exited 3') &&
            !threw &&
            jevCalls.length - jev0 === 1 &&
            grokTimes().length - grok0 === 0 &&
            left(after) &&
            after?.triage.llm?.by === 'jev',
          JSON.stringify({ jev: g.jev, grok: g.grok, held: snap(held), skipped, threw, jevMore: jevCalls.length - jev0, grokMore: grokTimes().length - grok0, after: snap(after) })
        )
        if (g.id) ctl.abandonRun(g.id)
      }
      {
        const q = tjev.JEV_TRIAGE_QUESTIONS
        const prompt = tllm.triagePrompt('x', triageMod.triage('x'))
        const lits = {
          T0: 'One-file copy, wording, or style fix. No logic change.',
          T1: 'Small fix inside existing patterns: up to 3 files, no new dependency, no migration.',
          T2: 'One feature or fix that spans several files: new route, component, API, or shared types; up to about 10 files.',
          T3: 'Two or more separate features or fixes bundled in one task, or a rewrite, migration, cross-repo work, or more than about 10 files.'
        }
        const risks = {
          none: 'None of the others: UI, copy, tests, docs, internal refactors.',
          elevated: 'API endpoints, config or env, dependencies, runtime behavior (cache, cron, queues), outbound email or SMS, security headers, sessions.',
          critical: 'Payments, authentication, secrets or keys or encryption, database schema or migrations, user data deletion, access control.'
        }
        const runnerSrc = readFileSync(join(rootRepo, 'src', 'main', 'factory', 'eval', 'runner.ts'), 'utf8')
        check(
          'JEV_CRITERIA_ONE_SOURCE',
          q.size.criteria === tllm.SIZE_CRITERIA &&
            q.risk.criteria === tllm.RISK_CRITERIA &&
            JSON.stringify(tllm.SIZE_CRITERIA) === JSON.stringify(lits) &&
            JSON.stringify(tllm.RISK_CRITERIA) === JSON.stringify(risks) &&
            [...Object.values(lits), ...Object.values(risks)].every((v) => prompt.includes(v)) &&
            !prompt.includes('one-file copy or style fix') &&
            !prompt.includes('critical for payments') &&
            /import \{[^}]*JEV_TRIAGE_QUESTIONS[^}]*\} from '\.\.\/triage-jev\.ts'/.test(runnerSrc) &&
            runnerSrc.includes('questions: JEV_TRIAGE_QUESTIONS'),
          prompt
        )
      }
      {
        const ipcSrc = readFileSync(join(rootRepo, 'src', 'main', 'factory', 'ipc.ts'), 'utf8')
        const cfg = ipcSrc.slice(ipcSrc.indexOf('configureFactory({'), ipcSrc.indexOf('ipcMain.handle', ipcSrc.indexOf('configureFactory({')))
        check('JEV_IPC_WIRED', /import \{ askJev \} from '\.\.\/skin\/typesafe'/.test(ipcSrc) && /\baskJev\b/.test(cfg), cfg)
      }
      {
        const pane = readFileSync(join(rootRepo, 'src', 'renderer', 'src', 'FactoryPane.tsx'), 'utf8')
        check(
          'JEV_PANE',
          pane.includes("'Checking size and risk'") && pane.includes("`${run.triage.llm?.by === 'jev' ? 'Jev' : 'Grok'} says this is critical risk`") && !pane.includes('Checking size with Grok')
        )
      }
      delete process.env.JEV_GROK_LOG
      use()
      restoreEcho()
    }
    restoreEcho()
    promptPlan = async () => {}
  }

  // h. Argv pins.
  {
    check('EV h opusArgs pin', JSON.stringify(opusMod.opusArgs('p')) === JSON.stringify(['-p', 'p', '--model', 'opus', '--effort', 'medium', '--permission-mode', 'plan', '--output-format', 'json']))
    check('EV h opusBuildArgs pin', JSON.stringify(opusMod.opusBuildArgs('p')) === JSON.stringify(['-p', 'p', '--model', 'opus', '--effort', 'medium', '--permission-mode', 'bypassPermissions', '--output-format', 'json']))
    check('EV h grokTriageArgs pin', JSON.stringify(tllm.grokTriageArgs('p')) === JSON.stringify(['-p', 'p', '--effort', 'low', '--max-turns', '1', '--permission-mode', 'plan', '--no-subagents', '--disable-web-search', '--output-format', 'streaming-json']))
    const g47 = tllm.grokTriageArgs('p', { model: 'grok-4.7' })
    const son = opusMod.opusArgs('p', { model: 'sonnet', effort: 'high' })
    check('EV h options change only model and effort', g47.join(' ').endsWith('-m grok-4.7') && son[son.indexOf('--model') + 1] === 'sonnet' && son[son.indexOf('--effort') + 1] === 'high')
    const pane = readFileSync(join(rootRepo, 'src', 'renderer', 'src', 'FactoryPane.tsx'), 'utf8')
    check('EV h Approve in advance and Ship in advance still default on', /const \[runThrough, setRunThrough\] = useState\(true\)/.test(pane) && /const \[shipThrough, setShipThrough\] = useState\(true\)/.test(pane))
  }
  ctl.configureFactory(fakeDeps)
}

// 12. Store only under userData; neither repo sees it.
{
  check('12 factoryDir is under userData, not the brain or work repo', underPath(realish(userData), realish(store.factoryDir())) && !underPath(realish(brainA), realish(store.factoryDir())) && !underPath(realish(work), realish(store.factoryDir())))
  const brainDirty = git(brainA, ['status', '--porcelain', '--untracked-files=all']).split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
  check('12 work repo is clean and the brain only has factory-log.md records after runs', git(work, ['status', '--porcelain']).trim() === '' && brainDirty.length > 0 && brainDirty.every((p) => p.split('/').at(-1) === 'factory-log.md'), JSON.stringify(brainDirty))
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

check('NO_LIVE_JEV', liveJev.length === 0, liveJev.join(' '))

const pass = results.every((r) => r.ok)
const out = [...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok || !r.detail ? '' : `  ${r.detail}`}`), '', pass ? 'FACTORY_PASS' : 'FACTORY_FAIL'].join('\n')
writeFileSync(join(temp, 'out.txt'), out)
console.log(out)
console.log(`\nartifact: ${join(temp, 'out.txt')}`)
process.exit(pass ? 0 : 1)
