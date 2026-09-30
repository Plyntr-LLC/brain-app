import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Add a second brain. Drives the real brains:joinSeat handler. The open brain's
// folder, vault seat, account, Agency Brain path, and git sync cwd stay put.
// Prints JOIN_PASS only when every probe and case holds.

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const require = createRequire(self)
const realOs = require('node:os') as { tmpdir: () => string; homedir: () => string }
const esbuild = require('esbuild') as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code: string }
}

const sysTmp = realpathSync(realOs.tmpdir())
const joinHome = mkdtempSync(join(sysTmp, 'join-home-'))
const scratch = mkdtempSync(join(sysTmp, 'join-git-'))
const userData = join(joinHome, 'userData')
const bare = join(scratch, 'bare.git')
const gitFile = join(scratch, 'gitconfig')
mkdirSync(userData, { recursive: true })

type Counts = Record<string, number>
type Handler = (...args: unknown[]) => Promise<unknown>
type JoinGlobals = {
  __userData: string
  __joinHome: string
  __joinApp: string
  __joinRealOs: typeof realOs
  __fipc?: Map<string, Handler>
  __joinCounts?: Counts
  __joinIpc?: Counts
  __joinFolders?: string[]
  __joinWatch?: string[]
  __joinMini?: string[]
  __joinExposed?: { putFolderPlyntr?: (opts: Record<string, string>) => Promise<unknown> }
  __joinForceUninstalled?: boolean
  __joinForceMini?: string
  __joinBump?: (name: string) => void
  __joinWrapMiss?: string[]
}
const g = globalThis as unknown as JoinGlobals
g.__userData = userData
g.__joinHome = joinHome
g.__joinApp = rootRepo
g.__joinRealOs = realOs
g.__joinCounts = {}
g.__joinIpc = {}
g.__joinFolders = []
g.__joinWatch = []
g.__joinMini = []
g.__joinWrapMiss = []
g.__joinBump = (name: string) => {
  const bag = g.__joinCounts || (g.__joinCounts = {})
  bag[name] = (bag[name] || 0) + 1
}

const OPEN_ORIGIN = 'https://github.com/example/open-brain.git'
const FIXTURE_ORIGIN = 'https://github.com/plyntr-fixture/plyntr-fixture-brain.git'
const FIXTURE_REPO = 'plyntr-fixture/plyntr-fixture-brain'
const CLONE_URL = `https://x-access-token:pbt_dry_git@github.com/${FIXTURE_REPO}.git`
const REFUSE = 'That folder is already a different git repo. Pick another place or remove it, then try again.'
const NOT_ON_GITHUB = 'The app is not installed on GitHub yet. Click Install in the browser, then try again.'
const MARKER = 'JOIN-MARKER-local-bare'

function fail(name: string, detail = ''): never {
  if (detail) console.error(detail)
  console.log(`JOIN_FAIL ${name}`)
  process.exit(1)
}

const osKeys = Object.keys(realOs).filter((key) => key !== 'homedir' && /^[A-Za-z_$][\w$]*$/.test(key))
const osSource = `
const real = globalThis.__joinRealOs
export function homedir() { return globalThis.__joinHome }
${osKeys.map((key) => `export const ${key} = real[${JSON.stringify(key)}]`).join('\n')}
export default { ...real, homedir }
`

const electronSource = `
export const app = {
  getVersion: () => '0.0.0',
  getName: () => 'Brain',
  isPackaged: false,
  getAppPath: () => globalThis.__joinApp,
  getPath: (name) => (name === 'userData' ? globalThis.__userData : globalThis.__joinHome),
  quit() {},
  on() {},
  focus() {},
  whenReady: () => Promise.resolve(),
  dock: { show() {} }
}
export class BrowserWindow {
  static getAllWindows() { return [] }
  static fromWebContents() { return null }
}
export const clipboard = { readText: () => '', writeText() {} }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export const ipcMain = {
  handle(name, fn) {
    const wrapped = async (...args) => {
      const watch = ['auth:verify', 'auth:logout', 'plyntr:resolve', 'setup:openAppInstall']
      if (watch.includes(name)) {
        const bag = globalThis.__joinIpc || (globalThis.__joinIpc = {})
        bag[name] = (bag[name] || 0) + 1
      }
      return await fn(...args)
    }
    ;(globalThis.__fipc || (globalThis.__fipc = new Map())).set(name, wrapped)
  },
  on() {},
  once() {},
  removeHandler() {},
  removeAllListeners() {}
}
export const Menu = { buildFromTemplate: () => ({}) }
export const nativeImage = { createFromPath: () => ({}) }
export const protocol = { handle() {}, registerSchemesAsPrivileged() {} }
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' }
export const shell = { openExternal: async () => {} }
export class Tray {}
export default { app, BrowserWindow, ipcMain, shell }
`

