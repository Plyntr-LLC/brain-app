import { createRequire, registerHooks } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Drives the real main-process modules: plyntr-seats, plyntr-sync, write-guard-role,
// write-guard, brain-sync, session-token and the IPC handlers in ipc-stubs. Electron is
// stubbed so ipcMain.handle records handlers and app.getPath points at a temp userData.

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const esbuild = createRequire(join(rootRepo, 'package.json'))('esbuild') as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code: string }
}

const electronStub = `
const handlers = globalThis.__ipc ||= new Map()
export const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on() {}, removeHandler(name) { handlers.delete(name) } }
export const app = { getPath: () => globalThis.__userData, getAppPath: () => globalThis.__appPath, getVersion: () => '0.0.0', getName: () => 'Brain', isPackaged: false, on() {}, whenReady: () => Promise.resolve() }
export const BrowserWindow = { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null }
export const dialog = {}
export const shell = {}
export const clipboard = { readText: () => '' }
export const nativeImage = {}
export const Tray = class {}
export const Menu = {}
export const screen = {}
export const session = {}
export const net = {}
export const safeStorage = {}
export const powerMonitor = {}
export const Notification = class {}
export const protocol = {}
export const webContents = {}
export const nativeTheme = {}
export const systemPreferences = {}
export default { ipcMain, app }
`
const updaterStub = `
const n = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : n), apply: () => n })
export const autoUpdater = n
export default { autoUpdater: n }
`

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if (spec === 'electron-updater') return { url: 'stub:electron-updater', shortCircuit: true }
    if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !/\.(ts|js|mjs|cjs|json)$/.test(spec)) {
      const base = resolvePath(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === 'stub:electron') return { format: 'module', shortCircuit: true, source: electronStub }
    if (url === 'stub:electron-updater') return { format: 'module', shortCircuit: true, source: updaterStub }
    if (url.startsWith('file:') && url.endsWith('.ts') && url.includes('/src/')) {
      const code = esbuild.transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' }).code
      return { format: 'module', shortCircuit: true, source: code }
    }
    return next(url, ctx)
  }
})

type Handler = (event: unknown, ...args: unknown[]) => unknown
const g = globalThis as unknown as {
  __ipc: Map<string, Handler>
  __userData: string
  __appPath: string
  fetch: typeof fetch
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
}

delete process.env.BRAIN_APP_DRY_RUN
g.__appPath = rootRepo
const phase = String(process.env.SHELL_CHECK_PHASE || '')
g.__userData = phase ? String(process.env.SHELL_CHECK_DIR) : mkdtempSync(join(tmpdir(), 'shell-'))

// The worker. /v1/invites/resolve answers with the next queued code. /v1/git/token records the bearer.
let nextCode: Record<string, unknown> | null = null
const bearers: string[] = []
// Company setup routes answer from here, keyed by method and path.
const companyReplies: Record<string, Record<string, unknown>> = {}
const platformBearers: string[] = []
g.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const headers = (init?.headers || {}) as Record<string, string>
  if (url.pathname === '/v1/invites/resolve' && nextCode) {
    return new Response(JSON.stringify(nextCode), { status: 200 })
  }
  const company = companyReplies[`${init?.method || 'GET'} ${url.pathname}`]
  if (company) {
    platformBearers.push(String(headers.Authorization || '').replace(/^Bearer /, ''))
    return new Response(JSON.stringify(company), { status: 200 })
  }
  if (url.pathname === '/v1/git/token') {
    bearers.push(String(headers.Authorization || '').replace(/^Bearer /, ''))
    return new Response(JSON.stringify({ token: '', repo: '' }), { status: 200 })
  }
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
}) as typeof fetch

// Watch the sync timer that startBrainSync sets and stopBrainSync clears.
const liveTimers = new Set<unknown>()
const realSet = setInterval
const realClear = clearInterval
g.setInterval = ((fn: () => void, ms?: number) => {
  const handle = realSet(fn, ms)
  handle.unref?.()
  liveTimers.add(handle)
  return handle
}) as typeof setInterval
g.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
  liveTimers.delete(handle)
  realClear(handle)
}) as typeof clearInterval

const vault = await import('../src/main/shell-vault.ts')
const seats = await import('../src/main/plyntr-seats.ts')
const guardRole = await import('../src/main/write-guard-role.ts')
const guard = await import('../src/main/write-guard.ts')
const plyntrSync = await import('../src/main/plyntr-sync.ts')
const brainSync = await import('../src/main/brain-sync.ts')
const sessionToken = await import('../src/main/session-token.ts')
const brainsMod = await import('../src/main/brains.ts')
const ipcStubs = await import('../src/main/ipc-stubs.ts')
const { allowedFolders, isJoeSuperAdmin, openBrainAccountLabel, showAddCompany, showBrainSwitch } = await import('../src/shared/shell-switch.ts')
ipcStubs.registerStubIpc()

const out: Record<string, unknown> = {}
const misses: string[] = []

function miss(name: string): void {
  misses.push(name)
}

function eq(name: string, got: unknown, want: unknown): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a !== b) miss(`${name} got ${a} want ${b}`)
}

async function ipc(name: string, ...args: unknown[]): Promise<unknown> {
  const fn = g.__ipc.get(name)
  if (!fn) throw new Error(`no handler ${name}`)
  return await fn({}, ...args)
}

async function ipcThrows(name: string, ...args: unknown[]): Promise<string> {
  try {
    await ipc(name, ...args)
    return ''
  } catch (err) {
    return String((err as Error).message || err)
  }
}

function useDir(dir: string): void {
  g.__userData = dir
  vault.useRoot(dir)
  sessionToken.clearAccount()
  brainSync.stopBrainSync()
}

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shell-'))
  useDir(dir)
  return dir
}

function vaultBytes(): string {
  const file = join(vault.vaultDir(), 'vault.json')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** The stored row exactly as it sits in vault.json. */
function rowBytes(id: string): string {
  const raw = vaultBytes()
  const at = raw.indexOf(`{"id":${JSON.stringify(id)},`)
  if (at < 0) return ''
  return raw.slice(at, raw.indexOf('}', at) + 1)
}

function legacyPath(): string {
  return join(vault.vaultDir(), 'plyntr-seats.json')
}

function view() {
  return vault.shellView()
}

/** Bearer the real git-token call sends for this id. */
async function bearer(id: string): Promise<string> {
  bearers.length = 0
  await plyntrSync.plyntrGitToken(id).catch(() => null)
  return bearers[0] || ''
}

async function four(id: string): Promise<{ folder: string; brain: string; git: string; role: string }> {
  return {
    folder: seats.seatTokenForFolder(id),
    brain: seats.seatTokenForBrain(id),
    git: await bearer(id),
    role: guardRole.roleForBrainWrite(id)
  }
}

async function tokenTrio(id: string): Promise<string[]> {
  return [seats.seatTokenForFolder(id), seats.seatTokenForBrain(id), await bearer(id)]
}

async function readersEmpty(id: string): Promise<boolean> {
  const f = await four(id)
  return f.folder === '' && f.brain === '' && f.git === '' && f.role === '' && vault.activeToken() === '' && vault.activeRole() === ''
}

const EMPTY = { folder: '', brain: '', git: '', role: '' }
const seat = (token: string, role: string) => ({ folder: token, brain: token, git: token, role })

/** A brain folder on disk, bound to a brain id in brains.json. Local sync so a switch starts no watcher. */
function brainFolder(brainId: string): string {
  const path = mkdtempSync(join(tmpdir(), 'brain-'))
  mkdirSync(join(path, 'skills'), { recursive: true })
  mkdirSync(join(path, '.team-config'), { recursive: true })
  writeFileSync(join(path, 'skills', 'offer.md'), 'before')
  writeFileSync(join(path, '.team-config', 'notes.md'), 'before')
  writeFileSync(join(path, 'notes.md'), 'before')
  if (brainId) brainsMod.rememberBrain({ path, name: brainId, slug: brainId, brainId, syncMode: 'local' })
  return path
}

/** files:write through the real handler. Returns the refusal, or '' when the write landed. */
async function writeThrough(folder: string, rel: string): Promise<string> {
  const abs = join(folder, rel)
  writeFileSync(abs, 'before')
  const err = await ipcThrows('files:write', folder, abs, 'after')
  const landed = readFileSync(abs, 'utf8') === 'after'
  if (err && landed) miss(`files:write ${rel} refused but wrote`)
  if (!err && !landed) miss(`files:write ${rel} neither refused nor wrote`)
  return err
}

/** files:write where the file must keep its bytes between writes (the team file). */
async function writeThroughKeep(folder: string, rel: string, keep: string): Promise<string> {
  const abs = join(folder, rel)
  writeFileSync(abs, keep)
  const err = await ipcThrows('files:write', folder, abs, keep + ' ')
  const landed = readFileSync(abs, 'utf8') === keep + ' '
  if (err && landed) miss(`files:write ${rel} refused but wrote`)
  if (!err && !landed) miss(`files:write ${rel} neither refused nor wrote`)
  writeFileSync(abs, keep)
  return err
}

/** A Plyntr code typed on the sign-in screen, through the real auth:verify handler. */
async function verifyCode(typed: string, code: { brainId: string; email: string; role: string; seatToken: string; repo?: string }): Promise<Record<string, unknown>> {
  nextCode = { name: 'Brain', label: 'Brain', bootstrap: false, repo: code.repo || `org/${code.brainId}-brain`, ...code }
  try {
    return (await ipc('auth:verify', typed, 'ABCD-EFGH-JK', 'plyntr')) as Record<string, unknown>
  } finally {
    nextCode = null
  }
}

/** The wizard's code screen, through the real plyntr:resolve handler. */
async function resolveCode(typed: string, code: { brainId: string; email: string; role: string; seatToken: string; repo?: string }): Promise<Record<string, unknown>> {
  nextCode = { name: 'Brain', label: 'Brain', bootstrap: false, repo: code.repo || `org/${code.brainId}-brain`, ...code }
  try {
    return (await ipc('plyntr:resolve', 'ABCD-EFGH-JK', typed)) as Record<string, unknown>
  } finally {
    nextCode = null
  }
}

/** Runs this script again in a new process on the same userData. That is a fresh load. */
function freshLoad(name: string, dir: string, extra: Record<string, string> = {}): void {
  const report = join(dir, `phase-${name}.json`)
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', self], {
    env: { ...process.env, ...extra, SHELL_CHECK_PHASE: name, SHELL_CHECK_DIR: dir, SHELL_CHECK_REPORT: report },
    encoding: 'utf8'
  })
  if (!existsSync(report)) {
    miss(`fresh load ${name} did not report (exit ${run.status}) ${String(run.stderr || '').split('\n').slice(0, 3).join(' ')}`)
    return
  }
  const got = JSON.parse(readFileSync(report, 'utf8')) as string[]
  for (const m of got) miss(`fresh ${name}: ${m}`)
}

// ---------------------------------------------------------------------------
// Fresh-load phases. Each runs in its own process, started by freshLoad().
// ---------------------------------------------------------------------------

async function runPhase(name: string): Promise<void> {
  const want = JSON.parse(String(process.env.SHELL_CHECK_WANT || '{}')) as Record<string, string>
  if (name === 'C') {
    eq('C startup shell', vault.shellEmail(), 'joe@plyntr.com')
    vault.signInEmailOnly('ada@client.com')
    eq('C rose bytes', rowBytes('rose'), want.rose)
    eq('C other bytes', rowBytes('other'), want.other)
    eq('C ada rose', await four('rose'), EMPTY)
    eq('C ada other', await four('other'), EMPTY)
    vault.discardMemory()
    eq('C resume', vault.resumeShellAccount(), 'ada@client.com')
    eq('C resume rose bytes', rowBytes('rose'), want.rose)
    eq('C resume other bytes', rowBytes('other'), want.other)
    return
  }
  if (name === 'D') {
    eq('D resume', vault.resumeShellAccount(), 'ada@client.com')
    eq('D ada', await four('ada-id'), seat('ada-owner', 'owner'))
    eq('D joe absent', await four('rose'), EMPTY)
    vault.signInEmailOnly('joe@plyntr.com')
    eq('D joe back', await four('rose'), seat('rose-owner', 'team'))
    return
  }
  if (name === 'H') {
    // Fresh load while Joe is still signed in. Log out, then a new person's code.
    eq('H2 startup shell', vault.shellEmail(), 'joe@plyntr.com')
    eq('H2 startup rose', await four('rose'), seat('rose-owner', 'team'))
    eq('H2 logout', await ipc('auth:logout'), { ok: true })
    eq('H2 shell empty', vault.shellEmail(), '')
    eq('H2 readers empty', (await readersEmpty('rose')) && (await readersEmpty('other')), true)
    sessionToken.saveAccount({ email: 'old@example.com', token: 'login:old', role: 'owner', source: 'plyntr' })
    await ipc('shell:view')
    eq('H2 view keeps empty', vault.shellEmail(), '')
    await verifyCode('ada@client.com', { brainId: 'new-id', email: 'plyntrllc@gmail.com', role: 'team', seatToken: 'new-token' })
    eq('H2 shell', vault.shellEmail(), 'ada@client.com')
    eq('H2 stored', await four('new-id'), seat('new-token', 'team'))
    eq('H2 row', JSON.parse(rowBytes('new-id') || '{}').email, 'plyntrllc@gmail.com')
    eq('H2 joe rose', await four('rose'), EMPTY)
    eq('H2 joe other', await four('other'), EMPTY)
    eq('H2 rose intact', rowBytes('rose'), want.rose)
    eq('H2 other intact', rowBytes('other'), want.other)
    eq('H2 session', ((await ipc('auth:session')) as { signedIn: boolean }).signedIn, true)
    vault.discardMemory()
    eq('H2 resume', vault.resumeShellAccount(), 'ada@client.com')
    eq('H2 resume four', await four('new-id'), seat('new-token', 'team'))
    eq('H2 resume joe', await four('rose'), EMPTY)
    return
  }
  if (name === 'H3') {
    // Fresh load after logout. Startup must not sign anyone in, and the code sets the typed email.
    eq('H3 startup shell', vault.shellEmail(), '')
    await verifyCode('bea@client.com', { brainId: 'bea-id', email: 'owner@client.com', role: 'owner', seatToken: 'bea-token' })
    eq('H3 shell', vault.shellEmail(), 'bea@client.com')
    eq('H3 stored', await four('bea-id'), seat('bea-token', 'owner'))
    eq('H3 rose intact', rowBytes('rose'), want.rose)
    eq('H3 joe empty', await four('rose'), EMPTY)
    vault.discardMemory()
    eq('H3 resume', vault.resumeShellAccount(), 'bea@client.com')
    return
  }
  miss(`unknown phase ${name}`)
}