const updaterSource = `
const autoUpdater = {
  on() {},
  checkForUpdates: async () => null,
  downloadUpdate: async () => {},
  quitAndInstall() {},
  setFeedURL() {},
  autoDownload: false,
  autoInstallOnAppQuit: false
}
export { autoUpdater }
export default { autoUpdater }
`

const ptySource = `export default function pty() { return {} }`

const setupSource = `
export async function exchangeAndCompose(opts) {
  const list = globalThis.__joinMini || (globalThis.__joinMini = [])
  list.push(opts && opts.miniRoot)
  const mini = globalThis.__joinForceMini || (opts && opts.miniRoot) || ''
  return {
    ok: true,
    miniRoot: mini,
    detail: '',
    seat: {
      seat_id: 'seat-b',
      kind: 'member',
      name: 'Pat',
      brain_label: 'Plyntr fixture',
      hq_repo: 'plyntr-fixture/plyntr-fixture-brain',
      roots: ['projects/fixture/']
    }
  }
}
export function installAgentService() {}
export function uninstallAgentService() {}
export function readState() { return {} }
export function readToken() { return '' }
`

const vendorStubs: Record<string, string> = {
  '/vendor/brain-sync/app/src/setup.js': setupSource,
  '/vendor/brain-sync/app/src/health.js': 'export function listSeats() { return [] }\n',
  '/vendor/brain-sync/app/src/paths.js': 'export function seatDir(id) { return String(id || "") }\nexport function logDir(id) { return String(id || "") }\n',
  '/vendor/brain-sync/app/src/watch-loop.js': 'export function watchLoop() { return Promise.resolve({ ok: true }) }\n',
  '/vendor/brain-sync/app/src/api.js': 'export function createApi() { return { json: async () => ({ ok: true, status: 200, body: {} }) } }\n',
  '/vendor/brain-sync/src/tokens.js': 'export function randomHex(n) { return "ab".repeat(Number(n) || 1) }\n'
}

function bump(name: string): string {
  return `\n  globalThis.__joinBump && globalThis.__joinBump(${JSON.stringify(name)});\n`
}

function once(source: string, anchor: string, insert: string, label: string, replace = false): string {
  const n = source.split(anchor).length - 1
  if (n !== 1) {
    g.__joinWrapMiss?.push(`${label} x${n}`)
    return source
  }
  return source.replace(anchor, replace ? insert : `${anchor}${insert}`)
}