if (phase) {
  await runPhase(phase)
  writeFileSync(String(process.env.SHELL_CHECK_REPORT), JSON.stringify(misses))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Steps from the plan.
// ---------------------------------------------------------------------------

// 1. Agency code for typed joe@plyntr.com: shell set, zero keys.
fresh()
vault.acceptBrainCode('', 'joe@plyntr.com', 'scout@example.com', '', '')
eq('s1 shell', vault.shellEmail(), 'joe@plyntr.com')
eq('s1 keys', vault.keyCount(), 0)
eq('s1 folders', allowedFolders(view()), [])
eq('s1 active', [vault.activeToken(), vault.activeRole()], ['', ''])
eq('s1 role', guardRole.roleForBrainWrite(''), '')
eq('s1 trio', await tokenTrio('none'), ['', '', ''])
vault.discardMemory()
eq('s1 resume', vault.resumeShellAccount(), 'joe@plyntr.com')
eq('s1 keys again', vault.keyCount(), 0)
eq('s1 folders again', allowedFolders(view()), [])

// 2. First Plyntr code, no shell, through auth:verify. Code email differs from typed email.
fresh()
const verified2 = await verifyCode('ada@client.com', { brainId: 'ada-brain', email: 'plyntrllc@gmail.com', role: 'team', seatToken: 'code-token' })
eq('s2 shell', vault.shellEmail(), 'ada@client.com')
eq('s2 row', JSON.parse(rowBytes('ada-brain') || '{}'), { id: 'ada-brain', email: 'plyntrllc@gmail.com', role: 'team', token: 'code-token', owner: 'ada@client.com', slug: 'ada-brain', repo: 'org/ada-brain-brain' })
eq('s2 trio', await tokenTrio('ada-brain'), ['code-token', 'code-token', 'code-token'])
eq('s2 active', [vault.activeToken(), vault.activeRole()], ['code-token', 'team'])
eq('s2 no token to renderer', JSON.stringify(verified2).includes('code-token'), false)
{
  const s = (await ipc('auth:session')) as { signedIn: boolean; role: string }
  eq('s2 session after code', [s.signedIn, s.role], [true, 'team'])
}
vault.discardMemory()
eq('s2 resume', vault.resumeShellAccount(), 'ada@client.com')
eq('s2 four', await four('ada-brain'), seat('code-token', 'team'))

// 2b. The wizard route stores once in main and returns hasToken, never the token.
fresh()
{
  const row = await resolveCode('ada@client.com', { brainId: 'wiz', email: 'plyntrllc@gmail.com', role: 'team', seatToken: 'wiz-token' })
  eq('s2b hasToken', row.hasToken, true)
  eq('s2b no seatToken key', 'seatToken' in row, false)
  eq('s2b no token value', JSON.stringify(row).includes('wiz-token'), false)
  eq('s2b shell', vault.shellEmail(), 'ada@client.com')
  eq('s2b stored', await four('wiz'), seat('wiz-token', 'team'))
  eq('s2b one row', vault.keyCount(), 1)
  eq('s2b slug', seats.brainIdForSlug('wiz'), 'wiz')
  const shown = await ipc('shell:view')
  eq('s2b view has no token', JSON.stringify(shown).includes('wiz-token'), false)
}

// 3. Agency code while Ada is signed in changes nothing.
fresh()
vault.acceptBrainCode('keep', 'ada@client.com', 'ada@client.com', 'team', 'keep-token')
const before3 = vaultBytes()
vault.acceptBrainCode('', 'ada@client.com', 'scout@example.com', '', '')
eq('s3 shell', vault.shellEmail(), 'ada@client.com')
eq('s3 bytes', vaultBytes(), before3)
eq('s3 count', vault.keyCount(), 1)

// 4. A second code under Ada stores the code values.
fresh()
vault.acceptBrainCode('first', 'ada@client.com', 'ada@client.com', 'owner', 'first-token')
vault.acceptBrainCode('second', 'ada@client.com', 'plyntrllc@gmail.com', 'team', 'second-token')
eq('s4 shell', vault.shellEmail(), 'ada@client.com')
eq('s4 row', JSON.parse(rowBytes('second') || '{}'), { id: 'second', email: 'plyntrllc@gmail.com', role: 'team', token: 'second-token', owner: 'ada@client.com', slug: '', repo: '' })

// 5. Two owners on one file. The file also carries a poison field and a shell login token,
// and account.json holds a login token and role. Readers must return only the stored key.
fresh()
vault.signInEmailOnly('joe@plyntr.com')
vault.acceptBrainCode('rose', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'rose-owner')
vault.signInEmailOnly('ada@client.com')
vault.acceptBrainCode('ada-id', 'ada@client.com', 'ada@client.com', 'owner', 'ada-owner')
{
  const file = join(vault.vaultDir(), 'vault.json')
  const disk = JSON.parse(readFileSync(file, 'utf8')) as { brains: Record<string, unknown>[] } & Record<string, unknown>
  disk.shellToken = 'shell-login-token'
  disk.brains = disk.brains.map((b) => ({ ...b, poison: 'poison-token' }))
  writeFileSync(file, JSON.stringify(disk))
  vault.discardMemory()
}
sessionToken.saveAccount({ email: 'joe@plyntr.com', token: 'shell-login-token', role: 'owner', source: 'plyntr' })
vault.signInEmailOnly('joe@plyntr.com')
eq('s5 joe rose', await four('rose'), seat('rose-owner', 'team'))
eq('s5 joe active', vault.activeToken(), 'rose-owner')
eq('s5 joe ada empty', await four('ada-id'), EMPTY)
vault.signInEmailOnly('ada@client.com')
eq('s5 ada own', await four('ada-id'), seat('ada-owner', 'owner'))
eq('s5 ada active', vault.activeToken(), 'ada-owner')
eq('s5 ada rose empty', await four('rose'), EMPTY)
vault.discardMemory()
eq('s5 resume ada', vault.resumeShellAccount(), 'ada@client.com')
eq('s5 resume readers', await four('ada-id'), seat('ada-owner', 'owner'))
eq('s5 joe absent', await four('rose'), EMPTY)
const adaRow5 = rowBytes('ada-id')
vault.signInEmailOnly('joe@plyntr.com')
vault.setFlag(true)
vault.acceptBrainCode('ada-id', 'joe@plyntr.com', 'joe@plyntr.com', 'owner', 'stolen')
eq('s5 flag on row', rowBytes('ada-id'), adaRow5)
eq('s5 flag on readers', await four('ada-id'), EMPTY)
vault.setFlag(false)
vault.acceptBrainCode('ada-id', 'joe@plyntr.com', 'joe@plyntr.com', 'owner', 'stolen-2')
eq('s5 flag off row', rowBytes('ada-id'), adaRow5)
eq('s5 flag off readers', await four('ada-id'), EMPTY)
vault.signInEmailOnly('ada@client.com')
eq('s5 ada still', await four('ada-id'), seat('ada-owner', 'owner'))
// D: fresh load while Ada was last.
freshLoad('D', vault.vaultDir())

// 6. Two Joe-owned brains.
fresh()
vault.acceptBrainCode('rose', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'rose-owner')
vault.acceptBrainCode('other', 'joe@plyntr.com', 'ada@client.com', 'owner', 'other-owner')
eq('s6 shell', vault.shellEmail(), 'joe@plyntr.com')
vault.discardMemory()
eq('s6 resume', vault.resumeShellAccount(), 'joe@plyntr.com')
eq('s6 rose', await four('rose'), seat('rose-owner', 'team'))
eq('s6 other', await four('other'), seat('other-owner', 'owner'))

// 7. Switch between two keyed brains. E: the git bearer follows the active seat.
fresh()
vault.acceptBrainCode('one', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'tok-one')
vault.acceptBrainCode('two', 'joe@plyntr.com', 'ada@client.com', 'owner', 'tok-two')
eq('s7 before', [seats.seatTokenForBrain('one'), seats.seatTokenForBrain('two')], ['tok-one', 'tok-two'])
const oneRow7 = rowBytes('one')
vault.switchShellBrain('two')
eq('s7 active', [vault.activeToken(), vault.activeRole()], ['tok-two', 'owner'])
eq('s7 label', openBrainAccountLabel(vault.activeSeat()), 'ada@client.com')
eq('s7 seat', vault.activeSeatId(), 'two')
eq('s7 shell', vault.shellEmail(), 'joe@plyntr.com')
eq('s7 still one', await four('one'), seat('tok-one', 'team'))
eq('s7 still two', await four('two'), seat('tok-two', 'owner'))
eq('s7 list', allowedFolders(view()), ['one', 'two'])
eq('s7 show', showBrainSwitch(view()), true)
eq('s7 bearer', await bearer(vault.activeSeatId()), 'tok-two')
eq('s7 bearer foreign', await bearer('nobody'), '')
eq('s7 one row', rowBytes('one'), oneRow7)

// 8. Company setup while Joe is signed in.
fresh()
vault.acceptBrainCode('warm', 'joe@plyntr.com', 'joe@plyntr.com', 'owner', 'warm-token')
const warm8 = rowBytes('warm')
vault.loginFromCompanySetup('co', 'plyntrllc@gmail.com', 'team', 'owner-redeemed')
eq('s8 shell', vault.shellEmail(), 'joe@plyntr.com')
eq('s8 trio', await tokenTrio('co'), ['owner-redeemed', 'owner-redeemed', 'owner-redeemed'])
eq('s8 active', [vault.activeToken(), vault.activeRole()], ['owner-redeemed', 'team'])
vault.signInEmailOnly('ada@client.com')
eq('s8 ada empty', await tokenTrio('co'), ['', '', ''])
eq('s8 ada active', vault.activeToken(), '')
vault.signInEmailOnly('joe@plyntr.com')
vault.discardMemory()
eq('s8 resume', vault.resumeShellAccount(), 'joe@plyntr.com')
eq('s8 four', await four('co'), seat('owner-redeemed', 'team'))
eq('s8 warm kept', rowBytes('warm'), warm8)

// I. Company setup while Ada is signed in changes nothing.
fresh()
vault.acceptBrainCode('warm', 'joe@plyntr.com', 'joe@plyntr.com', 'owner', 'warm-token')
const warmI = rowBytes('warm')
vault.signInEmailOnly('ada@client.com')
const adaBytesI = vaultBytes()
const adaSeatI = [vault.activeSeatId(), vault.activeToken(), vault.activeRole()]
vault.loginFromCompanySetup('nope', 'plyntrllc@gmail.com', 'team', 'should-not')
eq('sI shell', vault.shellEmail(), 'ada@client.com')
eq('sI seat', [vault.activeSeatId(), vault.activeToken(), vault.activeRole()], adaSeatI)
eq('sI four', await four('nope'), EMPTY)
eq('sI bytes', vaultBytes(), adaBytesI)
vault.signInEmailOnly('joe@plyntr.com')
eq('sI joe token', seats.seatTokenForBrain('warm'), 'warm-token')
eq('sI warm row', rowBytes('warm'), warmI)

// 9. Switcher visibility.
fresh()
eq('s9 zero show', showBrainSwitch(view()), false)
vault.acceptBrainCode('only', 'ada@client.com', 'ada@client.com', 'team', 'only-token')
eq('s9 one show', showBrainSwitch(view()), false)
vault.acceptBrainCode('b', 'ada@client.com', 'ada@client.com', 'team', 'b-token')
vault.acceptBrainCode('c', 'ada@client.com', 'ada@client.com', 'team', 'c-token')
eq('s9 three show', showBrainSwitch(view()), true)
eq('s9 three list', allowedFolders(view()), ['only', 'b', 'c'])

fresh()
vault.signInEmailOnly('joe@plyntr.com')
vault.setFlag(true)
vault.acceptBrainCode('rose', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'rose-owner')
vault.signInEmailOnly('ada@client.com')
vault.acceptBrainCode('ada-one', 'ada@client.com', 'ada@client.com', 'team', 'ada-one-token')
brainsMod.adoptFolder('agency', 'agency-seat')
eq('s9 ada show', showBrainSwitch(view()), false)
eq('s9 ada list', allowedFolders(view()), ['ada-one'])

fresh()
vault.signInEmailOnly('joe@plyntr.com')
vault.setFlag(true)
vault.acceptBrainCode('keyed', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'k')
brainsMod.adoptFolder('agency', 'agency-seat')
eq('s9 one plus keyless', showBrainSwitch(view()), true)
fresh()
vault.signInEmailOnly('joe@plyntr.com')
vault.setFlag(true)
brainsMod.adoptFolder('only-keyless', 'agency-seat')
eq('s9 keyless alone', showBrainSwitch(view()), false)
fresh()
vault.signInEmailOnly('joe@plyntr.com')
vault.setFlag(true)
brainsMod.adoptFolder('k1', 'agency-seat')
brainsMod.adoptFolder('k2', 'agency-seat')
vault.acceptBrainCode('rose', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'rose-owner')
eq('s9 two keyless plus rose', showBrainSwitch(view()), true)
fresh()
vault.signInEmailOnly('joe@plyntr.com')
vault.setFlag(true)
brainsMod.adoptFolder('k1', 'a')
brainsMod.adoptFolder('k2', 'b')
eq('s9 zero keyed list', allowedFolders(view()), ['k1', 'k2'])
eq('s9 zero keyed show', showBrainSwitch(view()), true)
vault.switchShellBrain('k1')
eq('s9 zero keyed count', vault.keyCount(), 0)
eq('s9 zero keyed rows', [rowBytes('k1').includes('token'), rowBytes('k2').includes('token')], [false, false])
eq('s9 zero keyed active', [vault.activeToken(), vault.activeRole()], ['', ''])

// 10. Ada cannot switch to a keyless folder or to Joe's brain. G: the whole file is untouched.
fresh()
vault.signInEmailOnly('joe@plyntr.com')
vault.acceptBrainCode('rose', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'rose-owner')
vault.signInEmailOnly('ada@client.com')
vault.acceptBrainCode('ada-one', 'ada@client.com', 'ada@client.com', 'team', 'ada-one-token')
brainsMod.adoptFolder('agency', 'agency-seat')
for (const id of ['agency', 'rose']) {
  const before = vaultBytes()
  const pre = [vault.shellEmail(), vault.activeSeatId(), vault.activeToken(), vault.activeRole(), ...(await tokenTrio('ada-one'))]
  let threw = false
  try {
    vault.switchShellBrain(id)
  } catch {
    threw = true
  }
  eq(`s10 throw ${id}`, threw, true)
  eq(`s10 bytes ${id}`, vaultBytes(), before)
  eq(`s10 readers ${id}`, [vault.shellEmail(), vault.activeSeatId(), vault.activeToken(), vault.activeRole(), ...(await tokenTrio('ada-one'))], pre)
  eq(`s10 owner ${id}`, JSON.parse(rowBytes('rose')).owner, 'joe@plyntr.com')
}

// 11. Ada with two brains switches between them. Add a company stays hidden.
fresh()
vault.signInEmailOnly('ada@client.com')
vault.acceptBrainCode('a1', 'ada@client.com', 'plyntrllc@gmail.com', 'team', 't1')
vault.acceptBrainCode('a2', 'ada@client.com', 'other@example.com', 'owner', 't2')
brainsMod.adoptFolder('agency', 'agency-seat')
eq('s11 show', showBrainSwitch(view()), true)
eq('s11 list', allowedFolders(view()), ['a1', 'a2'])
eq('s11 add', showAddCompany({ email: vault.shellEmail(), flag: view().flag }), false)
vault.switchShellBrain('a2')
eq('s11 moved', [vault.activeToken(), vault.activeRole()], ['t2', 'owner'])
{
  const before = vaultBytes()
  const pre = [vault.shellEmail(), vault.activeSeatId(), vault.activeToken(), vault.activeRole()]
  let rejected = false
  try {
    vault.switchShellBrain('agency')
  } catch {
    rejected = true
  }
  eq('s11 reject', rejected, true)
  eq('s11 bytes', vaultBytes(), before)
  eq('s11 readers', [vault.shellEmail(), vault.activeSeatId(), vault.activeToken(), vault.activeRole()], pre)
}

// 12. Super admin is only joe@plyntr.com with the flag on.
eq('joe on', isJoeSuperAdmin({ email: 'joe@plyntr.com', flag: true }), true)
eq('joe off', isJoeSuperAdmin({ email: 'joe@plyntr.com', flag: false }), false)
eq('ada on', isJoeSuperAdmin({ email: 'ada@client.com', flag: true }), false)
eq('other on', isJoeSuperAdmin({ email: 'other@plyntr.com', flag: true }), false)
eq('add joe', showAddCompany({ email: 'joe@plyntr.com', flag: true }), true)
eq('add joe off', showAddCompany({ email: 'joe@plyntr.com', flag: false }), false)
eq('add ada', showAddCompany({ email: 'ada@client.com', flag: true }), false)
eq('add other', showAddCompany({ email: 'other@plyntr.com', flag: true }), false)

fresh()
eq('s12 empty vault flag', view().flag, false)
vault.signInEmailOnly('other@plyntr.com')
vault.setFlag(true)
vault.acceptBrainCode('mine', 'other@plyntr.com', 'other@plyntr.com', 'team', 'mine-token')
brainsMod.adoptFolder('agency', 'agency-seat')
vault.signInEmailOnly('foreign@example.com')
vault.acceptBrainCode('foreign', 'foreign@example.com', 'foreign@example.com', 'team', 'foreign-token')
vault.signInEmailOnly('other@plyntr.com')
vault.setFlag(true)
eq('s12 other list', allowedFolders(view()), ['mine'])
eq('s12 other show', showBrainSwitch(view()), false)
{
  const before = vaultBytes()
  const pre = [vault.shellEmail(), vault.activeSeatId(), vault.activeToken(), vault.activeRole()]
  let threw = false
  try {
    vault.switchShellBrain('agency')
  } catch {
    threw = true
  }
  eq('s12 other keyless throw', threw, true)
  eq('s12 other bytes', vaultBytes(), before)
  eq('s12 other readers', [vault.shellEmail(), vault.activeSeatId(), vault.activeToken(), vault.activeRole()], pre)
}
eq('s12 other foreign', await four('foreign'), EMPTY)

fresh()
vault.signInEmailOnly('joe@plyntr.com')
vault.setFlag(false)
vault.acceptBrainCode('rose', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'rose-owner')
brainsMod.adoptFolder('agency', 'agency-seat')
vault.signInEmailOnly('foreign@example.com')
vault.acceptBrainCode('foreign', 'foreign@example.com', 'foreign@example.com', 'owner', 'foreign-token')
vault.signInEmailOnly('joe@plyntr.com')
vault.setFlag(false)
eq('s12 flag off list', allowedFolders(view()), ['rose'])
eq('s12 flag off show', showBrainSwitch(view()), false)
vault.switchShellBrain('rose')
eq('s12 flag off shell', vault.shellEmail(), 'joe@plyntr.com')
eq('s12 flag off active', [vault.activeToken(), vault.activeRole()], ['rose-owner', 'team'])
eq('s12 flag off foreign', await four('foreign'), EMPTY)
{
  const before = vaultBytes()
  const pre = [vault.activeToken(), vault.activeRole(), ...(await tokenTrio('rose'))]
  let threw = false
  try {
    vault.switchShellBrain('agency')
  } catch {
    threw = true
  }
  eq('s12 agency throw', threw, true)
  eq('s12 agency bytes', vaultBytes(), before)
  eq('s12 agency readers', [vault.activeToken(), vault.activeRole(), ...(await tokenTrio('rose'))], pre)
}

fresh()
vault.signInEmailOnly('joe@plyntr.com')
vault.setFlag(true)
vault.acceptBrainCode('rose', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'rose-owner')
brainsMod.adoptFolder('k1', 'agency-seat')
brainsMod.adoptFolder('k2', 'agency-seat')
vault.signInEmailOnly('foreign@example.com')
vault.acceptBrainCode('foreign', 'foreign@example.com', 'foreign@example.com', 'team', 'foreign-token')
vault.signInEmailOnly('joe@plyntr.com')
vault.setFlag(true)
eq('s12 flag on list', allowedFolders(view()), ['rose', 'k1', 'k2'])
eq('s12 flag on show', showBrainSwitch(view()), true)
eq('s12 flag on foreign read', await four('foreign'), EMPTY)
vault.signInEmailOnly('other@plyntr.com')
vault.setFlag(true)
eq('s12 other foreign read', await four('foreign'), EMPTY)
vault.signInEmailOnly('joe@plyntr.com')
vault.setFlag(true)
{
  const before = vaultBytes()
  let threw = false
  try {
    vault.switchShellBrain('foreign')
  } catch {
    threw = true
  }
  eq('s12 foreign throw', threw, true)
  eq('s12 foreign bytes', vaultBytes(), before)
}
vault.switchShellBrain('rose')
eq('s12 before agency', [vault.activeToken(), vault.activeRole()], ['rose-owner', 'team'])
const rose12 = rowBytes('rose')
const count12 = vault.keyCount()
vault.switchShellBrain('k1')
eq('s12 agency seat', vault.activeSeatId(), 'k1')
eq('s12 agency active', [vault.activeToken(), vault.activeRole()], ['', ''])
eq('s12 agency shell', vault.shellEmail(), 'joe@plyntr.com')
eq('s12 rose token', seats.seatTokenForBrain('rose'), 'rose-owner')
eq('s12 agency four', await four('k1'), EMPTY)
eq('s12 count', vault.keyCount(), count12)
eq('s12 rose row', rowBytes('rose'), rose12)
eq('s12 label', openBrainAccountLabel(vault.activeSeat()), 'agency-seat')
eq('s12 label not brain email', openBrainAccountLabel(vault.activeSeat()) === 'plyntrllc@gmail.com', false)
eq('s12 bearer keyless', await bearer(vault.activeSeatId()), '')
vault.switchShellBrain('rose')
eq('s12 back seat', vault.activeSeatId(), 'rose')
eq('s12 back four', await four('rose'), seat('rose-owner', 'team'))
eq('s12 back active', [vault.activeToken(), vault.activeRole()], ['rose-owner', 'team'])
eq('s12 back row', rowBytes('rose'), rose12)
eq('s12 back label', openBrainAccountLabel(vault.activeSeat()), 'plyntrllc@gmail.com')
eq('s12 bearer rose', await bearer(vault.activeSeatId()), 'rose-owner')
vault.signInEmailOnly('ada@client.com')
vault.acceptBrainCode('ada-b', 'ada@client.com', 'boss@client.com', 'owner', 'ada-b-token')
eq('s12 ada label', openBrainAccountLabel(vault.activeSeat()), 'boss@client.com')

// 13. roleForBrainWrite is the brain role, never the account role.
fresh()
vault.signInEmailOnly('joe@plyntr.com')
sessionToken.saveAccount({ email: 'joe@plyntr.com', token: 'login:joe', role: 'owner', source: 'plyntr' })
vault.acceptBrainCode('rose', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'rose-owner')
eq('s13 joe', guardRole.roleForBrainWrite('rose'), 'team')
vault.signInEmailOnly('ada@client.com')
sessionToken.saveAccount({ email: 'ada@client.com', token: 'login:ada', role: 'team', source: 'plyntr' })
vault.acceptBrainCode('ada', 'ada@client.com', 'ada@client.com', 'owner', 'ada-owner')
eq('s13 ada', guardRole.roleForBrainWrite('ada'), 'owner')
eq('s13 missing', guardRole.roleForBrainWrite('missing'), '')
vault.signInEmailOnly('stranger@example.com')
vault.acceptBrainCode('admin-row', 'stranger@example.com', 'stranger@example.com', 'admin', 'admin-token')
vault.signInEmailOnly('joe@plyntr.com')
eq('s13 foreign admin', guardRole.roleForBrainWrite('admin-row'), '')
vault.loginFromCompanySetup('admin-empty', 'plyntrllc@gmail.com', 'admin', '')
eq('s13 admin stored', JSON.parse(rowBytes('admin-empty') || '{}').role, 'admin')
eq('s13 no key', await four('admin-empty'), EMPTY)
vault.signInEmailOnly('ada@client.com')
eq('s13 no key ada', guardRole.roleForBrainWrite('admin-empty'), '')

// Item 1. The real write guard refuses protected paths when this login has no seat.
fresh()
{
  vault.signInEmailOnly('joe@plyntr.com')
  vault.acceptBrainCode('joe-team', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'joe-team-token')
  vault.acceptBrainCode('joe-owner', 'joe@plyntr.com', 'joe@plyntr.com', 'owner', 'joe-owner-token')
  const teamFolder = brainFolder('joe-team')
  const ownerFolder = brainFolder('joe-owner')
  const keyless = brainFolder('')
  writeFileSync(join(keyless, '.team-config', 'roles.json'), JSON.stringify({
    team_slug: 'agency', team_name: 'Agency',
    members: [{ email: 'joe@plyntr.com', role: 'owner' }, { email: 'ada@client.com', role: 'team' }]
  }))
  const rosterBytes = readFileSync(join(keyless, '.team-config', 'roles.json'), 'utf8')
  vault.signInEmailOnly('ada@client.com')
  vault.acceptBrainCode('ada-own', 'ada@client.com', 'ada@client.com', 'owner', 'ada-own-token')
  const adaFolder = brainFolder('ada-own')
  eq('g1 folder token by path', seats.seatTokenForFolder(adaFolder), 'ada-own-token')
  eq('g1 role by path', guardRole.roleForBrainWrite(adaFolder), 'owner')
  eq('g1 ada own skills', await writeThrough(adaFolder, 'skills/offer.md'), '')
  eq('g1 ada own team-config', await writeThrough(adaFolder, '.team-config/notes.md'), '')
  // Ada on Joe's brain: no seat.
  eq('g1 ada on joe role', guardRole.roleForBrainWrite(ownerFolder), '')
  eq('g1 ada on joe skills', await writeThrough(ownerFolder, 'skills/offer.md'), guard.NO_SEAT_WRITE_REFUSAL)
  eq('g1 ada on joe team-config', await writeThrough(ownerFolder, '.team-config/notes.md'), guard.NO_SEAT_WRITE_REFUSAL)
  eq('g1 ada on joe notes', await writeThrough(ownerFolder, 'notes.md'), '')
  eq('g1 no seat block', guard.brainWriteBlock(guardRole.roleForBrainWrite(ownerFolder), ownerFolder, join(ownerFolder, 'skills', 'offer.md')), guard.NO_SEAT_WRITE_REFUSAL)
  // Account role does not grant a seat.
  sessionToken.saveAccount({ email: 'ada@client.com', token: 'login:ada', role: 'owner', source: 'plyntr' })
  eq('g1 account role ignored', await writeThrough(ownerFolder, 'skills/offer.md'), guard.NO_SEAT_WRITE_REFUSAL)
  // A folder with no brain id (Agency Brain, local) reads the role from its team file. Agency team is refused.
  eq('g1 keyless id', seats.brainIdForFolder(keyless), '')
  eq('g1 ada keyless role', seats.roleForKeylessWrite(keyless), 'team')
  eq('g1 ada keyless skills', await writeThrough(keyless, 'skills/offer.md'), guard.TEAM_WRITE_REFUSAL)
  eq('g1 ada keyless roster', await writeThroughKeep(keyless, '.team-config/roles.json', rosterBytes), guard.TEAM_WRITE_REFUSAL)
  eq('g1 ada keyless notes', await writeThrough(keyless, 'notes.md'), '')
  // A login that is not on the team file has no role there.
  vault.signInEmailOnly('stranger@example.com')
  sessionToken.saveAccount({ email: 'stranger@example.com', token: 'login:stranger', role: 'owner', source: 'plyntr' })
  eq('g1 stranger keyless skills', await writeThrough(keyless, 'skills/offer.md'), guard.NO_SEAT_WRITE_REFUSAL)
  eq('g1 stranger keyless roster', await writeThroughKeep(keyless, '.team-config/roles.json', rosterBytes), guard.NO_SEAT_WRITE_REFUSAL)
  // Joe: team seat is refused, owner seat writes, keyless folder writes as the team file's owner.
  vault.signInEmailOnly('joe@plyntr.com')
  eq('g1 joe team skills', await writeThrough(teamFolder, 'skills/offer.md'), guard.TEAM_WRITE_REFUSAL)
  eq('g1 joe owner skills', await writeThrough(ownerFolder, 'skills/offer.md'), '')
  eq('g1 joe keyless skills', await writeThrough(keyless, 'skills/offer.md'), '')
  eq('g1 joe keyless roster', await writeThroughKeep(keyless, '.team-config/roles.json', rosterBytes), '')
  // After Log out, no one has a seat on a brain with an id.
  eq('g1 logout', await ipc('auth:logout'), { ok: true })
  eq('g1 after logout owner', await writeThrough(ownerFolder, 'skills/offer.md'), guard.NO_SEAT_WRITE_REFUSAL)
  eq('g1 after logout ada', await writeThrough(adaFolder, '.team-config/notes.md'), guard.NO_SEAT_WRITE_REFUSAL)
  eq('g1 after logout keyless', await writeThrough(keyless, 'skills/offer.md'), guard.NO_SEAT_WRITE_REFUSAL)
  eq('g1 after logout keyless roster', await writeThroughKeep(keyless, '.team-config/roles.json', rosterBytes), guard.NO_SEAT_WRITE_REFUSAL)
}

// Item 13. The company setup routes run for real: each keeps the worker's return fields and never returns the token.
// A worker seat token is stored once in the vault for the signed-in shell and reports hasToken true. A reply with
// no seat token stores nothing and reports hasToken false. The platform token is never stored as a brain key.
/** The vault row for a brain, with the token reduced to whether it matches. */
function setupRow(id: string, token: string) {
  const row = vault.brainRow(id)
  if (!row) return null
  return { owner: row.owner, email: row.email, role: row.role, slug: row.slug, repo: row.repo, token: row.token === token }
}
fresh()
{
  writeFileSync(join(vault.vaultDir(), 'hq-owner.json'), JSON.stringify({ email: 'joe@plyntr.com', token: 'platform-secret', kind: 'platform' }))
  sessionToken.saveAccount({ email: 'joe@plyntr.com', appEmail: 'joe@plyntr.com', token: 'login:joe', role: 'owner', source: 'plyntr' })
  vault.signInEmailOnly('joe@plyntr.com')
  companyReplies['POST /v1/brains'] = {
    brainId: 'made', repo: 'org/made-brain', slug: 'made-co', label: 'Made Co', code: '552210', emailed: true, seatToken: 'made-seat'
  }
  companyReplies['POST /v1/companies'] = {
    brainId: 'opened', repo: 'org/opened-brain', slug: 'opened', label: 'Opened', seatToken: 'opened-seat',
    code: '184392', emailed: true, ownerEmail: 'boss@client.com', ownerName: 'Boss', role: 'owner'
  }
  companyReplies['POST /v1/companies/claimed/mac'] = {
    brainId: 'claimed', seatToken: 'claimed-seat', role: 'scout', email: 'scout@plyntr.com', repo: 'org/claimed-brain', slug: 'claimed', label: 'Claimed', code: '771204', bootstrap: true
  }
  const made = await ipc('plyntr:createBrain', { label: 'Made', org: 'org', slug: 'made', scoutEmail: 'Scout@Plyntr.com' })
  eq('c13 createBrain return', made, { brainId: 'made', repo: 'org/made-brain', slug: 'made-co', label: 'Made Co', email: 'Scout@Plyntr.com', code: '552210', emailed: true, role: 'scout', hasToken: true })
  // A worker reply with no slug or label keeps the request's slug and label.
  companyReplies['POST /v1/brains'] = { brainId: 'bare', repo: 'org/bare-brain', code: '330188', emailed: false, seatToken: 'bare-seat' }
  const bare = await ipc('plyntr:createBrain', { label: 'Bare Co', org: 'org', slug: 'bare', scoutEmail: 'scout@plyntr.com' })
  eq('c13 createBrain bare reply', bare, { brainId: 'bare', repo: 'org/bare-brain', slug: 'bare', label: 'Bare Co', email: 'scout@plyntr.com', code: '330188', emailed: false, role: 'scout', hasToken: true })
  const opened = await ipc('plyntr:openCompany', { label: 'Opened', ownerName: 'Boss', ownerEmail: 'boss@client.com' })
  eq('c13 openCompany return', opened, {
    brainId: 'opened', repo: 'org/opened-brain', slug: 'opened', label: 'Opened', code: '184392', emailed: true, ownerEmail: 'boss@client.com', ownerName: 'Boss', role: 'owner', hasToken: true
  })
  const claimed = await ipc('plyntr:claimCompany', 'claimed')
  eq('c13 claimCompany return', claimed, {
    brainId: 'claimed', repo: 'org/claimed-brain', slug: 'claimed', label: 'Claimed', email: 'scout@plyntr.com', role: 'scout', code: '771204', bootstrap: true, hasToken: true
  })
  // A worker reply with no seat token stores nothing and reports hasToken false.
  companyReplies['POST /v1/brains'] = { brainId: 'tokenless', repo: 'org/tokenless-brain', slug: 'tokenless', label: 'Tokenless', code: '440021', emailed: true }
  companyReplies['POST /v1/companies'] = {
    brainId: 'open-bare', repo: 'org/open-bare-brain', slug: 'open-bare', label: 'Open Bare', code: '440022', emailed: true, ownerEmail: 'lee@client.com', ownerName: 'Lee', role: 'owner'
  }
  companyReplies['POST /v1/companies/claim-bare/mac'] = {
    brainId: 'claim-bare', role: 'scout', email: 'scout@plyntr.com', repo: 'org/claim-bare-brain', slug: 'claim-bare', label: 'Claim Bare', code: '440023', bootstrap: true
  }
  const before = vaultBytes()
  const tokenless = await ipc('plyntr:createBrain', { label: 'Tokenless', org: 'org', slug: 'tokenless', scoutEmail: 'scout@plyntr.com' })
  eq('c13 createBrain no token', (tokenless as { hasToken: boolean }).hasToken, false)
  const openBare = await ipc('plyntr:openCompany', { label: 'Open Bare', ownerName: 'Lee', ownerEmail: 'lee@client.com' })
  eq('c13 openCompany no token', (openBare as { hasToken: boolean }).hasToken, false)
  const claimBare = await ipc('plyntr:claimCompany', 'claim-bare')
  eq('c13 claimCompany no token', (claimBare as { hasToken: boolean }).hasToken, false)
  // A claim reply with a seat token but no email or no role stores nothing: the key is never filed under the platform email.
  companyReplies['POST /v1/companies/claim-noemail/mac'] = {
    brainId: 'claim-noemail', seatToken: 'noemail-seat', role: 'scout', repo: 'org/claim-noemail-brain', slug: 'claim-noemail', label: 'No Email', code: '440024', bootstrap: true
  }
  companyReplies['POST /v1/companies/claim-norole/mac'] = {
    brainId: 'claim-norole', seatToken: 'norole-seat', email: 'scout@plyntr.com', repo: 'org/claim-norole-brain', slug: 'claim-norole', label: 'No Role', code: '440025', bootstrap: true
  }
  // A seat token that is not a string stores nothing.
  companyReplies['POST /v1/companies/claim-numtoken/mac'] = {
    brainId: 'claim-numtoken', seatToken: 990026, role: 'scout', email: 'scout@plyntr.com', repo: 'org/claim-numtoken-brain', slug: 'claim-numtoken', label: 'Num Token', code: '440026', bootstrap: true
  }
  const claimNoEmail = await ipc('plyntr:claimCompany', 'claim-noemail')
  eq('c13 claimCompany no email', claimNoEmail, {
    brainId: 'claim-noemail', repo: 'org/claim-noemail-brain', slug: 'claim-noemail', label: 'No Email', email: '', role: 'scout', code: '440024', bootstrap: true, hasToken: false
  })
  const claimNoRole = await ipc('plyntr:claimCompany', 'claim-norole')
  eq('c13 claimCompany no role', (claimNoRole as { hasToken: boolean }).hasToken, false)
  const claimNumToken = await ipc('plyntr:claimCompany', 'claim-numtoken')
  eq('c13 claimCompany non-string token', (claimNumToken as { hasToken: boolean }).hasToken, false)
  eq('c13 no token no rows', ['tokenless', 'open-bare', 'claim-bare', 'claim-noemail', 'claim-norole', 'claim-numtoken'].map((id) => rowBytes(id)), ['', '', '', '', '', ''])
  eq('c13 no token no brain rows', ['claim-noemail', 'claim-norole', 'claim-numtoken'].map((id) => vault.brainRow(id)), [null, null, null])
  if (vaultBytes() !== before) miss('c13 a reply with no seat token changed the vault')
  const tokens: Record<string, string> = { made: 'made-seat', bare: 'bare-seat', opened: 'opened-seat', claimed: 'claimed-seat', 'claim-noemail': 'noemail-seat', 'claim-norole': 'norole-seat' }
  for (const [label, got] of [['createBrain', made], ['createBrain bare', bare], ['openCompany', opened], ['claimCompany', claimed], ['createBrain no token', tokenless], ['openCompany no token', openBare], ['claimCompany no token', claimBare], ['claimCompany no email', claimNoEmail], ['claimCompany no role', claimNoRole], ['claimCompany non-string token', claimNumToken]] as const) {
    const text = JSON.stringify(got)
    if (/seat|secret|990026/.test(text) || Object.values(tokens).some((t) => text.includes(t))) miss(`c13 ${label} returns a token`)
  }
  eq('c13 platform bearer', platformBearers, Array(10).fill('platform-secret'))
  eq('c13 rows', ['made', 'bare', 'opened', 'claimed'].map((id) => setupRow(id, tokens[id])), [
    { owner: 'joe@plyntr.com', email: 'scout@plyntr.com', role: 'scout', slug: 'made-co', repo: 'org/made-brain', token: true },
    { owner: 'joe@plyntr.com', email: 'scout@plyntr.com', role: 'scout', slug: '', repo: 'org/bare-brain', token: true },
    { owner: 'joe@plyntr.com', email: 'boss@client.com', role: 'owner', slug: 'opened', repo: 'org/opened-brain', token: true },
    { owner: 'joe@plyntr.com', email: 'scout@plyntr.com', role: 'scout', slug: 'claimed', repo: 'org/claimed-brain', token: true }
  ])
  const keys: unknown[] = []
  for (const id of ['made', 'opened', 'claimed']) {
    const k = await four(id)
    keys.push([k.folder === tokens[id], k.brain === tokens[id], k.git === tokens[id], k.role])
  }
  eq('c13 keys', keys, [[true, true, true, 'scout'], [true, true, true, 'owner'], [true, true, true, 'scout']])
  eq('c13 shell kept', vault.shellEmail(), 'joe@plyntr.com')
  if (vaultBytes().includes('platform-secret')) miss('c13 platform token stored as a brain key')
  for (const k of Object.keys(companyReplies)) delete companyReplies[k]
}

// Item 13b. With no shell signed in, setup signs in the platform email first and stores the seat there.
// With another shell signed in, setup stores the seat for that shell and does not change it.
for (const shell of ['', 'ada@client.com']) {
  fresh()
  platformBearers.length = 0
  writeFileSync(join(vault.vaultDir(), 'hq-owner.json'), JSON.stringify({ email: 'joe@plyntr.com', token: 'platform-secret', kind: 'platform' }))
  sessionToken.saveAccount({ email: 'joe@plyntr.com', appEmail: 'joe@plyntr.com', token: 'login:joe', role: 'owner', source: 'plyntr' })
  if (shell) vault.signInEmailOnly(shell)
  const owner = shell || 'joe@plyntr.com'
  const tag = shell ? 'c13b other shell' : 'c13b empty shell'
  if (!shell) {
    // With no shell signed in, a reply with no seat token or a non-string one signs nothing in and stores nothing.
    const emptyBytes = vaultBytes()
    companyReplies['POST /v1/brains'] = { brainId: 'none', repo: 'org/none-brain', slug: 'none', label: 'None', code: '660002', emailed: true }
    companyReplies['POST /v1/companies/odd/mac'] = {
      brainId: 'odd', seatToken: { value: 'odd' }, role: 'scout', email: 'scout@plyntr.com', repo: 'org/odd-brain', slug: 'odd', label: 'Odd', code: '660003', bootstrap: true
    }
    const none = await ipc('plyntr:createBrain', { label: 'None', org: 'org', slug: 'none', scoutEmail: 'scout@plyntr.com' })
    eq(`${tag} no token hasToken`, (none as { hasToken: boolean }).hasToken, false)
    const odd = await ipc('plyntr:claimCompany', 'odd')
    eq(`${tag} object token hasToken`, (odd as { hasToken: boolean }).hasToken, false)
    eq(`${tag} no token shell`, vault.shellEmail(), '')
    eq(`${tag} no token rows`, [vault.brainRow('none'), vault.brainRow('odd'), rowBytes('none'), rowBytes('odd')], [null, null, '', ''])
    eq(`${tag} no token bytes`, vaultBytes(), emptyBytes)
    for (const k of Object.keys(companyReplies)) delete companyReplies[k]
  }
  companyReplies['POST /v1/brains'] = { brainId: 'late', repo: 'org/late-brain', slug: 'late', label: 'Late', code: '660001', emailed: true, seatToken: 'late-seat' }
  const late = await ipc('plyntr:createBrain', { label: 'Late', org: 'org', slug: 'late', scoutEmail: 'scout@plyntr.com' })
  eq(`${tag} hasToken`, (late as { hasToken: boolean }).hasToken, true)
  if (JSON.stringify(late).includes('late-seat')) miss(`${tag} returns a token`)
  eq(`${tag} shell`, vault.shellEmail(), owner)
  eq(`${tag} row`, setupRow('late', 'late-seat'), { owner, email: 'scout@plyntr.com', role: 'scout', slug: 'late', repo: 'org/late-brain', token: true })
  for (const k of Object.keys(companyReplies)) delete companyReplies[k]
}

// Item 8. brains:switch takes a brain id with no folder path and opens its folder.
fresh()
{
  vault.acceptBrainCode('b-one', 'ada@client.com', 'ada@client.com', 'owner', 'b-one-token')
  vault.acceptBrainCode('b-two', 'ada@client.com', 'boss@client.com', 'team', 'b-two-token')
  const one = brainFolder('b-one')
  brainFolder('b-two')
  const opened = (await ipc('brains:switch', 'b-one')) as { path: string }
  eq('s8b opened path', opened.path, one)
  eq('s8b active', [vault.activeSeatId(), vault.activeToken(), vault.activeRole()], ['b-one', 'b-one-token', 'owner'])
  const before = vaultBytes()
  const err = await ipcThrows('brains:switch', 'not-on-disk')
  eq('s8b missing refused', Boolean(err), true)
  eq('s8b missing bytes', vaultBytes(), before)
}

// 14. Log out through the real handler. F: the sync timer stops and both rows stay.
fresh()
{
  await verifyCode('joe@plyntr.com', { brainId: 'rose', email: 'plyntrllc@gmail.com', role: 'team', seatToken: 'rose-owner' })
  await verifyCode('joe@plyntr.com', { brainId: 'other', email: 'ada@client.com', role: 'owner', seatToken: 'other-owner' })
  eq('s14 shell', vault.shellEmail(), 'joe@plyntr.com')
  const syncFolder = mkdtempSync(join(tmpdir(), 'sync-'))
  liveTimers.clear()
  brainSync.startBrainSync(syncFolder)
  eq('s14 sync running', liveTimers.size, 1)
  const rose = rowBytes('rose')
  const other = rowBytes('other')
  eq('s14 logout', await ipc('auth:logout'), { ok: true })
  eq('s14 sync stopped', liveTimers.size, 0)
  eq('s14 email', vault.shellEmail(), '')
  eq('s14 rows', [rowBytes('rose'), rowBytes('other')], [rose, other])
  eq('s14 empty now', (await readersEmpty('rose')) && (await readersEmpty('other')), true)
  eq('s14 session', ((await ipc('auth:session')) as { signedIn: boolean }).signedIn, false)
  vault.discardMemory()
  eq('s14 resume empty', vault.resumeShellAccount(), '')
  eq('s14 still empty', (await readersEmpty('rose')) && (await readersEmpty('other')), true)
  vault.signInEmailOnly('joe@plyntr.com')
  eq('s14 restored rose', await four('rose'), seat('rose-owner', 'team'))
  eq('s14 restored other', await four('other'), seat('other-owner', 'owner'))
  vault.discardMemory()
  eq('s14 resume joe', vault.resumeShellAccount(), 'joe@plyntr.com')
  eq('s14 resume rose', await four('rose'), seat('rose-owner', 'team'))
  eq('s14 resume other', await four('other'), seat('other-owner', 'owner'))
  // B: Ada signs in on the same file.
  vault.signInEmailOnly('ada@client.com')
  eq('B ada rose', await four('rose'), EMPTY)
  eq('B ada other', await four('other'), EMPTY)
  eq('B rows', [rowBytes('rose'), rowBytes('other')], [rose, other])
  vault.discardMemory()
  eq('B resume ada', vault.resumeShellAccount(), 'ada@client.com')
  vault.signInEmailOnly('joe@plyntr.com')
  eq('B joe rose', await four('rose'), seat('rose-owner', 'team'))
  eq('B joe other', await four('other'), seat('other-owner', 'owner'))
  // C: fresh load, Ada's email-only sign-in leaves both rows byte-for-byte.
  freshLoad('C', vault.vaultDir(), { SHELL_CHECK_WANT: JSON.stringify({ rose, other }) })
  eq('C parent rows', [rowBytes('rose'), rowBytes('other')], [rose, other])
}

// 15. Legacy plyntr-seats.json.
fresh()
const legacy = JSON.stringify({ id: 'legacy-id', email: 'legacy@example.com', role: 'scout', token: 'legacy-sentinel', second: { id: 'second-legacy', email: 'x@y.z', role: 'team', token: 'second-token' } })
writeFileSync(legacyPath(), legacy)
const bytes = () => readFileSync(legacyPath(), 'utf8')
eq('s15 start bytes', bytes(), legacy)
eq('s15 readers before', await readersEmpty('legacy-id'), true)
eq('s15 resume', vault.resumeShellAccount(), '')
eq('s15 active', vault.activeToken(), '')
{
  let sw = false
  try {
    vault.switchShellBrain('legacy-id')
  } catch {
    sw = true
  }
  eq('s15 switch', sw, true)
}
eq('s15 logout', await ipc('auth:logout'), { ok: true })
eq('s15 after idle', bytes(), legacy)
eq('s15 vault empty', [vault.keyCount(), vault.shellEmail(), rowBytes('legacy-id')], [0, '', ''])
eq('s15 readers', await readersEmpty('legacy-id'), true)

fresh()
writeFileSync(legacyPath(), legacy)
vault.signInEmailOnly('ada@client.com')
eq('s15 ada vault', [vault.keyCount(), rowBytes('legacy-id')], [0, ''])
eq('s15 ada readers', await tokenTrio('legacy-id'), ['', '', ''])
eq('s15 ada bytes', bytes(), legacy)
eq('s15 ada shell', vault.shellEmail(), 'ada@client.com')
vault.signInEmailOnly('joe@plyntr.com')
eq('s15 joe shell', vault.shellEmail(), 'joe@plyntr.com')
eq('s15 stored', JSON.parse(rowBytes('legacy-id') || '{}'), { id: 'legacy-id', email: 'legacy@example.com', role: 'scout', token: 'legacy-sentinel', owner: 'joe@plyntr.com', slug: '', repo: '' })
eq('s15 bytes', bytes(), legacy)
eq('s15 joe token', seats.seatTokenForBrain('legacy-id'), 'legacy-sentinel')
vault.signInEmailOnly('ada@client.com')
eq('s15 ada after', seats.seatTokenForBrain('legacy-id'), '')
eq('s15 no second', rowBytes('second-legacy'), '')

fresh()
vault.signInEmailOnly('joe@plyntr.com')
vault.acceptBrainCode('rose', 'joe@plyntr.com', 'plyntrllc@gmail.com', 'team', 'rose-newer')
writeFileSync(legacyPath(), legacy)
const beforeNewer = vaultBytes()
vault.signInEmailOnly('joe@plyntr.com')
eq('s15 newer vault', vaultBytes(), beforeNewer)
eq('s15 newer no second', rowBytes('second-legacy'), '')
eq('s15 newer bytes', bytes(), legacy)
eq('s15 newer token', await tokenTrio('rose'), ['rose-newer', 'rose-newer', 'rose-newer'])

fresh()
const byBrain = JSON.stringify({
  byBrain: { 'rose-legacy': { email: 'plyntrllc@gmail.com', role: 'owner', seatToken: 'bybrain-token', slug: 'rose', repo: 'org/rose-brain' } },
  slugToBrain: { rose: 'rose-legacy' }
})
writeFileSync(legacyPath(), byBrain)
vault.signInEmailOnly('joe@plyntr.com')
eq('s15 bybrain row', JSON.parse(rowBytes('rose-legacy') || '{}'), { id: 'rose-legacy', email: 'plyntrllc@gmail.com', role: 'owner', token: 'bybrain-token', owner: 'joe@plyntr.com', slug: 'rose', repo: 'org/rose-brain' })
eq('s15 bybrain token', seats.seatTokenForBrain('rose-legacy'), 'bybrain-token')
eq('s15 bybrain id', seats.brainIdForSlug('rose'), 'rose-legacy')
eq('s15 bybrain bytes', readFileSync(legacyPath(), 'utf8'), byBrain)
vault.signInEmailOnly('ada@client.com')
eq('s15 bybrain ada', seats.seatTokenForBrain('rose-legacy'), '')

// H. Log out, then a Plyntr code for a new id whose email differs from the typed email,
// through auth:verify. An old account.json must not become the shell.
fresh()
{
  await verifyCode('joe@plyntr.com', { brainId: 'rose', email: 'plyntrllc@gmail.com', role: 'team', seatToken: 'rose-owner' })
  await verifyCode('joe@plyntr.com', { brainId: 'other', email: 'ada@client.com', role: 'owner', seatToken: 'other-owner' })
  const roseFolder = brainFolder('rose')
  eq('sH switch back to rose', ((await ipc('brains:switch', roseFolder)) as { path: string }).path, roseFolder)
  eq('sH active seat is rose', vault.activeSeatId(), 'rose')
  const rose = rowBytes('rose')
  const other = rowBytes('other')
  // Second fresh-load run while Joe is still signed in: log out, then a new code.
  const copy = mkdtempSync(join(tmpdir(), 'shell-copy-'))
  writeFileSync(join(copy, 'vault.json'), vaultBytes())
  freshLoad('H', copy, { SHELL_CHECK_WANT: JSON.stringify({ rose, other }) })
  eq('sH logout', await ipc('auth:logout'), { ok: true })
  sessionToken.saveAccount({ email: 'old@example.com', token: 'login:old', role: 'owner', source: 'plyntr' })
  await ipc('shell:view')
  eq('sH view keeps empty', vault.shellEmail(), '')
  await verifyCode('ada@client.com', { brainId: 'new-id', email: 'plyntrllc@gmail.com', role: 'team', seatToken: 'new-token' })
  eq('sH shell', vault.shellEmail(), 'ada@client.com')
  eq('sH stored', await four('new-id'), seat('new-token', 'team'))
  eq('sH row', JSON.parse(rowBytes('new-id') || '{}'), { id: 'new-id', email: 'plyntrllc@gmail.com', role: 'team', token: 'new-token', owner: 'ada@client.com', slug: 'new-id', repo: 'org/new-id-brain' })
  eq('sH joe rose', await four('rose'), EMPTY)
  eq('sH joe other', await four('other'), EMPTY)
  eq('sH intact', [rowBytes('rose'), rowBytes('other')], [rose, other])
  eq('sH session', ((await ipc('auth:session')) as { signedIn: boolean }).signedIn, true)
  vault.discardMemory()
  eq('sH resume', vault.resumeShellAccount(), 'ada@client.com')
  eq('sH resume four', await four('new-id'), seat('new-token', 'team'))
  eq('sH resume joe', await four('rose'), EMPTY)
  // Fresh load after that logout: startup signs no one in, and a code sets the typed email.
  eq('sH logout again', await ipc('auth:logout'), { ok: true })
  freshLoad('H3', vault.vaultDir(), { SHELL_CHECK_WANT: JSON.stringify({ rose, other }) })
}

// ---------------------------------------------------------------------------
// Source checks.
// ---------------------------------------------------------------------------

function read(rel: string): string {
  return readFileSync(join(rootRepo, rel), 'utf8')
}

/** Text between the first `{` after `start` and its matching `}`. */
function bodyAfter(src: string, start: string): string {
  const i = src.indexOf(start)
  if (i < 0) return ''
  const open = src.indexOf('{', i + start.length)
  if (open < 0) return ''
  let depth = 0
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, k)
    }
  }
  return ''
}