function injectFile(file: string, source: string): string {
  const path = file.replace(/\\/g, '/')
  if (path.endsWith('/src/main/shell-vault.ts')) {
    return once(source, "export function acceptBrainCode(brainId: string, typedEmail: string, codeEmail: string, role: string, token: string, slug = '', repo = ''): string {", bump('acceptBrainCode'), 'acceptBrainCode')
  }
  if (path.endsWith('/src/main/brain-sync.ts')) {
    source = once(source, 'export function startBrainSync(folder: string): void {', bump('startBrainSync'), 'startBrainSync')
    return once(source, 'export function stopBrainSync(): void {', bump('stopBrainSync'), 'stopBrainSync')
  }
  if (path.endsWith('/src/main/brains.ts')) {
    return once(source, 'export function switchBrain(folder: string): { path: string; name: string; slug: string } {', bump('switchBrain'), 'switchBrain')
  }
  if (path.endsWith('/src/main/session-token.ts')) {
    return once(source, 'export function saveAccount(next: Account): Account {', bump('saveAccount'), 'saveAccount')
  }
  if (path.endsWith('/src/main/agency-brain.ts')) {
    source = once(source, 'export async function activateWatching(folder: string): Promise<{ ok: boolean; detail: string }> {', bump('activateWatching'), 'activateWatching')
    return once(source, 'async function bounceAgencyBrain(): Promise<void> {', `${bump('bounceAgencyBrain')}  return;\n`, 'bounceAgencyBrain')
  }
  if (path.endsWith('/src/main/ipc-stubs.ts')) {
    source = once(source, '  async function settleSync(folder: string): Promise<void> {', bump('settleSync'), 'settleSync')
    source = once(
      source,
      `  async function applyFolderImpl(opts?: { teamSlug?: string; dest?: string }): Promise<{
    ok: boolean
    brainPath?: string | null
    skipped?: boolean
    reason?: string
    detail?: string
  }> {`,
      bump('applyFolderImpl'),
      'applyFolderImpl'
    )
    source = once(source, '  async function putFolderPlyntr(opts: { brainId?: string; org?: string; slug?: string; repo?: string }) {', bump('putFolderPlyntr'), 'putFolderPlyntr')
    source = once(
      source,
      `async function adoptFolder(path: string): Promise<{
  path: string
  name: string
  slug: string
  agency: { ok: boolean; detail: string }
  hq: { ok: boolean; detail: string }
}> {`,
      bump('adoptFolder'),
      'adoptFolder'
    )
    return once(
      source,
      `  ipcMain.handle('app:quit', () => {
    app.quit()
  })
}`,
      `  ipcMain.handle('app:quit', () => {
    app.quit()
  })
  globalThis.__joinExposed = { putFolderPlyntr }
}`,
      'putFolderPlyntr-stash',
      true
    )
  }
  if (path.endsWith('/src/main/plyntr-sync.ts')) {
    source = `import { dirname as __joinDirname } from 'node:path'\nimport { fileURLToPath as __joinFileUrl } from 'node:url'\nconst __dirname = __joinDirname(__joinFileUrl(import.meta.url))\n${source}`
    source = once(source, 'export async function ensurePlyntrRepo(brainId: string): Promise<{ ok: boolean }> {', bump('ensurePlyntrRepo'), 'ensurePlyntrRepo')
    return once(
      source,
      'function dryRunPlyntrWorker(path: string, body: Record<string, unknown> | null, repoQuery: string): unknown {',
      `\n  if (path === '/v1/github/installed' && globalThis.__joinForceUninstalled) return { installed: false, repositorySelection: '', repo: repoQuery, projectSeatCount: 0 };\n`,
      'dryRunPlyntrWorker'
    )
  }
  if (path.endsWith('/src/main/ads2ai.ts')) {
    return once(source, 'export async function ensureBrainRepo(token: string, teamSlug: string): Promise<unknown> {', bump('ensureBrainRepo'), 'ensureBrainRepo')
  }
  if (path.endsWith('/src/main/hq-sync.ts')) {
    source = once(
      source,
      `export async function joinProject(opts: {
  email: string
  code: string
  folder?: string
}): Promise<{
  ok: boolean
  email: string
  name: string
  role: 'project'
  brainPath: string
  teamName: string
  teamSlug: string
  roots: string[]
}> {`,
      `\n  globalThis.__joinBump && globalThis.__joinBump('joinProject');\n  (globalThis.__joinFolders || (globalThis.__joinFolders = [])).push(String((opts && opts.folder) || ''));\n`,
      'joinProject'
    )
    source = once(
      source,
      'async function startWatch(seatId: string): Promise<void> {',
      `\n  globalThis.__joinBump && globalThis.__joinBump('startWatch');\n  (globalThis.__joinWatch || (globalThis.__joinWatch = [])).push(String(seatId || ''));\n  return;\n`,
      'startWatch'
    )
    source = once(
      source,
      'export async function retargetHqSync(folder: string): Promise<{ ok: boolean; detail: string }> {',
      `${bump('retargetHqSync')}  return { ok: true, detail: '' };\n`,
      'retargetHqSync'
    )
    return once(source, 'async function stopHqAgent(): Promise<void> {', `${bump('stopHqAgent')}  return;\n`, 'stopHqAgent')
  }
  if (path.endsWith('/src/main/in-app-browse.ts')) {
    return once(
      source,
      "export function openInApp(url: string, _title = 'GitHub'): { ok: boolean } {",
      `${bump('openInApp')}  return { ok: true };\n`,
      'openInApp'
    )
  }
  return source
}

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if (spec === 'electron-updater') return { url: 'stub:updater', shortCircuit: true }
    if (spec === 'node-pty') return { url: 'stub:pty', shortCircuit: true }
    if ((spec === 'node:os' || spec === 'os') && !ctx.parentURL?.startsWith('stub:os')) {
      return { url: 'stub:os', shortCircuit: true }
    }
    if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !/\.(ts|js|mjs|cjs|json)$/.test(spec)) {
      const base = resolve(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === 'stub:electron') return { format: 'module', shortCircuit: true, source: electronSource }
    if (url === 'stub:updater') return { format: 'module', shortCircuit: true, source: updaterSource }
    if (url === 'stub:pty') return { format: 'module', shortCircuit: true, source: ptySource }
    if (url === 'stub:os') return { format: 'module', shortCircuit: true, source: osSource }
    if (url.startsWith('file:')) {
      const file = fileURLToPath(url)
      const stub = Object.entries(vendorStubs).find(([suffix]) => file.endsWith(suffix))
      if (stub) return { format: 'module', shortCircuit: true, source: stub[1] }
      if (file.endsWith('.ts') && file.includes('/src/')) {
        try {
          const code = esbuild.transformSync(injectFile(file, readFileSync(file, 'utf8')), {
            loader: 'ts',
            format: 'esm',
            target: 'node22'
          }).code
          return { format: 'module', shortCircuit: true, source: code }
        } catch (err) {
          const msg = `transform failed ${file}\n${String((err as Error).message || err)}`
          return { format: 'module', shortCircuit: true, source: `throw new Error(${JSON.stringify(msg)})` }
        }
      }
    }
    return next(url, ctx)
  }
})

const realHome = process.env.HOME || ''
process.env.HOME = joinHome
process.env.PATH = String(process.env.PATH || '')
  .split(':')
  .filter((dir) => dir && !(realHome && dir.startsWith(realHome)) && !/\.(grok|local|claude)\b/.test(dir))
  .join(':')
process.env.GIT_CONFIG_GLOBAL = gitFile
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'
process.env.GIT_HTTP_LOW_SPEED_LIMIT = '1'
process.env.GIT_HTTP_LOW_SPEED_TIME = '5'
process.env.BRAIN_APP_DRY_RUN = '1'
delete process.env.BRAIN_APP_SETUP_DRIVE
delete process.env.BRAIN_APP_SETUP_ROOT
delete process.env.BRAIN_APP_SETUP_TRACE
for (const key of Object.keys(process.env)) {
  if (key === 'GIT_CONFIG_COUNT' || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete process.env[key]
}
process.chdir(rootRepo)

function git(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Join Check', '-c', 'user.email=join@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function originOf(folder: string): string {
  try {
    return execFileSync('/usr/bin/git', ['-C', folder, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return ''
  }
}

function initRepo(dir: string, origin: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'AGENTS.md'), body)
  git(dir, ['add', 'AGENTS.md'])
  git(dir, ['commit', '-q', '-m', 'init'])
  git(dir, ['remote', 'add', 'origin', origin])
}

function count(name: string): number {
  return g.__joinCounts?.[name] || 0
}

function ipcCount(name: string): number {
  return g.__joinIpc?.[name] || 0
}

function zeroCounts(): void {
  g.__joinCounts = {}
  g.__joinIpc = {}
  g.__joinFolders = []
  g.__joinWatch = []
  g.__joinMini = []
}

function inside(parent: string, child: string): boolean {
  if (!parent || !child) return false
  const base = resolve(parent)
  const path = resolve(child)
  return path === base || path.startsWith(base + sep)
}

function scopedDelete(target: string): void {
  const abs = resolve(target)
  const root = resolve(joinHome)
  if (abs !== root && !abs.startsWith(root + sep)) fail('delete-scope', abs)
  if (abs === resolve(A)) fail('delete-scope', abs)
  rmSync(abs, { recursive: true, force: true })
}

const A = join(joinHome, 'brains', 'open-a')
let vaultRoot = userData

function brainsPath(): string {
  return join(g.__userData, 'brains.json')
}
function accountPath(): string {
  return join(g.__userData, 'account.json')
}
function vaultPath(): string {
  return join(vaultRoot, 'vault.json')
}
function agencyPath(): string {
  return join(joinHome, 'Library/Application Support/Agency Brain/config.json')
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

type Pointers = { active: string; folder: string; activeId: string; brainPath: string; cwd: string; origin: string }

function pointers(cwd: string): Pointers {
  const brains = readJson(brainsPath())
  const account = existsSync(accountPath()) ? readJson(accountPath()) : {}
  const vault = existsSync(vaultPath()) ? readJson(vaultPath()) : {}
  const agency = existsSync(agencyPath()) ? readJson(agencyPath()) : {}
  return {
    active: String(brains.active || ''),
    folder: String(account.folder || ''),
    activeId: String(vault.activeId || ''),
    brainPath: String(agency.brainPath || ''),
    cwd,
    origin: originOf(A)
  }
}

function stayed(p: Pointers, activeId = 'brain-a'): boolean {
  return p.active === A && p.folder === A && p.activeId === activeId && p.brainPath === A && p.cwd === A && p.origin === OPEN_ORIGIN
}

function writeOpenFiles(brainId: string, activeId: string): void {
  mkdirSync(dirname(brainsPath()), { recursive: true })
  writeFileSync(brainsPath(), JSON.stringify({
    active: A,
    rows: [{ path: A, name: 'Open', slug: 'open', brainId }]
  }, null, 2))
  writeFileSync(accountPath(), JSON.stringify({
    email: 'ada@example.com',
    token: 'local:ada@example.com',
    folder: A,
    name: 'Ada',
    source: 'plyntr'
  }))
  writeFileSync(vaultPath(), JSON.stringify({
    shellEmail: 'ada@example.com',
    flag: false,
    activeId,
    brains: [{ id: 'brain-a', email: 'ada@example.com', role: 'scout', token: 'local-seat-a', owner: 'ada@example.com' }],
    keyless: [],
    onDisk: [],
    folders: {},
    slugs: {}
  }))
}

function settingsPin(): void {
  const text = readFileSync(join(rootRepo, 'src/renderer/src/SettingsPanel.tsx'), 'utf8')
  const start = text.indexOf('className="set-now"')
  const end = text.indexOf('className="biz-wrap"', start)
  if (start < 0 || end < 0) fail('settings', 'slice bounds')
  const slice = text.slice(start, end)
  for (const needle of ['You are inside', 'Switch brain', 'Add a brain', "I don't have a code yet", 'brains.joinSeat', 'auth.requestCode']) {
    if (!slice.includes(needle)) fail('settings', `missing ${needle}`)
  }
  for (const needle of ['This computer only', 'auth.verify', 'plyntr.resolve', 'brains.add', 'Add a new company brain']) {
    if (slice.includes(needle)) fail('settings', `forbidden ${needle}`)
  }
  if (slice.split('showBrainSwitch').length - 1 !== 1) fail('settings', 'showBrainSwitch count')
  const between = slice.slice(slice.indexOf('showBrainSwitch'), slice.indexOf('Add a brain'))
  if (!between.includes(') : null}')) fail('settings', 'switch null')
  const rest = text.slice(end)
  if (!rest.includes('Add a new company brain') || !rest.includes('brains.add')) fail('settings', 'super-admin')
}

async function main(): Promise<void> {
  const os = (await import('node:os')) as { homedir: () => string; default?: { homedir: () => string } }
  const got = os.homedir()
  const named = os.default?.homedir?.()
  if (got !== joinHome || named !== joinHome || got === '/Users/joewine' || !got.startsWith(sysTmp)) {
    fail('homedir', `got ${got} named ${named}`)
  }

  settingsPin()
  // cloneBrain strips the token from whatever `git remote get-url` prints. The insteadOf
  // rule rewrites that print to the local bare repo, so the https address would stay
  // in the new folder. The open brain's own git calls use /usr/bin/git and still see the rule.
  const shimBin = join(joinHome, '.local', 'bin')
  mkdirSync(shimBin, { recursive: true })
  writeFileSync(join(shimBin, 'git'), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "remote" ]; then
    GIT_CONFIG_GLOBAL=/dev/null
    export GIT_CONFIG_GLOBAL
    break
  fi
done
exec /usr/bin/git "$@"
`)
  chmodSync(join(shimBin, 'git'), 0o755)

  const seed = join(scratch, 'seed')
  initRepo(seed, FIXTURE_ORIGIN, `${MARKER}\n`)
  execFileSync('/usr/bin/git', ['clone', '--bare', '-q', seed, bare], { stdio: 'ignore' })
  writeFileSync(gitFile, `[url "${bare}"]\n\tinsteadOf = ${CLONE_URL}\n`)

  initRepo(A, OPEN_ORIGIN, '# Open brain\n')
  mkdirSync(dirname(agencyPath()), { recursive: true })
  writeFileSync(agencyPath(), JSON.stringify({ brainPath: A }))
  writeOpenFiles('brain-a', 'brain-a')

  const src = (name: string) => pathToFileURL(join(rootRepo, 'src/main', name)).href
  const ipc = (await import(src('ipc-stubs.ts'))) as { registerStubIpc: () => void }
  const sync = (await import(src('brain-sync.ts'))) as { startBrainSync: (folder: string) => void; brainSyncCwd: () => string }
  const vault = (await import(src('shell-vault.ts'))) as {
    storeOwnedSeat: (id: string, email: string, role: string, token: string) => void
    useRoot: (dir: string) => void
    discardMemory: () => void
    shellView: () => { signedIn: string[] }
  }
  const session = (await import(src('session-token.ts'))) as { clearAccount: () => void }
  const cloneMod = (await import(src('clone.ts'))) as {
    cloneBrain: (opts: { cloneUrl: string; dest: string; email: string; name: string }) => Promise<{ ok: boolean; dest: string; detail: string }>
    defaultBrainDest: (slug: string) => string
  }

  if (g.__joinWrapMiss?.length) fail('wrap', g.__joinWrapMiss.join('\n'))
  ipc.registerStubIpc()
  if (typeof g.__joinExposed?.putFolderPlyntr !== 'function') fail('wrap', 'putFolderPlyntr was not stashed')
  const handlers = g.__fipc
  if (!handlers?.get('brains:joinSeat') || !handlers.get('auth:requestCode') || !handlers.get('auth:verify')) fail('wrap', 'handlers')

  sync.startBrainSync(A)
  zeroCounts()
  const cwd = () => sync.brainSyncCwd()
  const here = () => pointers(cwd())
  if (!stayed(here())) fail('fixture', JSON.stringify(here()))

  const joinSeat = async (email: string, code: string) => {
    const fn = handlers.get('brains:joinSeat')
    if (!fn) fail('wrap', 'joinSeat')
    return (await fn(null, { email, code })) as { ok?: boolean; brainPath?: string; already?: boolean }
  }

  // Probe 1. The old put-folder path must still be able to move the open brain.
  {
    const savedJoin = handlers.get('brains:joinSeat')
    const put = g.__joinExposed?.putFolderPlyntr
    if (!put || !savedJoin) fail('wrap', 'probe put')
    let moved = false
    try {
      await put({ brainId: 'dry-brain', slug: 'plyntr-fixture', repo: FIXTURE_REPO })
    } catch (err) {
      console.error(`prove-red threw: ${String((err as Error).message || err)}`)
    }
    const p = here()
    moved = p.active !== A || p.folder !== A || p.cwd !== A
    handlers.set('brains:joinSeat', savedJoin)
    const dest = join(joinHome, 'Projects', 'plyntr-fixture-brain')
    if (existsSync(dest)) scopedDelete(dest)
    writeOpenFiles('brain-a', 'brain-a')
    session.clearAccount()
    writeOpenFiles('brain-a', 'brain-a')
    vault.discardMemory()
    writeFileSync(agencyPath(), JSON.stringify({ brainPath: A }))
    sync.startBrainSync(A)
    if (!moved) fail('prove-red', JSON.stringify(p))
    if (!stayed(here())) fail('prove-red', `restore ${JSON.stringify(here())}`)
  }

  // Probe 2. The owned-seat writer fills an empty active id. The join writer must not.
  {
    const row = readJson(vaultPath())
    row.activeId = ''
    writeFileSync(vaultPath(), JSON.stringify(row))
    vault.discardMemory()
    vault.storeOwnedSeat('probe-owned', 'ada@example.com', 'scout', 'probe-token')
    const saved = String(readJson(vaultPath()).activeId ?? '')
    writeOpenFiles('brain-a', 'brain-a')
    vault.discardMemory()
    if (saved !== 'probe-owned') fail('prove-owned', `activeId ${saved}`)
  }

  // Probe 3. The first-run verifier still accepts a code and moves the open seat.
  {
    const beforeAccept = count('acceptBrainCode')
    const beforeId = String(readJson(vaultPath()).activeId ?? '')
    try {
      await handlers.get('auth:verify')?.(null, 'ada@example.com', 'TESTTEST12')
    } catch (err) {
      console.error(`prove-verify threw: ${String((err as Error).message || err)}`)
    }
    const acceptRan = count('acceptBrainCode') > beforeAccept
    const idNow = String(readJson(vaultPath()).activeId ?? '')
    writeOpenFiles('brain-a', 'brain-a')
    session.clearAccount()
    writeOpenFiles('brain-a', 'brain-a')
    vault.discardMemory()
    sync.startBrainSync(A)
    if (!acceptRan && idNow === beforeId) fail('prove-verify', `accept ${acceptRan} id ${idNow}`)
    if (!stayed(here())) fail('prove-verify', `restore ${JSON.stringify(here())}`)
  }

  zeroCounts()

  // Email me a code writes nothing about which brain is open.
  process.env.BRAIN_APP_SETUP_DRIVE = '1'
  try {
    await handlers.get('auth:requestCode')?.(null, 'ada@example.com')
  } catch (err) {
    fail('email', String((err as Error).message || err))
  } finally {
    delete process.env.BRAIN_APP_SETUP_DRIVE
  }
  if (!stayed(here())) fail('email', JSON.stringify(here()))
  if (count('auth:verify') || count('auth:logout') || count('stopBrainSync') || ipcCount('auth:verify') || ipcCount('auth:logout')) {
    fail('email', `counters verify ${ipcCount('auth:verify')} logout ${ipcCount('auth:logout')} stop ${count('stopBrainSync')}`)
  }

  // GitHub app missing: the short sentence, and the open brain stays.
  g.__joinForceUninstalled = true
  try {
    let message = ''
    try {
      await joinSeat('ada@example.com', 'TESTTEST12')
    } catch (err) {
      message = String((err as Error).message || err)
    }
    if (message !== NOT_ON_GITHUB) fail('github-missing', message || 'no throw')
    if (!stayed(here())) fail('github-missing', JSON.stringify(here()))
    if (existsSync(cloneMod.defaultBrainDest('plyntr-fixture'))) fail('github-missing', 'dest created')
    for (const name of ['ensurePlyntrRepo', 'ensureBrainRepo', 'openInApp']) {
      if (count(name)) fail('github-missing', name)
    }
    if (ipcCount('setup:openAppInstall')) fail('github-missing', 'openAppInstall')
  } finally {
    g.__joinForceUninstalled = false
  }

  // A different repo already at the open folder, at the slug's folder, and a fresh folder.
  {
    const before = here()
    const refused = await cloneMod.cloneBrain({
      cloneUrl: 'https://github.com/example/other-brain.git',
      dest: A,
      email: 'ada@example.com',
      name: 'Ada'
    })
    if (refused.ok || refused.detail !== REFUSE) fail('clone-a', refused.detail)
    if (originOf(A) !== OPEN_ORIGIN || !stayed(here()) || here().active !== before.active) fail('clone-a', JSON.stringify(here()))

    const decoy = cloneMod.defaultBrainDest('open')
    if (!decoy.startsWith(joinHome)) fail('dest-home', decoy)
    initRepo(decoy, 'https://github.com/example/decoy.git', '# Decoy\n')
    const decoyOrigin = originOf(decoy)
    const again = await cloneMod.cloneBrain({
      cloneUrl: 'https://github.com/example/other-brain.git',
      dest: decoy,
      email: 'ada@example.com',
      name: 'Ada'
    })
    if (again.ok || again.detail !== REFUSE) fail('clone-b', again.detail)
    if (originOf(decoy) !== decoyOrigin || !stayed(here())) fail('clone-b', JSON.stringify(here()))

    const fresh = join(joinHome, 'clones', 'from-bare')
    const copied = await cloneMod.cloneBrain({
      cloneUrl: bare,
      dest: fresh,
      email: 'ada@example.com',
      name: 'Ada'
    })
    if (!copied.ok) fail('clone-c', copied.detail)
    const gotOrigin = originOf(fresh)
    if (gotOrigin !== bare) fail('clone-c', `origin ${gotOrigin}`)
    if (!readFileSync(join(fresh, 'AGENTS.md'), 'utf8').includes(MARKER)) fail('clone-c', 'marker')
    if (!stayed(here())) fail('clone-c', JSON.stringify(here()))
  }

  // The code for the brain already open does not clone a second copy.
  git(A, ['remote', 'set-url', 'origin', FIXTURE_ORIGIN])
  writeOpenFiles('dry-brain', 'brain-a')
  session.clearAccount()
  writeOpenFiles('dry-brain', 'brain-a')
  vault.discardMemory()
  {
    const result = await joinSeat('ada@example.com', 'TESTTEST12')
    if (!result.already) fail('same-brain', JSON.stringify(result))
    const brains = readJson(brainsPath())
    const rows = Array.isArray(brains.rows) ? brains.rows as { path?: string }[] : []
    if (rows.some((row) => resolve(String(row.path || '')) !== resolve(A))) fail('same-brain', 'second row')
    if (existsSync(cloneMod.defaultBrainDest('plyntr-fixture'))) fail('same-brain', 'dest')
    if (originOf(A) !== FIXTURE_ORIGIN) fail('same-brain', originOf(A))
    const p = here()
    if (p.active !== A || p.folder !== A || p.activeId !== 'brain-a' || p.brainPath !== A || p.cwd !== A) {
      fail('same-brain', JSON.stringify(p))
    }
    if (count('startBrainSync') || count('stopBrainSync')) fail('same-brain', 'sync')
  }
  git(A, ['remote', 'set-url', 'origin', OPEN_ORIGIN])
  writeOpenFiles('brain-a', 'brain-a')
  session.clearAccount()
  writeOpenFiles('brain-a', 'brain-a')
  vault.discardMemory()

  // The seat lands in its own folder. The open brain keeps syncing.
  sync.startBrainSync(A)
  zeroCounts()
  let added = ''
  try {
    const result = await joinSeat('ada@example.com', 'TESTTEST12')
    added = String(result.brainPath || '')
  } catch (err) {
    fail('happy', String((err as Error).message || err))
  }
  if (!added || inside(A, added)) fail('happy', `path ${added}`)
  if (!readFileSync(join(added, 'AGENTS.md'), 'utf8').includes(MARKER)) fail('happy', 'marker')
  if (originOf(added) !== FIXTURE_ORIGIN) fail('happy', `origin ${originOf(added)}`)
  const localGit = readFileSync(join(added, '.git', 'config'), 'utf8')
  if (localGit.includes('x-access-token') || localGit.includes('pbt_dry_git')) fail('happy', 'token in git config')
  if (originOf(A) !== OPEN_ORIGIN || !stayed(here())) fail('happy', JSON.stringify(here()))
  const quiet = [
    'switchBrain', 'saveAccount', 'settleSync', 'activateWatching', 'startBrainSync', 'stopBrainSync',
    'acceptBrainCode', 'retargetHqSync', 'putFolderPlyntr', 'applyFolderImpl', 'adoptFolder',
    'ensurePlyntrRepo', 'ensureBrainRepo', 'openInApp'
  ]
  for (const name of quiet) {
    if (count(name)) fail('happy', name)
  }
  for (const name of ['auth:verify', 'auth:logout', 'plyntr:resolve', 'setup:openAppInstall']) {
    if (ipcCount(name)) fail('happy', name)
  }
  const brains = readJson(brainsPath())
  const rows = Array.isArray(brains.rows) ? brains.rows as { path?: string; brainId?: string }[] : []
  if (!rows.some((row) => resolve(String(row.path || '')) === resolve(added) && row.brainId === 'dry-brain')) {
    fail('happy', 'row')
  }
  const seat = (readJson(vaultPath()).brains as { id?: string; owner?: string }[]).find((row) => row.id === 'dry-brain')
  if (seat?.owner !== 'ada@example.com') fail('happy', `owner ${seat?.owner}`)
  const signed = vault.shellView().signedIn
  if (!signed.includes('brain-a') || !signed.includes('dry-brain')) fail('happy', signed.join(','))

  // An empty active id stays empty.
  {
    const side = join(joinHome, 'userData-empty')
    mkdirSync(side, { recursive: true })
    g.__userData = side
    vaultRoot = side
    session.clearAccount()
    writeOpenFiles('brain-a', '')
    vault.useRoot(side)
    vault.discardMemory()
    await joinSeat('ada@example.com', 'TESTTEST12')
    const id = String(readJson(vaultPath()).activeId || '')
    const next = (readJson(vaultPath()).brains as { id?: string; owner?: string }[]).find((row) => row.id === 'dry-brain')
    if (id !== '') fail('empty-active', JSON.stringify(id))
    if (next?.owner !== 'ada@example.com') fail('empty-active', `owner ${next?.owner}`)
    const p = here()
    if (p.active !== A || p.folder !== A || p.brainPath !== A || p.cwd !== A || p.origin !== OPEN_ORIGIN) {
      fail('empty-active', JSON.stringify(p))
    }
  }

  // A project seat gets its own mini folder, not the open brain.
  {
    const foldersBefore = (g.__joinFolders || []).length
    const watchBefore = (g.__joinWatch || []).length
    const miniBefore = (g.__joinMini || []).length
    const result = await joinSeat('ada@example.com', 'PR0J3CT12X')
    const folders = (g.__joinFolders || []).slice(foldersBefore)
    const watches = (g.__joinWatch || []).slice(watchBefore)
    const minis = (g.__joinMini || []).slice(miniBefore)
    if (folders.length !== 1 || !folders[0] || inside(A, folders[0])) fail('project', `folder ${folders.join(',')}`)
    if (minis[0] !== folders[0]) fail('project', `mini ${minis[0]}`)
    if (!result.brainPath || inside(A, result.brainPath)) fail('project', `returned ${result.brainPath}`)
    if (watches.some((id) => id === A || inside(A, id))) fail('project', `watch ${watches.join(',')}`)
    if (count('retargetHqSync')) fail('project', 'retarget')
    const p = here()
    if (p.active !== A || p.folder !== A || p.brainPath !== A || p.cwd !== A || p.origin !== OPEN_ORIGIN) {
      fail('project', JSON.stringify(p))
    }
    const seat = (readJson(vaultPath()).brains as { id?: string; owner?: string }[]).find((row) => row.id === 'project-real')
    if (seat?.owner !== 'ada@example.com') fail('project', `owner ${seat?.owner}`)
  }

  // If the project folder comes back as the open brain, store nothing.
  {
    const side = join(joinHome, 'userData-force')
    mkdirSync(side, { recursive: true })
    g.__userData = side
    vaultRoot = side
    session.clearAccount()
    writeOpenFiles('brain-a', 'brain-a')
    vault.useRoot(side)
    vault.discardMemory()
    const before = JSON.stringify(readJson(vaultPath()).brains)
    const foldersBefore = (g.__joinFolders || []).length
    g.__joinForceMini = A
    let threw = false
    try {
      await joinSeat('ada@example.com', 'PR0J3CT12X')
    } catch {
      threw = true
    } finally {
      g.__joinForceMini = ''
    }
    const folders = (g.__joinFolders || []).slice(foldersBefore)
    if (!threw) fail('force-a', 'no throw')
    if (folders.length !== 1 || !folders[0] || inside(A, folders[0]) || existsSync(join(folders[0], '.git'))) {
      fail('force-a', `folder ${folders.join(',')}`)
    }
    if (JSON.stringify(readJson(vaultPath()).brains) !== before) fail('force-a', 'seat stored')
    const p = here()
    if (p.active !== A || p.folder !== A || p.activeId !== 'brain-a' || p.brainPath !== A || p.cwd !== A) {
      fail('force-a', JSON.stringify(p))
    }
  }

  console.log('JOIN_PASS')
}

main().catch((err) => {
  console.error(err)
  console.log('JOIN_FAIL crash')
  process.exit(1)
})