/** Body of an IPC handler: the block after its arrow, so braces in parameter types are skipped. */
function handlerBody(src: string, name: string): string {
  const i = src.indexOf(`ipcMain.handle('${name}'`)
  if (i < 0) return ''
  return bodyAfter(src.slice(src.indexOf('=> {', i)), '=>')
}

/** Statements of a body with whitespace collapsed, so a body can be matched exactly. */
function flat(body: string): string {
  return body.replace(/\s+/g, ' ').trim()
}

function exactBody(label: string, src: string, start: string, want: string): void {
  const got = flat(bodyAfter(src, start))
  if (got !== want) miss(`${label} body is ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}

const ipcSrc = read('src/main/ipc-stubs.ts')
const seatsSrc = read('src/main/plyntr-seats.ts')
const guardRoleSrc = read('src/main/write-guard-role.ts')
const guardSrc = read('src/main/write-guard.ts')
const acpSrc = read('src/main/acp-session.ts')
const syncSrc = read('src/main/plyntr-sync.ts')
const brainsSrc = read('src/main/brains.ts')
const vaultSrc = read('src/main/shell-vault.ts')
const preloadSrc = read('src/preload/index.ts')
const settingsSrc = read('src/renderer/src/SettingsPanel.tsx')
const pathSrc = read('src/renderer/src/PlyntrPath.tsx')
const firstSrc = read('src/renderer/src/FirstRun.tsx')

// Readers are exactly one return.
exactBody('seatTokenForFolder', seatsSrc, 'export function seatTokenForFolder(folder: string): string', 'return seatTokenForFolderFromVault(folder)')
exactBody('seatTokenForBrain', seatsSrc, 'export function seatTokenForBrain(brainId: string): string', 'return seatTokenForBrainFromVault(brainId)')
exactBody('git bearer', syncSrc, 'function gitBearer(activeSeatId: string): string', 'return gitSyncTokenFromVault(activeSeatId)')
exactBody('roleForBrainWrite', guardRoleSrc, 'export function roleForBrainWrite(brainId: string): string', 'return roleForBrainWriteFromVault(brainId)')
if ((guardRoleSrc.match(/function /g) || []).length !== 1 || /\|\||acct|getAccount|readTeamMember|row\.role/.test(guardRoleSrc)) miss('write-guard-role has more than the one return')
if (!/path === '\/v1\/git\/token' \? gitBearer\(/.test(syncSrc)) miss('git token call does not use gitBearer')

// Every Brain.app write guard goes through write-guard-role.
for (const [rel, src] of [['ipc-stubs', ipcSrc], ['acp-session', acpSrc]] as const) {
  if (!src.includes("import { roleForBrainWrite } from './write-guard-role'")) miss(`${rel} does not import the guard role`)
  const calls = src.match(/brainWriteBlock\(/g) || []
  if (!calls.length) miss(`${rel} has no write guard`)
  // Every guard runs. A folder with a brain id uses its vault seat; a folder with none uses its team file role.
  const gated = [...src.matchAll(/brainWriteBlock\(brainIdForFolder\(([^()]+)\) \? roleForBrainWrite\(([^()]+)\) : roleForKeylessWrite\(([^()]+)\), ([^(),]+),/g)]
  if (gated.length !== calls.length) miss(`${rel} has a guard that does not pick the seat or the keyless role`)
  for (const g of gated) if (new Set([g[1], g[2], g[3], g[4]]).size !== 1) miss(`${rel} guard reads one folder and checks another: ${g[0]}`)
  if (/\? brainWriteBlock\(|brainWriteBlock\([^)]*\) : null/.test(src)) miss(`${rel} skips the guard on some folders`)
}
if (!/export function roleForKeylessWrite\(folder: string\): string \{\s+const email = shellEmail\(\)\s+return email \? readTeamMember\(folder, email\)\?\.role \|\| '' : ''\s+\}/.test(seatsSrc)) miss('keyless role is not the shell row in the team file')
if (/folderWriteRole/.test(ipcSrc + acpSrc + guardSrc)) miss('folderWriteRole still exists')
if (/shell-vault|session-token|agency-brain/.test(guardSrc)) miss('write-guard reads a role on its own')

// No test hooks in the vault.
if (/plantPoison|poison|setShellToken|shellToken|setSyncRunning|syncRunning|setShellRole|shellRole/.test(vaultSrc)) miss('vault keeps test hooks')
if (/flag: true/.test(bodyAfter(vaultSrc, 'const empty = (): Disk =>'))) miss('empty vault defaults flag on')

// One store per route. The code's five values are separate arguments.
const five = /acceptBrainCode\(([^(),]+), ([^(),]+), ([^(),]+), ([^(),]+), ([^(),]+)(, [^(),]+)*\)/g
function storeCalls(label: string, body: string, want: number, typed: string): void {
  const all = body.match(/acceptBrainCode\(/g) || []
  const ok = [...body.matchAll(five)]
  if (all.length !== want || ok.length !== want) miss(`${label} has ${all.length} stores want ${want}`)
  for (const m of ok) if (m[2].trim() !== typed) miss(`${label} typed email argument is ${m[2]}`)
  if (/savePlyntrSeat|storeOwnedSeat|ensureShell|signInEmailOnly|loginFromCompanySetup/.test(body)) miss(`${label} has a second store or signs a shell in`)
}
const verifyBody = handlerBody(ipcSrc, 'auth:verify')
const plyntrBranch = bodyAfter(verifyBody, "if (authCodeRoute(code) === 'plyntr')")
const projectBranch = bodyAfter(plyntrBranch, "if (resolved.role === 'project')")
storeCalls('agency verify', bodyAfter(verifyBody, 'async function asAgency()'), 1, 'key')
storeCalls('project verify', bodyAfter(verifyBody, 'async function asProject()'), 1, 'key')
storeCalls('plyntr project verify', projectBranch, 1, 'key')
storeCalls('plyntr verify', plyntrBranch.replace(projectBranch, ''), 1, 'key')
storeCalls('plyntr:resolve', handlerBody(ipcSrc, 'plyntr:resolve'), 1, 'typedEmail')
if (/async function as(Agency|Project)\(brainId/.test(ipcSrc)) miss('wrapper functions around acceptBrainCode remain')
if ((ipcSrc.match(/(?<!function )ensureShell\(\)/g) || []).length !== 1) miss('ensureShell runs outside startup')
if (/plyntr:lookup/.test(ipcSrc + preloadSrc)) miss('plyntr:lookup remains')
if (!/resolve: \(code: string, typedEmail\?: string\) =>\s+ipcRenderer\.invoke\('plyntr:resolve', code, typedEmail \|\| ''\) as Promise/.test(preloadSrc)) miss('preload resolve is not one invoke')
if (/seatToken/.test(bodyAfter(preloadSrc, 'resolve: (code: string, typedEmail?: string) =>'))) miss('preload resolve carries a token')
if (/seatToken:/.test(bodyAfter(handlerBody(ipcSrc, 'plyntr:resolve'), 'return {'))) miss('plyntr:resolve returns a token')

// Account shapes on the code routes.
for (const [label, body] of [['project verify', bodyAfter(verifyBody, 'async function asProject()')], ['plyntr project verify', projectBranch]] as const) {
  const acct = bodyAfter(body, 'saveAccount(')
  if (!/role: 'project'/.test(acct) || !/source: 'hq-sync'/.test(acct)) miss(`${label} does not save a project account`)
}
if (!/saveAccount\(/.test(plyntrBranch.replace(projectBranch, ''))) miss('plyntr verify saves no account')
if (!/saveAccount\(/.test(handlerBody(ipcSrc, 'plyntr:resolve'))) miss('plyntr:resolve saves no account')

exactBody('resume', ipcSrc, "ipcMain.handle('plyntr:resumeAccount', () =>", 'return resumeShellAccount()')

// Company setup: each handler stores the worker seat token once through storeSetupSeat, which saves it with
// savePlyntrSeat for the signed-in shell. The returned object never carries the token or the whole worker reply.
if (/function loginFromCompanySetup/.test(ipcSrc + firstSrc + pathSrc + settingsSrc)) miss('a local loginFromCompanySetup stands in for the vault')
{
  const helper = bodyAfter(ipcSrc.slice(ipcSrc.indexOf('function storeSetupSeat(')), '): boolean')
  if ((helper.match(/savePlyntrSeat\(/g) || []).length !== 1) miss('storeSetupSeat does not save through savePlyntrSeat once')
  if (!/if \(!shellEmail\(\)\) signInEmailOnly\(/.test(helper)) miss('storeSetupSeat signs in over a signed-in shell')
  const guardAt = helper.search(/typeof token !== 'string' \|\| !token\.trim\(\)[^\n]*return false/)
  if (guardAt < 0 || guardAt > helper.indexOf('signInEmailOnly(')) miss('storeSetupSeat signs in before it checks the token')
  if (/loginFromCompanySetup|acceptBrainCode|storeOwnedSeat|ensureShell/.test(helper)) miss('storeSetupSeat has a second store')
}
for (const name of ['plyntr:openCompany', 'plyntr:claimCompany', 'plyntr:createBrain']) {
  const body = handlerBody(ipcSrc, name)
  if ((body.match(/storeSetupSeat\(/g) || []).length !== 1) miss(`${name} does not store its seat once`)
  if (/loginFromCompanySetup|acceptBrainCode|storeOwnedSeat|signInEmailOnly/.test(body)) miss(`${name} has a second store or signs a shell in`)
  if (/\.\.\.(created|claimed)\b|return (created|claimed)\b/.test(body)) miss(`${name} passes the whole worker reply through`)
  const ret = bodyAfter(body, 'return')
  if (/seatToken|scoutToken|token:/.test(ret)) miss(`${name} returns the worker seat token`)
  if (!/hasToken\b/.test(ret) || /hasToken: (true|false)/.test(ret)) miss(`${name} does not return hasToken from the store`)
}
if (/claimed\.email \|\|/.test(handlerBody(ipcSrc, 'plyntr:claimCompany'))) miss('plyntr:claimCompany falls back to another email')
const finish = bodyAfter(firstSrc, 'async function finishPlyntrJoin(')
if (/loginFromCompanySetup/.test(finish)) miss('finishPlyntrJoin calls a stand-in')
if (/acct\.email/.test(finish) && /scout/.test(finish)) miss('finishPlyntrJoin uses the shell email as scout')
const setupHere = bodyAfter(firstSrc, 'onBeginCompanySetup={(row) =>')
if (/acct\.email/.test(setupHere) || /role:\s*'scout'/.test(setupHere)) miss('setup-here joins as scout with the shell email')

// Switch, log out.
exactBody('brains:switch', ipcSrc, "ipcMain.handle('brains:switch', (_e, selectedFolderId: string) =>", 'return switchShellBrain(selectedFolderId)')
if (/assertJoe|superAdmin|isJoe|email\s*===/.test(handlerBody(ipcSrc, 'brains:switch'))) miss('switch still gates on identity')
exactBody('auth:logout', ipcSrc, "ipcMain.handle('auth:logout', () =>", 'logoutShell() stopBrainSync() return { ok: true }')
exactBody('logoutShell', ipcSrc, 'function logoutShell(): void', 'logoutVault() clearAccount()')

// Settings list and gates.
if (/allowedFolders\(shell\)\s*\.filter/.test(settingsSrc) || /canOpenBrain|\.filter\(\s*\(?\s*b\b[^)]*allowed/.test(settingsSrc)) miss('rendered brain list is filtered')
if (!/\{allowedFolders\(shell\)\.map\(/.test(settingsSrc)) miss('switch list is not allowedFolders(shell)')
if (/brainsBefore = .*\.filter|brainsAfter = .*\.filter/.test(settingsSrc)) miss('other brains are filtered')
if ((settingsSrc.match(/\{showBrainSwitch\(shell\) \? \(/g) || []).length !== 2) miss('Switch and Open are not exactly showBrainSwitch(shell)')
if (/showBrainSwitch\([^)]*\)\s*(&&|\|\|)|(&&|\|\|)\s*showBrainSwitch\(/.test(settingsSrc)) miss('showBrainSwitch combined with another gate')
{
  const at = settingsSrc.indexOf('title="Add a new company brain"')
  const gate = at < 0 ? '' : settingsSrc.slice(settingsSrc.lastIndexOf('{isJoeSuperAdmin(shell) ? (', at), at)
  if (!gate.startsWith('{isJoeSuperAdmin(shell) ? (') || /&&|\|\||joe\b/.test(gate)) miss('add company gate is not isJoeSuperAdmin(shell)')
  if (!/\) : null\}/.test(settingsSrc.slice(at, settingsSrc.indexOf('</section>', at) + 40))) miss('add company false side renders something')
}
if (settingsSrc.includes('Recover scout token') || pathSrc.includes('Recover scout token') || firstSrc.includes('Recover scout token')) miss('recover scout remains')

// Title bar.
const title = firstSrc.slice(firstSrc.indexOf('className="titlebar"'), firstSrc.indexOf('className="body"'))
if (!title.includes('{openBrainAccountLabel(activeSeat)}')) miss('title label')
if (title.includes('{s.email')) miss('title shows shell email')
if (/brainSeat/.test(firstSrc)) miss('brainSeat is still fetched')

// Legacy file and adoptFolder.
for (const rel of ['src/main/ipc-stubs.ts', 'src/main/plyntr-seats.ts', 'src/main/plyntr-sync.ts', 'src/main/brains.ts', 'src/main/write-guard-role.ts', 'src/main/shell-vault.ts']) {
  const text = read(rel)
  if (rel !== 'src/main/shell-vault.ts' && text.includes('plyntr-seats.json')) miss(`${rel} reads legacy seats`)
  if (/unlinkSync\(/.test(text) && text.includes('plyntr-seats.json')) miss(`${rel} unlinks legacy`)
}
const signInBody = bodyAfter(vaultSrc, 'export function signInEmailOnly(email: string): string')
if (!signInBody.includes('plyntr-seats.json')) miss('sign-in does not read legacy')
if (vaultSrc.replace(signInBody, '').includes('plyntr-seats.json')) miss('legacy filename outside sign-in')
if (!bodyAfter(brainsSrc, 'export function adoptFolder(').includes('rememberKeylessFolder(')) miss('adoptFolder does not call rememberKeylessFolder')

out.ok = misses.length === 0
out.misses = misses
writeFileSync('/tmp/shell-switch-check.json', JSON.stringify(out, null, 2))
brainSync.stopBrainSync()
if (misses.length) {
  console.error(misses.join('\n'))
  process.exit(1)
}
console.log('ok')
process.exit(0)
