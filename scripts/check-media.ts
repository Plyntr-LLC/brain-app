import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { createRequire, registerHooks } from 'node:module'
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CHUNK_SIZE_DEFAULT } from '../src/main/media/crypto.ts'

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const esbuild = createRequire(join(rootRepo, 'package.json'))('esbuild') as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code: string }
}

process.env.BRAIN_APP_DRY_RUN = '1'
process.env.BRAIN_MEDIA_CHUNK = String(64 * 1024)
process.env.BRAIN_MEDIA_PART = String(64 * 1024)
process.env.BRAIN_MEDIA_CUTOVER = String(256 * 1024)
process.env.BRAIN_SYNC_SEAT_TOKEN_KEY = process.env.BRAIN_SYNC_SEAT_TOKEN_KEY || 'check-media-seat-key'

const sealKey = randomBytes(32)
function seal(plain: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sealKey, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, enc, cipher.getAuthTag()])
}
function unseal(buf: Buffer): string {
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(buf.length - 16)
  const data = buf.subarray(12, buf.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', sealKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

const electronStub = `
const handlers = globalThis.__ipc ||= new Map()
export const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on() {}, removeHandler(name) { handlers.delete(name) } }
export const app = { getPath: () => globalThis.__userData, getAppPath: () => globalThis.__appPath, getVersion: () => '0.0.0', getName: () => 'Brain', isPackaged: false, on() {}, whenReady: () => Promise.resolve() }
export const BrowserWindow = { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export const shell = {}
export const clipboard = { readText: () => '' }
export const nativeImage = {}
export const Tray = class {}
export const Menu = {}
export const screen = {}
export const session = {}
export const net = {}
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => globalThis.__seal(plain),
  decryptString: (buf) => globalThis.__unseal(buf)
}
export const powerMonitor = {}
export const Notification = class {}
export const protocol = {
  registerSchemesAsPrivileged() {},
  handle(scheme, fn) {
    globalThis.__protocolHandlers ||= new Map()
    globalThis.__protocolHandlers.set(scheme, fn)
  }
}
export const webContents = {}
export const nativeTheme = {}
export const systemPreferences = {}
export default { ipcMain, app, safeStorage }
`
const updaterStub = `
const n = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : n), apply: () => n })
export const autoUpdater = n
export default { autoUpdater: n }
`

const loadedUrls: string[] = []
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
    loadedUrls.push(url)
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
  __seal: (plain: string) => Buffer
  __unseal: (buf: Buffer) => string
  fetch: typeof fetch
}
g.__appPath = rootRepo
g.__userData = mkdtempSync(join(tmpdir(), 'media-boot-'))
g.__seal = seal
g.__unseal = unseal

const mediaCalls: string[] = []
const realFetch = globalThis.fetch
g.fetch = (async (input: string | URL) => {
  const url = String(input)
  if (url.includes('/v1/media/')) mediaCalls.push(url)
  throw new Error('check-media forbids network: ' + url)
}) as typeof fetch
void realFetch

const req = createRequire(join(rootRepo, 'package.json'))
const boom = () => {
  throw new Error('check-media forbids sockets')
}
req('node:net').connect = boom
req('node:tls').connect = boom
req('node:https').request = boom

const steps: Record<string, unknown> = {}
const rendererChecks: string[] = []

function writeArtifact(body: Record<string, unknown>): void {
  const dir = join(rootRepo, 'z-logs', 'media-check')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')
  writeFileSync(join(dir, `medium-${stamp}.json`), JSON.stringify(body))
}

function fail(step: string, why: string): never {
  console.error(`MEDIA_FAIL ${step}: ${why}`)
  writeArtifact({ pass: false, steps, error: why })
  process.exit(1)
}

if (Number(process.env.BRAIN_MEDIA_CHUNK) >= CHUNK_SIZE_DEFAULT) {
  fail('A', 'dry-run chunk size is still production')
}
if (Number(process.env.BRAIN_MEDIA_PART) >= 16 * 1024 * 1024) fail('A', 'dry-run part size is still production')
if (Number(process.env.BRAIN_MEDIA_CUTOVER) >= 64 * 1024 * 1024) fail('A', 'dry-run cut-over is still production')

const vault = await import('../src/main/shell-vault.ts')
const brainsMod = await import('../src/main/brains.ts')
const ipc = await import('../src/main/media/ipc.ts')
const session = await import('../src/main/media/session.ts')
const keys = await import('../src/main/media/keys.ts')
const play = await import('../src/main/media/play.ts')
const format = await import('../src/main/media/format.ts')
const cache = await import('../src/main/media/cache.ts')
const pointer = await import('../src/main/media/pointer.ts')
const dry = await import('../src/main/media/dry-worker.ts')
const safe = await import('../src/main/media/renderer-safe.ts')
const watcher = await import('../src/main/watcher-choice.ts')
const deviceKey = await import('../src/main/media/device-key.ts')
const hmacSeat = await import('../src/main/media/hmac-seat.ts')
const transport = await import('../src/main/media/transport.ts')
const statePoll = await import('../src/main/media/state-poll.ts')
const { shouldShowStorageAsk, MEDIA_OPEN_FAIL, MEDIA_PLAY_NOTES } = await import('../src/shared/media.ts')

const ONESHOT = new Set(['media:takePassphrase', 'media:takeRecoveryKey'])

async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  const fn = g.__ipc.get(name)
  if (!fn) fail('ipc', 'missing handler ' + name)
  const out = await fn({}, ...args)
  if (!ONESHOT.has(name)) {
    try {
      safe.assertRendererSafe(out)
    } catch (err) {
      fail('10', name + ' failed assertRendererSafe: ' + String((err as Error).message || err))
    }
  }
  rendererChecks.push(name)
  return out
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkFiles(p, out)
    else out.push(p)
  }
  return out
}

function containsSecret(buf: Buffer, secret: Buffer | string): boolean {
  const raw = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8')
  if (raw.length && buf.includes(raw)) return true
  if (Buffer.isBuffer(secret) && secret.length) {
    const hex = Buffer.from(secret.toString('hex'), 'utf8')
    const b64 = Buffer.from(secret.toString('base64'), 'utf8')
    if (buf.includes(hex) || buf.includes(b64)) return true
  }
  return false
}

function forkButtons(): string[] {
  const src = readFileSync(join(rootRepo, 'src/renderer/src/PlyntrPath.tsx'), 'utf8')
  const start = src.indexOf('className="choice-stack"')
  if (start < 0) return []
  const end = src.indexOf('</div>', start)
  const stack = src.slice(start, end)
  return [...stack.matchAll(/data-setup-button="([^"]+)"/g)].map((m) => m[1])
}

function setupFolder(userData: string, folder: string, brainId: string): void {
  g.__userData = userData
  mkdirSync(userData, { recursive: true })
  mkdirSync(join(folder, 'projects', 'alpha'), { recursive: true })
  mkdirSync(join(folder, 'projects', 'beta'), { recursive: true })
  writeFileSync(join(folder, 'AGENTS.md'), '# Brain\n')
  mkdirSync(join(folder, '.team-config'), { recursive: true })
  writeFileSync(
    join(folder, '.team-config', 'roles.json'),
    JSON.stringify({ team_slug: 'alpha', team_name: 'Alpha', members: [{ email: 'owner@example.test', role: 'owner', name: 'Owner' }] })
  )
  vault.useRoot(userData)
  vault.signInEmailOnly('owner@example.test')
  vault.acceptBrainCode(brainId, 'owner@example.test', 'owner@example.test', 'owner', 'pbt_owner_slice2', 'alpha', '')
  vault.bindBrainFolder(folder, brainId)
  brainsMod.rememberBrain({
    path: folder,
    name: 'Alpha',
    slug: 'alpha',
    role: 'owner',
    syncMode: 'local',
    brainId
  })
  brainsMod.switchBrain(folder)
}

// --- B: fork fixture and watcher parity ---
const buttons = forkButtons()
if (buttons.length !== 3 || buttons[0] !== 'Sign in' || buttons[1] !== 'I have a code' || buttons[2] !== 'This computer only') {
  fail('B', 'choice-stack buttons were ' + JSON.stringify(buttons))
}
const firstRun = readFileSync(join(rootRepo, 'src/renderer/src/FirstRun.tsx'), 'utf8')
if (firstRun.includes("go('chat'") && firstRun.split("go('chat'").length !== 2) {
  fail('B', 'FirstRun still has more than one go(chat) site')
}
if (!firstRun.includes("goChat(") || !firstRun.includes("storage-ask")) fail('B', 'goChat or storage-ask missing')
const plyntrPath = readFileSync(join(rootRepo, 'src/renderer/src/PlyntrPath.tsx'), 'utf8')
if (!plyntrPath.includes('function ForkScreen') || plyntrPath.includes('storage-ask')) {
  fail('B', 'ForkScreen was edited or storage-ask leaked into PlyntrPath')
}
const settingsSrc = readFileSync(join(rootRepo, 'src/renderer/src/SettingsPanel.tsx'), 'utf8')
for (const needle of [
  '{localSyncOffer()}\n          {mediaStorageOffer()}\n          <div className="set-block">',
  '{localSyncOffer()}\n          {mediaStorageOffer()}\n          <p>You are {seatLabel(seat || role)} in {here}. The owner adds people.</p>'
]) {
  if (!settingsSrc.includes(needle)) fail('B', 'Settings mediaStorageOffer insertion missing')
}
{
  const underPack = (settingsSrc.match(/\) : null\}\n          \{storageAdmin\(\)\}\n          \{localSyncOffer\(\)\}/g) || []).length
  if (underPack !== 2) fail('B', 'storageAdmin must sit under PackSelect on both biz current branches')
  if (!settingsSrc.includes('function storageAdmin()')) fail('B', 'storageAdmin helper missing')
  const adminStart = settingsSrc.indexOf('function storageAdmin()')
  const adminEnd = settingsSrc.indexOf('const currentIndex', adminStart)
  const adminBody = adminStart >= 0 && adminEnd > adminStart ? settingsSrc.slice(adminStart, adminEnd) : ''
  if (!adminBody.includes('if (!joe || !superAdmin || !window.brain.media) return null')) {
    fail('B', 'storageAdmin must stay joe+superAdmin only')
  }
  const adminUi = readFileSync(join(rootRepo, 'src/renderer/src/MediaStoragePanel.tsx'), 'utf8')
  if (!adminUi.includes('Storage limit (GB)') || !adminUi.includes('Turn on storage for this brain')) {
    fail('B', 'MediaAdminFields copy missing')
  }
  const transportSrc = readFileSync(join(rootRepo, 'src/main/media/transport.ts'), 'utf8')
  if (!transportSrc.includes('export function assertNotR2Url') || !transportSrc.includes('export async function startDryMedia')) {
    fail('B', 'assertNotR2Url or startDryMedia missing')
  }
  if (!transportSrc.includes("throw new Error('Dry-run never loads r2-admin.')")) {
    fail('B', 'loadR2Admin must still refuse in dry-run')
  }
  if (/import\(.*r2-admin/.test(transportSrc) || transportSrc.includes("import(pathToFileURL(r2AdminPath")) {
    fail('B', 'transport.ts must not import r2-admin.js')
  }
}
if (shouldShowStorageAsk({ role: 'team', joe: false, storageOn: false, mediaAsked: false, hasSeatToken: true, routes: true })) {
  fail('B', 'storage-ask would show for team')
}
if (shouldShowStorageAsk({ role: 'project', joe: false, storageOn: false, mediaAsked: false, hasSeatToken: true, routes: true })) {
  fail('B', 'storage-ask would show for project')
}
if (!shouldShowStorageAsk({ role: 'owner', joe: false, storageOn: false, mediaAsked: false, hasSeatToken: true, routes: true })) {
  fail('B', 'storage-ask would hide for owner')
}
if (!shouldShowStorageAsk({ role: 'owner', joe: false, storageOn: false, mediaAsked: false, hasSeatToken: false, routes: true })) {
  fail('B', 'storage-ask would hide for a keyless owner')
}
if (!shouldShowStorageAsk({ role: 'owner', joe: true, storageOn: false, mediaAsked: false, hasSeatToken: false, routes: true })) {
  fail('B', 'storage-ask would hide for a keyless owner including Joe')
}
if (shouldShowStorageAsk({ role: 'team', joe: true, storageOn: false, mediaAsked: false, hasSeatToken: false, routes: true })) {
  fail('B', 'storage-ask would show for keyless team')
}
if (shouldShowStorageAsk({ role: 'owner', joe: false, storageOn: false, mediaAsked: false, hasSeatToken: true, routes: false })) {
  fail('B', 'storage-ask would show when media routes are down')
}
if (!firstRun.includes('media?.shouldAsk') && !firstRun.includes('media.shouldAsk')) {
  fail('B', 'goChat must call media.shouldAsk before storage-ask')
}
const sessionSrc = readFileSync(join(rootRepo, 'src/main/media/session.ts'), 'utf8')
if (sessionSrc.includes('startBrainSync') || sessionSrc.includes('chooseWatcher')) {
  fail('B', 'media session must not start watchers')
}
if (!sessionSrc.includes('postMediaBrainsClaim')) {
  fail('B', 'mediaEnable must consume POST /v1/media/brains {email,code}')
}
if (!sessionSrc.includes('brainForHqRepo')) {
  fail('B', 'project seats must resolve via media_brains.hq_repo')
}
if (/new DurableObject|idFromName\(/.test(sessionSrc)) {
  fail('B', 'media session invented a second project ACL')
}
if (!sessionSrc.includes('export async function mediaShouldAsk')) {
  fail('B', 'mediaShouldAsk must be async so it can read media status routes')
}
{
  const start = sessionSrc.indexOf('export async function mediaShouldAsk')
  const end = sessionSrc.indexOf('export function mediaSkip', start)
  const body = start >= 0 && end > start ? sessionSrc.slice(start, end) : ''
  if (!body.includes('mediaStatus(') || !body.includes('routes: st.routes')) {
    fail('B', 'mediaShouldAsk must reuse mediaStatus routes the same way Settings hides')
  }
}
const watchOff = watcher.chooseWatcher({ mode: 'local', abInstalled: false, abWatchingPath: false, mini: false })
const watchOn = watcher.chooseWatcher({ mode: 'local', abInstalled: false, abWatchingPath: false, mini: false })
if (watchOff !== watchOn || watchOff !== 'none') fail('B', 'chooseWatcher changed with storage')
steps.B = { forkButtons: buttons.length, watcherDelta: 0 }
ipc.registerMediaIpc()

async function withPackedHealth(status: number, fn: () => Promise<void>): Promise<void> {
  const prevDry = process.env.BRAIN_APP_DRY_RUN
  const prevFetch = g.fetch
  delete process.env.BRAIN_APP_DRY_RUN
  g.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/v1/media/health')) {
      mediaCalls.push(url)
      return new Response(status === 200 ? '{"ok":true}' : 'not found', { status })
    }
    mediaCalls.push(url)
    throw new Error('check-media forbids network: ' + url)
  }) as typeof fetch
  try {
    await fn()
  } finally {
    if (prevDry === undefined) delete process.env.BRAIN_APP_DRY_RUN
    else process.env.BRAIN_APP_DRY_RUN = prevDry
    g.fetch = prevFetch
  }
}

async function runPackedAskGate(): Promise<void> {
  await withPackedHealth(404, async () => {
    const ud = mkdtempSync(join(tmpdir(), 'media-packed-hide-'))
    const folder = mkdtempSync(join(tmpdir(), 'media-packed-hide-brain-'))
    setupFolder(ud, folder, 'brain-packed-hide')
    const st = (await invoke('media:status', folder)) as { routes: boolean }
    if (st.routes) fail('B', 'packed 404 still reported media routes live')
    const ask = await invoke('media:shouldAsk', { folder, role: 'owner' })
    if (ask) fail('B', 'packed no-routes still opened storage-ask for an owner with a pbt_ seat')
    if (existsSync(join(ud, session.ASKED_FILE))) fail('B', 'packed hide spent media-asked.json')
    if (session.mediaAskedFor(folder)) fail('B', 'packed hide marked the path as asked')
    rmSync(ud, { recursive: true, force: true })
    rmSync(folder, { recursive: true, force: true })
  })
  await withPackedHealth(200, async () => {
    const ud = mkdtempSync(join(tmpdir(), 'media-packed-live-'))
    const folder = mkdtempSync(join(tmpdir(), 'media-packed-live-brain-'))
    setupFolder(ud, folder, 'brain-packed-live')
    const st = (await invoke('media:status', folder)) as { routes: boolean }
    if (!st.routes) fail('B', 'packed health 200 hid media routes')
    const ownerAsk = await invoke('media:shouldAsk', { folder, role: 'owner' })
    if (!ownerAsk) fail('B', 'storage-ask hid for owner when routes were live')
    const scoutAsk = await invoke('media:shouldAsk', { folder, role: 'scout' })
    if (!scoutAsk) fail('B', 'storage-ask hid for scout when routes were live')
    const teamAsk = await invoke('media:shouldAsk', { folder, role: 'team' })
    if (teamAsk) fail('B', 'storage-ask showed for team when routes were live')
    const keyless = await invoke('media:shouldAsk', {
      folder: mkdtempSync(join(tmpdir(), 'media-keyless-')),
      role: 'owner'
    })
    if (!keyless) fail('B', 'storage-ask hid for a keyless owner when routes were live')
    if (existsSync(join(ud, session.ASKED_FILE))) fail('B', 'routes-live ask spent media-asked.json before an answer')
    await invoke('media:skip', folder)
    if (!session.mediaAskedFor(folder)) fail('B', 'Keep on this computer did not write media-asked when routes were live')
    const afterSkip = await invoke('media:shouldAsk', { folder, role: 'owner' })
    if (afterSkip) fail('B', 'storage-ask still showed after Keep on this computer')
    rmSync(ud, { recursive: true, force: true })
    rmSync(folder, { recursive: true, force: true })
  })
}

async function runKeepNever(): Promise<void> {
  const keepUd = mkdtempSync(join(tmpdir(), 'media-keep-'))
  const keepFolder = mkdtempSync(join(tmpdir(), 'media-keep-brain-'))
  const before = mediaCalls.length
  setupFolder(keepUd, keepFolder, 'brain-keep')
  await invoke('media:skip', keepFolder)
  if (mediaCalls.length !== before) fail('A', 'Keep on this computer called /v1/media/')
  if (existsSync(join(keepUd, 'media'))) fail('A', 'Keep created userData/media')
  const neverUd = mkdtempSync(join(tmpdir(), 'media-never-'))
  const neverFolder = mkdtempSync(join(tmpdir(), 'media-never-brain-'))
  setupFolder(neverUd, neverFolder, 'brain-never')
  if (mediaCalls.length !== before) fail('A', 'unanswered brain called /v1/media/')
  if (existsSync(join(neverUd, 'media'))) fail('A', 'unanswered brain created userData/media')
  rmSync(keepUd, { recursive: true, force: true })
  rmSync(keepFolder, { recursive: true, force: true })
  rmSync(neverUd, { recursive: true, force: true })
  rmSync(neverFolder, { recursive: true, force: true })
}

await runPackedAskGate()
await runKeepNever()
steps.A = { keep: true, never: true, packedHide: true, packedLive: true, mediaCalls: mediaCalls.length }

const userData = mkdtempSync(join(tmpdir(), 'media-a-'))
const folder = mkdtempSync(join(tmpdir(), 'media-brain-'))
setupFolder(userData, folder, 'brain-owner')
g.__userData = userData
vault.useRoot(userData)
steps['1'] = { folder: true, projects: ['alpha', 'beta'] }

const enabled = (await invoke('media:enable', { folder })) as { ok: boolean; fingerprint: string }
if (!enabled?.ok) fail('2', 'enable failed')
const pass1 = await invoke('media:takePassphrase', folder)
const rec1 = await invoke('media:takeRecoveryKey', folder)
const pass2 = await invoke('media:takePassphrase', folder)
const rec2 = await invoke('media:takeRecoveryKey', folder)
if (typeof pass1 !== 'string' || !pass1.includes(' ')) fail('2', 'passphrase was not returned once')
if (typeof rec1 !== 'string' || !String(rec1).startsWith('RK1-')) fail('2', 'recovery key was not returned once')
if (pass2 != null || rec2 != null) fail('2', 'one-shot returned a secret twice')
const mediaJsonPath = join(folder, '.team-config', 'media.json')
if (!existsSync(mediaJsonPath)) fail('2', 'owner enable did not write .team-config/media.json')
const mediaJson = JSON.parse(readFileSync(mediaJsonPath, 'utf8')) as { version?: number; mediaBrainId?: string }
if (mediaJson.version !== 1 || !mediaJson.mediaBrainId) fail('2', 'media.json was not { version: 1, mediaBrainId }')
if (Object.keys(mediaJson).sort().join(',') !== 'mediaBrainId,version') fail('2', 'media.json has extra keys')
steps['2'] = { recoveryShownOnce: true, passphraseShownOnce: true }

const filePath = join(folder, 'clip.bin')
const plain = Buffer.alloc(64 * 1024 * 5, 7)
plain.write('PLAINTEXT-MARKER-7f3c', 100)
writeFileSync(filePath, plain)

const beforeCap = (await invoke('media:add', { folder, root: 'projects/alpha/', path: filePath })) as {
  ok: boolean
  status?: number
  error?: string
}
if (beforeCap.ok || beforeCap.status !== 409 || beforeCap.error !== 'no_cap') {
  fail('3', 'expected 409 no_cap got ' + JSON.stringify(beforeCap))
}
await invoke('media:setCap', { folder, capBytes: 10 * 1024 * 1024 })
const bucket = (await invoke('media:turnOnBucket', folder)) as { ok: boolean; bucket: string }
if (!bucket?.ok || !bucket.bucket.startsWith('bm-')) fail('3', 'bucket did not turn on')
if (!existsSync(join(userData, 'media-dry-bucket', bucket.bucket))) fail('3', 'directory bucket missing')
steps['3'] = { cap: { before: 409 }, bucket: bucket.bucket }

const added = (await invoke('media:add', { folder, root: 'projects/alpha/', path: filePath })) as {
  ok: boolean
  rel?: string
  parts?: number
  detail?: string
}
if (!added.ok) fail('4', 'add failed ' + JSON.stringify(added))
if ((added.parts || 0) < 3) fail('4', 'expected at least 3 multipart parts, got ' + added.parts)
steps['4'] = { rel: added.rel, parts: added.parts }

const dumped = session.mediaDumpStore()
const brainRow = dumped.brains[0]
if (!brainRow) fail('12', 'no brain row')
const obj = dumped.objects[0]
if (!obj) fail('12', 'no object row')
const mediaId = obj.id
const chunk = Number(process.env.BRAIN_MEDIA_CHUNK)
const start = chunk + 40
const end = plain.length - 1
if (start >= end || Math.floor(start / chunk) === Math.floor(end / chunk)) fail('6', 'range must cross a chunk boundary')

const twSrc = readFileSync(join(rootRepo, 'src/renderer/src/TerminalWorkspace.tsx'), 'utf8')
if (!twSrc.includes('brain-media://') || !twSrc.includes("fileKind === 'media'")) {
  fail('6', 'file tab missing media player')
}
if (!twSrc.includes('className="note"') || !twSrc.includes('MEDIA_PLAY_NOTES')) {
  fail('6', 'file tab missing media error notes')
}
for (const msg of MEDIA_PLAY_NOTES) {
  if (!msg) fail('6', 'missing play note')
}
const filesSrc = readFileSync(join(rootRepo, 'src/main/files.ts'), 'utf8')
if (!filesSrc.includes("kind: 'media'") || !filesSrc.includes('.media.md')) fail('6', 'readSafe media kind missing')
const indexSrc = readFileSync(join(rootRepo, 'src/main/index.ts'), 'utf8')
const protocolSrc = readFileSync(join(rootRepo, 'src/main/media/protocol.ts'), 'utf8')
if (!protocolSrc.includes('registerSchemesAsPrivileged') || !protocolSrc.includes('brain-media')) {
  fail('6', 'brain-media scheme is not registered before ready')
}
if (!indexSrc.includes('registerBrainMediaScheme()')) fail('6', 'index does not register the brain-media scheme')
if (indexSrc.indexOf('registerBrainMediaScheme()') > indexSrc.indexOf('app.whenReady()')) {
  fail('6', 'brain-media scheme must register before app.whenReady')
}
if (!indexSrc.includes('handleBrainMediaProtocol()')) fail('6', 'brain-media handler is not installed at ready')

const played = play.playMedia({ folder, mediaId })
const plaintextSha256 = createHash('sha256').update(plain).digest('hex')
const playedSha256 = createHash('sha256').update(played.bytes).digest('hex')
if (playedSha256 !== plaintextSha256) fail('6', 'played bytes did not match the source')
const rangeRes = await play.handleBrainMediaRequest({
  url: `brain-media://${mediaId}`,
  headers: { Range: `bytes=${start}-${end}` }
})
if (rangeRes.status !== 206) fail('6', 'range status was ' + rangeRes.status)
const rangeBytes = Buffer.from(await rangeRes.arrayBuffer())
if (Buffer.compare(rangeBytes, plain.subarray(start, end + 1)) !== 0) fail('6', 'range bytes did not match the source span')
if (play.parseBrainMediaUrl(`brain-media://${mediaId}`) !== mediaId) fail('6', 'brain-media URL did not parse')
const playA = { caller: 'A' as const, shaMatch: true, rangeOk: true }
steps['6'] = playA

const objPath = dry.dryObjectPath(userData, bucket.bucket, obj.object_key)
const objectBuf = readFileSync(objPath)
const objectSha256 = createHash('sha256').update(objectBuf).digest('hex')
if (objectBuf.includes('PLAINTEXT-MARKER-7f3c')) fail('8', 'plaintext marker present in object')
if (objectBuf.subarray(0, 8).toString('ascii') !== 'BRMEDIA1') fail('8', 'object magic was not BRMEDIA1')
if (objectSha256 === plaintextSha256) fail('8', 'object SHA matched plaintext')
steps['8'] = { markerInObject: false, magic: 'BRMEDIA1', objectSha256, plaintextSha256 }

const pointerDir = join(folder, 'projects', 'alpha', 'media')
const pointerFiles = existsSync(pointerDir) ? readdirSync(pointerDir).filter((n) => n.endsWith('.media.md')) : []
if (pointerFiles.length !== 1) fail('9', 'expected one pointer, got ' + pointerFiles.join(','))
const pointerPath = join(pointerDir, pointerFiles[0])
const pointerText = readFileSync(pointerPath, 'utf8')
const parsed = pointer.parsePointer(pointerText)
const pointerKeys = Object.keys(parsed)
if (pointerKeys.length !== 6 || pointer.POINTER_KEYS.some((k) => !pointerKeys.includes(k))) {
  fail('9', 'pointer keys were ' + pointerKeys.join(','))
}
if (/[A-Za-z0-9+/]{40,}={0,2}/.test(pointerText)) fail('9', 'pointer has a long base64 run')
if (/\bpbt_|\bpms_|X-Amz-|\bbm-/.test(pointerText)) fail('9', 'pointer has a secret pattern')
steps['9'] = { pointerPath: added.rel, pointerKeys }

const passWrap = {
  salt: Buffer.from(brainRow.passphrase_salt, 'hex'),
  N: keys.SCRYPT_N,
  r: keys.SCRYPT_R,
  p: keys.SCRYPT_P,
  wrap: Buffer.from(brainRow.passphrase_wrap, 'hex'),
  proofPublicKey: Buffer.from(brainRow.passphrase_proof, 'hex')
}
const brainKey = keys.unwrapBrainKeyWithPassphrase({
  wrap: passWrap,
  passphrase: String(pass1),
  mediaBrainId: brainRow.id
})
const recRaw = keys.parseRecoveryKey(String(rec1))
const projectKey = keys.takeKey(`scope:${obj.scope_id}`)
if (!projectKey) fail('12', 'project key not in memory')
const dek = keys.unwrapDek({
  wrap: Buffer.from(obj.dek_wrap, 'hex'),
  projectKey,
  mediaId: obj.id,
  scopeId: obj.scope_id,
  keyVersion: obj.dek_version
})
const secrets: Array<Buffer | string> = [brainKey, projectKey, dek, recRaw, String(pass1), String(rec1)]
const storeJson = Buffer.from(JSON.stringify(dumped))
for (const secret of secrets) {
  if (containsSecret(storeJson, secret)) fail('12', 'bare key in memory store')
}
for (const file of walkFiles(userData)) {
  const buf = readFileSync(file)
  for (const secret of secrets) {
    if (containsSecret(buf, secret)) fail('12', 'bare key on disk in ' + file)
  }
}
const wrapAlone = Buffer.from(obj.dek_wrap, 'hex')
let opened = false
try {
  keys.aesGcmOpen(Buffer.alloc(32), wrapAlone, Buffer.from('nope'))
  opened = true
} catch {
  opened = false
}
if (opened) fail('12', 'dek wrap opened without the project key')
steps['12'] = { bareKeysInStore: false, bareKeysOnDisk: false, dekWrapAloneDecrypts: false }

const originalObj = Buffer.from(objectBuf)
const flipped = Buffer.from(originalObj)
flipped[format.HEADER_BYTES] = flipped[format.HEADER_BYTES] ^ 0xff
writeFileSync(objPath, flipped)
cache.deleteCipherCache(userData, brainRow.id, mediaId)
let flippedMsg = ''
try {
  play.playMedia({ folder, mediaId })
} catch (err) {
  flippedMsg = String((err as Error).message || err)
}
if (flippedMsg !== MEDIA_OPEN_FAIL) fail('13', 'flipped play said ' + JSON.stringify(flippedMsg))
if (cache.cipherCacheExists(userData, brainRow.id, mediaId)) fail('13', 'cache remained after a flipped play')

const header = format.decodeHeader(originalObj)
const lastPlain = header.chunkCount ? format.plainBytesForChunk(header, header.chunkCount - 1) : 0
const lastCipher = lastPlain + 16
const truncated = originalObj.subarray(0, originalObj.length - lastCipher)
writeFileSync(objPath, truncated)
cache.deleteCipherCache(userData, brainRow.id, mediaId)
let truncatedMsg = ''
try {
  play.playMedia({ folder, mediaId })
} catch (err) {
  truncatedMsg = String((err as Error).message || err)
}
if (truncatedMsg !== MEDIA_OPEN_FAIL) fail('13', 'truncated play said ' + JSON.stringify(truncatedMsg))
if (cache.cipherCacheExists(userData, brainRow.id, mediaId)) fail('13', 'cache remained after a truncated play')
writeFileSync(objPath, originalObj)
steps['13'] = { tamper: { flipped: 'refused', truncated: 'refused' } }

function asDevice(ud: string): void {
  session.mediaDropKeys()
  g.__userData = ud
  vault.useRoot(ud)
  brainsMod.rememberBrain({
    path: folder,
    name: 'Alpha',
    slug: 'alpha',
    role: ud === userData ? 'owner' : 'project',
    syncMode: 'local',
    brainId: ud === userData ? 'brain-owner' : undefined
  })
  brainsMod.switchBrain(folder)
}

function asOwner(): void {
  asDevice(userData)
  vault.signInEmailOnly('owner@example.test')
}

const ipcSrc = readFileSync(join(rootRepo, 'src/main/ipc-stubs.ts'), 'utf8')
if (!ipcSrc.includes('recordMintedInvite') || !ipcSrc.includes('afterPlyntrSeatRevoke') || !ipcSrc.includes('afterHqProjectRevoke')) {
  fail('5', 'ipc-stubs must record minted invites and call media revoke after seat revoke')
}
if (!ipcSrc.includes("'plyntr:revokeSeat'") || !ipcSrc.includes("'hqSync:revoke'")) {
  fail('5', 'missing seat-revoke IPC hooks')
}
const mediaIpcSrc = readFileSync(join(rootRepo, 'src/main/media/ipc.ts'), 'utf8')
if (!mediaIpcSrc.includes('media:revokeDevice') || !mediaIpcSrc.includes('media:revokeSeat')) {
  fail('5', 'missing media revoke IPC hooks')
}

const userDataB = mkdtempSync(join(tmpdir(), 'media-b-'))
const userDataF = mkdtempSync(join(tmpdir(), 'media-f-'))
const userDataC = mkdtempSync(join(tmpdir(), 'media-c-'))
asOwner()
const seatB = session.mintProjectMediaSeat({
  folder,
  email: 'alpha-person@example.test',
  roots: ['projects/alpha/']
})
const seatF = session.mintProjectMediaSeat({
  folder,
  email: 'alpha-keeper@example.test',
  roots: ['projects/alpha/']
})
const seatC = session.mintProjectMediaSeat({
  folder,
  email: 'beta-person@example.test',
  roots: ['projects/beta/']
})
for (const seat of [seatB, seatF, seatC]) {
  if (seat.token.startsWith('pbt_') || seat.token.startsWith('pms_') || !seat.token.includes('.')) {
    fail('5', 'project seat used a pbt_ token')
  }
}
const tokensJs = (await import(pathToFileURL(join(rootRepo, 'vendor/brain-sync/src/tokens.js')).href)) as {
  verifySeatToken: (
    token: string,
    secret: string
  ) => Promise<{ ok: boolean; payload?: { kind?: string; hq_repo?: string; roots?: string[] } }>
}
for (const seat of [seatB, seatF, seatC]) {
  const verified = await tokensJs.verifySeatToken(seat.token, String(process.env.BRAIN_SYNC_SEAT_TOKEN_KEY || ''))
  if (!verified.ok) fail('5', 'HMAC token failed brain-sync verifySeatToken')
  if (verified.payload?.kind !== 'client-project') fail('5', 'HMAC kind was not client-project')
  if (verified.payload?.hq_repo !== 'plyntr/alpha-brain') fail('5', 'HMAC hq_repo did not match the dry-run brain')
}
const loadedV1 = await transport.loadMediaV1()
if (transport.MEDIA_V1_TIP !== 'cb25c2b0a58cc5553497cf8f50b1f010f8ba2e62') {
  fail('5', 'MEDIA_V1_TIP is not the Slice 6 worker merge')
}
const liveRoot = await transport.resolveMediaSyncRoot()
const liveSource = transport.readMediaV1Source(liveRoot)
if (liveSource) {
  if (!transport.mediaV1SourceHasSlice6(liveSource)) {
    fail('5', 'media-v1.js is missing Slice 6 routes at ' + liveRoot)
  }
  if (/DurableObject|idFromName\(/.test(liveSource) && /HqRepo/.test(liveSource)) {
    fail('5', 'media-v1.js re-reads HqRepo DO; keep media_brains.hq_repo')
  }
}
if (loadedV1 && typeof loadedV1 === 'object') {
  const v1 = loadedV1 as { handleMediaV1?: unknown; markMediaRevoked?: unknown }
  const names = Object.keys(v1)
  if (names.includes('handleMediaV1') || names.includes('markMediaRevoked')) {
    if (typeof v1.handleMediaV1 !== 'function') fail('5', 'media-v1.js missing handleMediaV1')
    if (typeof v1.markMediaRevoked !== 'function') fail('5', 'media-v1.js missing markMediaRevoked')
  }
}
asDevice(userDataB)
const regB = session.registerMediaDevice({ folder, token: seatB.token })
asDevice(userDataF)
const regF = session.registerMediaDevice({ folder, token: seatF.token })
asDevice(userDataC)
const regC = session.registerMediaDevice({ folder, token: seatC.token })
asOwner()
const wrapIn = session.runMediaCheckIn(folder)
if (!wrapIn.wrapped.includes(regB.deviceId) || !wrapIn.wrapped.includes(regF.deviceId)) {
  fail('5', 'owner check-in did not auto-wrap B and F from minted.json')
}
if (!wrapIn.wrapped.includes(regC.deviceId)) fail('5', 'owner check-in did not auto-wrap C for beta')
steps['5'] = { minted: true, wrapped: wrapIn.wrapped.length, tokens: 'hmac' }

asDevice(userDataB)
session.runMediaCheckIn(folder)
const playedB = play.playMedia({ folder, mediaId })
const playedBSha = createHash('sha256').update(playedB.bytes).digest('hex')
if (playedBSha !== plaintextSha256) fail('6', 'device B played bytes did not match the source')
const rangeB = await play.handleBrainMediaRequest({
  url: `brain-media://${mediaId}`,
  headers: { Range: `bytes=${start}-${end}` }
})
if (rangeB.status !== 206) fail('6', 'device B range status was ' + rangeB.status)
const rangeBBytes = Buffer.from(await rangeB.arrayBuffer())
if (Buffer.compare(rangeBBytes, plain.subarray(start, end + 1)) !== 0) fail('6', 'device B range bytes did not match')
const fetchB = session.mediaDownload({ folder, mediaId })
if (fetchB.status !== 200) fail('6', 'device B download status was ' + fetchB.status)
steps['6'] = { caller: 'B', shaMatch: true, rangeOk: true, alsoA: true }
const seatBResult = { status: 200, shaMatch: true, rangeOk: true, token: 'hmac' as const }

asDevice(userDataC)
session.runMediaCheckIn(folder)
const fetchC = session.mediaDownload({ folder, mediaId })
if (fetchC.status !== 403 || fetchC.error !== 'wrong_project') {
  fail('7', 'C expected 403 wrong_project got ' + JSON.stringify(fetchC))
}
const wrapsCPath = join(userDataC, 'media', brainRow.id, 'wraps.json')
if (existsSync(wrapsCPath)) {
  const wrapsC = JSON.parse(readFileSync(wrapsCPath, 'utf8')) as { wraps: { scope: string }[] }
  if ((wrapsC.wraps || []).some((w) => w.scope === obj.scope_id)) fail('7', 'C wraps.json has an alpha scope')
}
if (seatC.token.startsWith('pbt_')) fail('7', 'C used a pbt_ token')
steps['7'] = { status: 403, error: 'wrong_project', token: 'hmac' }
const seatCResult = { status: 403, error: 'wrong_project', token: 'hmac' as const }

asOwner()
const left = (brainRow.cap_bytes || 0) - (session.mediaDumpStore().brains[0]?.used_bytes || 0)
const racePlain = Buffer.alloc(Math.max(64 * 1024, Math.floor(left * 0.6)), 9)
const race1 = join(folder, 'race-1.bin')
const race2 = join(folder, 'race-2.bin')
writeFileSync(race1, racePlain)
writeFileSync(race2, racePlain)
const objectsBeforeRace = session.mediaDumpStore().objects.length
const raced = await Promise.all([
  invoke('media:add', { folder, root: 'projects/alpha/', path: race1 }) as Promise<{
    ok: boolean
    status?: number
    error?: string
  }>,
  invoke('media:add', { folder, root: 'projects/alpha/', path: race2 }) as Promise<{
    ok: boolean
    status?: number
    error?: string
  }>
])
const won = raced.filter((r) => r.ok).length
const lost = raced.filter((r) => !r.ok && r.status === 413 && r.error === 'over_cap').length
if (won !== 1 || lost !== 1) fail('14', 'cap race was ' + JSON.stringify(raced))
const objectsAfterRace = session.mediaDumpStore().objects.length
if (objectsAfterRace !== objectsBeforeRace + 1) fail('14', 'second object was written')
steps['14'] = { cap: { over: 413, raced: 1 } }

asDevice(userDataB)
const aside = mkdtempSync(join(tmpdir(), 'media-b-aside-'))
mkdirSync(join(aside, 'media', brainRow.id), { recursive: true })
copyFileSync(join(userDataB, 'media', brainRow.id, 'wraps.json'), join(aside, 'media', brainRow.id, 'wraps.json'))
copyFileSync(join(userDataB, 'media', brainRow.id, 'device.key'), join(aside, 'media', brainRow.id, 'device.key'))
const probe401 = mkdtempSync(join(tmpdir(), 'media-401-'))
cpSync(join(userDataB, 'media'), join(probe401, 'media'), { recursive: true })
const leftOn401 = statePoll.applyMediaState({
  userData: probe401,
  mediaBrainId: brainRow.id,
  httpStatus: 401
})
if (leftOn401.wiped) fail('15', '401 wiped the media folder')
if (!existsSync(join(probe401, 'media', brainRow.id, 'wraps.json'))) fail('15', '401 deleted wraps.json')
asOwner()
const revoked = session.revokeMediaDevice({ folder, deviceId: regB.deviceId })
if (revoked.kind !== 'project') fail('15', 'project revoke kind was ' + revoked.kind)
asDevice(userDataB)
const pollB = session.runMediaCheckIn(folder)
if (pollB.status !== 410 || pollB.error !== 'device_revoked' || !pollB.wiped) {
  fail('15', 'B state poll was ' + JSON.stringify(pollB))
}
if (existsSync(join(userDataB, 'media', brainRow.id))) fail('15', 'B media folder was not deleted after 410')
const brainVersionBefore = session.mediaDumpStore().brains[0]?.brain_key_version
asOwner()
const rotated = session.runMediaCheckIn(folder)
if (!rotated.rotated.length) fail('15', 'owner check-in did not rotate the alpha scope')
const dumpedAfter = session.mediaDumpStore()
if (dumpedAfter.brains[0]?.brain_key_version !== brainVersionBefore) fail('15', 'brain key version changed on project revoke')
const alphaScope = dumpedAfter.scopes.find((s) => s.id === obj.scope_id)
if (!alphaScope || alphaScope.key_version <= 1) fail('15', 'alpha key version did not bump')
if (dumpedAfter.wraps.some((w) => w.device_id === regB.deviceId)) fail('15', 'B wraps remained after revoke')
const file2 = join(folder, 'clip-2.bin')
writeFileSync(file2, Buffer.alloc(64 * 1024, 4))
const added2 = (await invoke('media:add', { folder, root: 'projects/alpha/', path: file2 })) as {
  ok: boolean
  rel?: string
}
if (!added2.ok) fail('15', 'second alpha upload failed ' + JSON.stringify(added2))
const obj2 = session.mediaDumpStore().objects.find((o) => o.id !== mediaId && o.scope_id === obj.scope_id && o.bytes === 64 * 1024)
if (!obj2 || obj2.dek_version !== alphaScope.key_version) fail('15', 'second file dek_wrap did not use the new project key version')
const safeStub = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => g.__seal(plain),
  decryptString: (buf: Buffer) => g.__unseal(buf)
}
const oldDevice = deviceKey.loadDeviceKey(aside, brainRow.id, safeStub)
if (!oldDevice) fail('15', 'could not load saved device.key')
const oldWraps = JSON.parse(readFileSync(join(aside, 'media', brainRow.id, 'wraps.json'), 'utf8')) as {
  wraps: { scope: string; key_version: number; eph_pub: string; nonce: string; ciphertext: string }[]
}
const oldAlpha = oldWraps.wraps.find((w) => w.scope === obj.scope_id)
if (!oldAlpha) fail('15', 'saved wraps.json missing alpha wrap')
const oldProjectKey = keys.unwrapKeyFromDevice({
  wrap: {
    ephPub: Buffer.from(oldAlpha.eph_pub, 'hex'),
    nonce: Buffer.from(oldAlpha.nonce, 'hex'),
    ciphertext: Buffer.from(oldAlpha.ciphertext, 'hex')
  },
  devicePrivateKey: oldDevice.privateKey,
  mediaBrainId: brainRow.id,
  scope: oldAlpha.scope,
  version: oldAlpha.key_version
})
let oldOpened = false
try {
  keys.unwrapDek({
    wrap: Buffer.from(obj2.dek_wrap, 'hex'),
    projectKey: oldProjectKey,
    mediaId: obj2.id,
    scopeId: obj2.scope_id,
    keyVersion: obj2.dek_version
  })
  oldOpened = true
} catch {
  oldOpened = false
}
if (oldOpened) fail('15', 'saved old wrap unwrapped the new file')
hmacSeat.writeHmacSeat(userDataB, {
  token: seatB.token,
  email: 'alpha-person@example.test',
  roots: ['projects/alpha/'],
  hq_repo: 'plyntr/alpha-brain',
  seat_id: seatB.seat_id
})
asDevice(userDataB)
const refused = session.mediaDownload({ folder, mediaId })
if (refused.status !== 410 && refused.status !== 403) fail('15', 'revoked HMAC download was ' + JSON.stringify(refused))
asDevice(userDataF)
session.runMediaCheckIn(folder)
const playedF = play.playMedia({ folder, mediaId })
if (createHash('sha256').update(playedF.bytes).digest('hex') !== plaintextSha256) {
  fail('15', 'F could not play the file from step 4 after rotation')
}
asOwner()
steps['15'] = {
  revoke: { state: 410, wiped: true, rotated: true, oldWrapFails: true, downloadRefused: true }
}

steps['10'] = { rendererChecks: rendererChecks.slice() }
if (!rendererChecks.includes('media:enable') || !rendererChecks.includes('media:add')) {
  fail('10', 'expected media IPC returns to pass assertRendererSafe')
}

function moduleRegistryKeys(): string[] {
  const keys: string[] = loadedUrls.slice()
  const cjs = req.cache
  if (cjs) keys.push(...Object.keys(cjs))
  const Module = req('node:module') as { _cache?: Record<string, unknown> }
  if (Module._cache) keys.push(...Object.keys(Module._cache))
  return keys
}

function assertR2AdminAbsent(where: string): void {
  const hits = moduleRegistryKeys().filter((k) => /r2-admin/.test(k))
  if (hits.length) fail('11', `${where}: r2-admin was in the module registry ${JSON.stringify(hits)}`)
}

assertR2AdminAbsent('after playback')

const probeRoot = mkdtempSync(join(tmpdir(), 'media-r2-probe-'))
const probeUd = mkdtempSync(join(tmpdir(), 'media-r2-ud-'))
mkdirSync(join(probeRoot, 'src'), { recursive: true })
writeFileSync(join(probeRoot, 'package.json'), JSON.stringify({ type: 'module' }))
writeFileSync(join(probeRoot, 'src', 'media-v1.js'), 'export const kind = "media-v1"\n')
writeFileSync(
  join(probeRoot, 'src', 'r2-admin.js'),
  'globalThis.__R2_ADMIN_LOADED = true\nexport const kind = "r2-admin"\n'
)
const started = await transport.startDryMedia({
  userData: probeUd,
  bucket: 'bm-slice4dryyyyyyyyyyyyyyyy',
  syncRoot: probeRoot
})
if (started.bucket.bucket_status !== 'on') fail('11', 'startDryMedia did not use the directory bucket')
if (!existsSync(join(probeUd, 'media-dry-bucket', started.bucket.bucket))) {
  fail('11', 'startDryMedia did not write the in-process directory bucket')
}
if ((started.mediaV1 as { kind?: string } | null)?.kind !== 'media-v1') fail('11', 'startDryMedia did not load media-v1 in process')
if ((globalThis as { __R2_ADMIN_LOADED?: boolean }).__R2_ADMIN_LOADED) fail('11', 'startDryMedia loaded r2-admin.js')
let loadMsg = ''
try {
  await transport.loadR2Admin(probeRoot)
  fail('11', 'loadR2Admin did not throw')
} catch (err) {
  loadMsg = String((err as Error).message || err)
}
if (loadMsg !== 'Dry-run never loads r2-admin.') fail('11', 'loadR2Admin said ' + JSON.stringify(loadMsg))
if ((globalThis as { __R2_ADMIN_LOADED?: boolean }).__R2_ADMIN_LOADED) fail('11', 'loadR2Admin loaded r2-admin.js')
try {
  transport.assertNotR2Url('https://acct.r2.cloudflarestorage.com/o/x')
  fail('11', 'assertNotR2Url allowed an R2 URL')
} catch (err) {
  if (String((err as Error).message || err) !== transport.R2_REFUSE) {
    fail('11', 'assertNotR2Url said ' + String((err as Error).message || err))
  }
}
transport.assertNotR2Url('brain-media://3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90')
assertR2AdminAbsent('after startDryMedia probe')
rmSync(probeRoot, { recursive: true, force: true })
rmSync(probeUd, { recursive: true, force: true })
steps['11'] = {
  network: 0,
  sockets: 0,
  r2Admin: false,
  r2AdminInRegistry: false,
  loadR2AdminThrows: true,
  startDryMediaDirectoryBucket: true
}

const SLICE6_OWN = ['A', 'B', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22']
for (const s of SLICE6_OWN) {
  if (!(s in steps) && Number(s) <= 15) fail(s, 'slice 6 must keep this step')
}

const grants = await import('../src/main/media/grants.ts')
const wrapsFile = await import('../src/main/media/wraps-file.ts')
const reclaimBodies: unknown[] = []
const userDataD = mkdtempSync(join(tmpdir(), 'media-d-'))
const userDataE = mkdtempSync(join(tmpdir(), 'media-e-'))
mkdirSync(userDataD, { recursive: true })
mkdirSync(userDataE, { recursive: true })

asOwner()
session.addMediaMember({ folder, email: 'team@example.test', role: 'team', seatKind: 'full' })
session.addMediaMember({
  folder,
  email: 'was-owner@example.test',
  role: 'owner',
  status: 'revoked',
  seatKind: 'full'
})
const brainId = session.mediaDumpStore().brains[0]?.id || ''
if (!brainId) fail('16', 'missing brain id')
asDevice(userDataD)
const liveD = deviceKey.ensureDeviceKey(userDataD, brainId, {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => seal(plain),
  decryptString: (buf: Buffer) => unseal(buf)
})
const dPub = liveD.publicKey.toString('hex')

function startFor(email: string) {
  const minted = session.requestMediaEmailCode(email)
  if (!minted.code) fail('16', 'email code missing for ' + email)
  const res = session.mediaReclaimStart({
    email,
    code: minted.code,
    devicePublicKey: dPub,
    mediaBrainId: brainId
  })
  reclaimBodies.push(res.body)
  return res
}

const projectStart = startFor('beta-person@example.test')
const teamStart = startFor('team@example.test')
const revokedOwner = startFor('was-owner@example.test')
const stranger = startFor('stranger@example.test')
if (projectStart.status !== 403 || projectStart.body.passphrase_wrap) fail('16', 'project reclaim/start was not 403 without wrap')
if (teamStart.status !== 403 || teamStart.body.passphrase_wrap) fail('16', 'team reclaim/start was not 403 without wrap')
if (revokedOwner.status !== 403 || revokedOwner.body.passphrase_wrap) fail('16', 'revoked owner reclaim/start was not 403 without wrap')
if (stranger.status !== 403 || stranger.body.passphrase_wrap) fail('16', 'stranger reclaim/start was not 403 without wrap')

const ownerMint = session.requestMediaEmailCode('owner@example.test')
const ownerStart = session.mediaReclaimStart({
  email: 'owner@example.test',
  code: String(ownerMint.code || ''),
  devicePublicKey: dPub,
  mediaBrainId: brainId
})
reclaimBodies.push(ownerStart.body)
if (ownerStart.status !== 200) fail('16', 'owner reclaim/start was ' + ownerStart.status)
if (!ownerStart.body.salt || !ownerStart.body.challenge || !ownerStart.body.token) fail('16', 'reclaim/start missing salt, challenge, or token')
if (ownerStart.body.passphrase_wrap == null || ownerStart.body.recovery_wrap == null) fail('16', 'reclaim/start missing wraps')
const { reclaimStartHasSecrets } = await import('../src/main/media/worker-shapes.ts')
if (reclaimStartHasSecrets(ownerStart.body)) fail('16', 'reclaim/start body leaked a secret')
if (/\bpbt_|\bpms_/.test(JSON.stringify(ownerStart.body))) fail('16', 'reclaim/start named a builder token')
steps['16'] = {
  projectStart: projectStart.status,
  teamStart: teamStart.status,
  revokedOwner: revokedOwner.status,
  stranger: stranger.status
}

const brainKeyNow = keys.unwrapBrainKeyWithPassphrase({
  wrap: {
    salt: Buffer.from(String(ownerStart.body.salt), 'hex'),
    N: keys.SCRYPT_N,
    r: keys.SCRYPT_R,
    p: keys.SCRYPT_P,
    wrap: Buffer.from(String(ownerStart.body.passphrase_wrap), 'hex'),
    proofPublicKey: Buffer.alloc(32)
  },
  passphrase: String(pass1),
  mediaBrainId: brainId
})
const wrapBefore17 = session.wrapSnapshot(folder)
const brainSig = keys.signWithSeed(brainKeyNow, Buffer.from(String(ownerStart.body.challenge), 'hex'))
const badFinish = session.mediaReclaimFinish({
  token: String(ownerStart.body.token),
  signature: brainSig.toString('hex'),
  kind: 'brain',
  devicePublicKey: dPub
})
reclaimBodies.push(badFinish.body)
if (badFinish.status !== 403) fail('17', 'brain-key reclaim/finish was ' + badFinish.status)
const afterBad = session.mediaDumpStore()
if (afterBad.devices.some((d) => d.public_key === dPub && d.status === 'approved')) {
  fail('17', 'brain-key finish wrote a device row')
}
const wrapAfter17 = session.wrapSnapshot(folder)
if (!wrapBefore17 || !wrapAfter17 || wrapAfter17.passphrase !== wrapBefore17.passphrase) {
  fail('17', 'passphrase wrap bytes changed on a refused finish')
}
const reuse = session.mediaReclaimFinish({
  token: String(ownerStart.body.token),
  signature: brainSig.toString('hex'),
  devicePublicKey: dPub
})
reclaimBodies.push(reuse.body)
if (reuse.status !== 403) fail('17', 'token reuse was ' + reuse.status)
steps['17'] = { brainKeySignature: 403, tokenReuse: 403 }

asDevice(userDataD)
const reclaimedD = session.reclaimOnThisMac({
  folder,
  email: 'owner@example.test',
  code: String(session.requestMediaEmailCode('owner@example.test').code || ''),
  passphrase: String(pass1)
})
if (!reclaimedD.ok) fail('18', 'passphrase reclaim/finish failed: ' + reclaimedD.detail)
session.runMediaCheckIn(folder)
const playedD = play.playMedia({ folder, mediaId })
if (createHash('sha256').update(playedD.bytes).digest('hex') !== plaintextSha256) {
  fail('18', 'D did not play the alpha file')
}
const passAgain = await invoke('media:takePassphrase', folder)
const recAgain = await invoke('media:takeRecoveryKey', folder)
if (passAgain != null || recAgain != null) fail('18', 'one-shot returned a secret after step 2')
for (const file of [...walkFiles(folder), ...walkFiles(userDataD)]) {
  const buf = readFileSync(file)
  if (containsSecret(buf, String(pass1)) || containsSecret(buf, String(rec1))) {
    fail('18', 'fixture or userData held the passphrase or recovery key in ' + file)
  }
}
const dSeatPath = join(userDataD, 'media', 'seats.json')
if (existsSync(dSeatPath) && /pms_[0-9a-f]{20,}/.test(readFileSync(dSeatPath, 'utf8'))) {
  fail('18', 'pms_ token was stored in plaintext')
}
steps['18'] = { finishPlays: true }

const emailOnly = session.mediaWrapPassphrase({
  folder,
  email: 'owner@example.test',
  code: String(session.requestMediaEmailCode('owner@example.test').code || '')
})
if (emailOnly.status !== 403) fail('19', 'wrap/passphrase with only an email code was ' + emailOnly.status)
const pass19 = 'new pass phrase 19x'
const recReplace = session.mediaWrapPassphrase({
  folder,
  recovery: String(rec1),
  passphrase: pass19
})
if (recReplace.status !== 200) fail('19', 'recovery wrap/passphrase failed')
let oldPassOpens = true
try {
  keys.unwrapBrainKeyWithPassphrase({
    wrap: {
      salt: Buffer.from(session.wrapSnapshot(folder)!.passphrase === wrapAfter17.passphrase ? ownerStart.body.salt as string : session.mediaDumpStore().brains[0].passphrase_salt, 'hex'),
      N: keys.SCRYPT_N,
      r: keys.SCRYPT_R,
      p: keys.SCRYPT_P,
      wrap: Buffer.from(session.mediaDumpStore().brains[0].passphrase_wrap, 'hex'),
      proofPublicKey: Buffer.from(session.mediaDumpStore().brains[0].passphrase_proof, 'hex')
    },
    passphrase: String(pass1),
    mediaBrainId: brainId
  })
} catch {
  oldPassOpens = false
}
if (oldPassOpens) fail('19', 'old passphrase still unwraps')
keys.unwrapBrainKeyWithPassphrase({
  wrap: {
    salt: Buffer.from(session.mediaDumpStore().brains[0].passphrase_salt, 'hex'),
    N: keys.SCRYPT_N,
    r: keys.SCRYPT_R,
    p: keys.SCRYPT_P,
    wrap: Buffer.from(session.mediaDumpStore().brains[0].passphrase_wrap, 'hex'),
    proofPublicKey: Buffer.from(session.mediaDumpStore().brains[0].passphrase_proof, 'hex')
  },
  passphrase: pass19,
  mediaBrainId: brainId
})
keys.unwrapBrainKeyWithRecovery({
  wrap: {
    wrap: Buffer.from(session.mediaDumpStore().brains[0].recovery_wrap, 'hex'),
    proofPublicKey: Buffer.from(session.mediaDumpStore().brains[0].recovery_proof, 'hex')
  },
  recoveryKey: keys.parseRecoveryKey(String(rec1)),
  mediaBrainId: brainId
})
if (session.mediaDumpStore().brains[0].brain_key_version !== wrapBefore17.brainVersion) {
  fail('19', 'wrap/passphrase rotated the brain key')
}
steps['19'] = { emailCannotReplaceWrap: true, recoveryCanReplacePassphrase: true }

const wrapBeforeStolen = session.wrapSnapshot(folder)
asDevice(userDataD)
const enrolledE = session.enrollFullBrainMac({
  folder,
  email: 'owner@example.test',
  deviceUserData: userDataE
})
asDevice(userDataE)
session.runMediaCheckIn(folder)
const eWrap = wrapsFile.readWrapsFile(userDataE, brainId).find((w) => w.scope === 'brain')
if (!eWrap) fail('20', 'E has no brain wrap')
const eKey = deviceKey.ensureDeviceKey(userDataE, brainId, {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => seal(plain),
  decryptString: (buf: Buffer) => unseal(buf)
})
const brainKeyE = keys.unwrapKeyFromDevice({
  wrap: {
    ephPub: Buffer.from(eWrap.eph_pub, 'hex'),
    nonce: Buffer.from(eWrap.nonce, 'hex'),
    ciphertext: Buffer.from(eWrap.ciphertext, 'hex')
  },
  devicePrivateKey: eKey.privateKey,
  mediaBrainId: brainId,
  scope: 'brain',
  version: session.mediaDumpStore().brains[0].brain_key_version
})
const rowNow = session.mediaDumpStore().brains[0]
const stolenRotate = session.mediaRotateWithProof({
  folder,
  signature: keys.signWithSeed(brainKeyE, session.signedPayload('rotate', rowNow)).toString('hex')
})
const stolenWrap = session.mediaWrapPassphrase({
  folder,
  signature: keys.signWithSeed(brainKeyE, session.signedPayload('wrap-passphrase', rowNow)).toString('hex'),
  kind: 'brain'
})
const stolenRevoke = session.revokeMediaDevice({
  folder,
  deviceId: reclaimedD.fingerprint,
  signature: keys.signWithSeed(brainKeyE, session.signedPayload('revoke', rowNow, reclaimedD.fingerprint)).toString('hex')
})
if (stolenRotate.status !== 403) fail('20', 'stolen rotate was ' + stolenRotate.status)
if (stolenWrap.status !== 403) fail('20', 'stolen wrap replace was ' + stolenWrap.status)
if (stolenRevoke.kind !== 'blocked') fail('20', 'stolen revoke was not blocked')
const wrapAfterStolen = session.wrapSnapshot(folder)
if (!wrapBeforeStolen || !wrapAfterStolen || wrapAfterStolen.passphrase !== wrapBeforeStolen.passphrase) {
  fail('20', 'stolen ops changed wrap bytes')
}
const eMint = session.requestMediaEmailCode('owner@example.test')
const eStart = session.mediaReclaimStart({
  email: 'owner@example.test',
  code: String(eMint.code || ''),
  devicePublicKey: eKey.publicKey.toString('hex'),
  mediaBrainId: brainId
})
reclaimBodies.push(eStart.body)
const eFinish = session.mediaReclaimFinish({
  token: String(eStart.body.token || ''),
  signature: keys.signWithSeed(brainKeyE, Buffer.from(String(eStart.body.challenge || ''), 'hex')).toString('hex'),
  devicePublicKey: eKey.publicKey.toString('hex')
})
reclaimBodies.push(eFinish.body)
if (eFinish.status !== 403) fail('20', 'reclaim token plus brain-key signature was ' + eFinish.status)
steps['20'] = { stolenRotate: 403 }

const aFp = enabled.fingerprint
const aWrapsCopy = wrapsFile.readWrapsFile(userData, brainId)
const aKeyCopy = join(userData, 'media', brainId, 'device.key')
const aKeySaved = existsSync(aKeyCopy) ? readFileSync(aKeyCopy) : Buffer.alloc(0)
asDevice(userDataD)
const wrapBefore21 = session.wrapSnapshot(folder)
const removed = session.revokeMediaDevice({ folder, deviceId: aFp, passphrase: pass19, proof: true })
if (removed.kind !== 'wiped') fail('21', 'removing A did not prove-rotate')
const wrapAfter21 = session.wrapSnapshot(folder)
if (!wrapBefore21 || !wrapAfter21 || wrapAfter21.brainVersion <= wrapBefore21.brainVersion) {
  fail('21', 'brain key version did not increment')
}
keys.unwrapBrainKeyWithPassphrase({
  wrap: {
    salt: Buffer.from(session.mediaDumpStore().brains[0].passphrase_salt, 'hex'),
    N: keys.SCRYPT_N,
    r: keys.SCRYPT_R,
    p: keys.SCRYPT_P,
    wrap: Buffer.from(session.mediaDumpStore().brains[0].passphrase_wrap, 'hex'),
    proofPublicKey: Buffer.from(session.mediaDumpStore().brains[0].passphrase_proof, 'hex')
  },
  passphrase: pass19,
  mediaBrainId: brainId
})
session.runMediaCheckIn(folder)
const playedD2 = play.playMedia({ folder, mediaId })
if (createHash('sha256').update(playedD2.bytes).digest('hex') !== plaintextSha256) fail('21', 'D could not play after rotation')
asDevice(userDataF)
session.runMediaCheckIn(folder)
const playedF2 = play.playMedia({ folder, mediaId })
if (createHash('sha256').update(playedF2.bytes).digest('hex') !== plaintextSha256) fail('21', 'F could not play after rotation')
asOwner()
const aState = session.runMediaCheckIn(folder)
if (aState.status !== 410 || !aState.wiped) fail('21', 'A state was not 410 wipe')
if (existsSync(join(userData, 'media', brainId))) fail('21', 'A media folder remained after 410')
const recOld = keys.parseRecoveryKey(String(rec1))
const newRow = session.mediaDumpStore().brains[0]
let oldRecOpens = true
try {
  keys.unwrapBrainKeyWithRecovery({
    wrap: { wrap: Buffer.from(newRow.recovery_wrap, 'hex'), proofPublicKey: Buffer.from(newRow.recovery_proof, 'hex') },
    recoveryKey: recOld,
    mediaBrainId: brainId
  })
} catch {
  oldRecOpens = false
}
if (oldRecOpens) fail('21', 'old recovery still unwraps')
const recNew = session.takeRecoveryKey(folder)
if (typeof recNew !== 'string' || !recNew.startsWith('RK1-')) fail('21', 'new recovery key was not shown once')
if (session.takeRecoveryKey(folder) != null) fail('21', 'new recovery key was shown twice')
const finishOldRec = session.mediaReclaimFinish({
  token: 'mrc_dead',
  signature: keys.signWithProof(recOld, keys.RECOVERY_INFO(brainId), Buffer.from('abcd', 'hex')).toString('hex'),
  devicePublicKey: dPub
})
if (finishOldRec.status !== 403) fail('21', 'old recovery signed finish')
const wrapOldRec = session.mediaWrapPassphrase({
  folder,
  signature: keys.signWithProof(recOld, keys.RECOVERY_INFO(brainId), session.signedPayload('wrap-passphrase', newRow)).toString('hex')
})
if (wrapOldRec.status !== 403) fail('21', 'old recovery signed wrap replace')
const rotOldRec = session.mediaRotateWithProof({
  folder,
  signature: keys.signWithProof(recOld, keys.RECOVERY_INFO(brainId), session.signedPayload('rotate', newRow)).toString('hex')
})
if (rotOldRec.status !== 403) fail('21', 'old recovery signed rotate')
const aBrainWrap = aWrapsCopy.find((w) => w.scope === 'brain')
let oldBrainKeyFails = true
if (aBrainWrap && aKeySaved.length) {
  try {
    const aPriv = deviceKey.unsealDevicePrivate(aKeySaved, {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => seal(plain),
      decryptString: (buf: Buffer) => unseal(buf)
    })
    const oldBk = keys.unwrapKeyFromDevice({
      wrap: {
        ephPub: Buffer.from(aBrainWrap.eph_pub, 'hex'),
        nonce: Buffer.from(aBrainWrap.nonce, 'hex'),
        ciphertext: Buffer.from(aBrainWrap.ciphertext, 'hex')
      },
      devicePrivateKey: aPriv,
      mediaBrainId: brainId,
      scope: 'brain',
      version: wrapBefore21.brainVersion
    })
    const newScope = session.mediaDumpStore().scopes.find((s) => s.media_brain_id === brainId)
    const newObj = session.mediaDumpStore().objects.find((o) => o.id === mediaId)
    if (newScope && newObj) {
      keys.unwrapDek({
        wrap: Buffer.from(newObj.dek_wrap, 'hex'),
        projectKey: oldBk,
        mediaId: newObj.id,
        scopeId: newScope.id,
        keyVersion: newObj.dek_version
      })
      oldBrainKeyFails = false
    }
  } catch {
    oldBrainKeyFails = true
  }
}
if (!oldBrainKeyFails) fail('21', 'old brain key unwrapped the new project DEK')
asDevice(userDataE)
session.runMediaCheckIn(folder)
const newBrainVersion = session.mediaDumpStore().brains[0].brain_key_version
const eWrap2 = wrapsFile.readWrapsFile(userDataE, brainId).find(
  (w) => w.scope === 'brain' && w.key_version === newBrainVersion
)
if (!eWrap2) fail('21', 'E did not receive a new brain wrap')
const brainKeyE2 = keys.unwrapKeyFromDevice({
  wrap: {
    ephPub: Buffer.from(eWrap2.eph_pub, 'hex'),
    nonce: Buffer.from(eWrap2.nonce, 'hex'),
    ciphertext: Buffer.from(eWrap2.ciphertext, 'hex')
  },
  devicePrivateKey: eKey.privateKey,
  mediaBrainId: brainId,
  scope: 'brain',
  version: newBrainVersion
})
const stolenAfter = session.mediaRotateWithProof({
  folder,
  signature: keys.signWithSeed(brainKeyE2, session.signedPayload('rotate', session.mediaDumpStore().brains[0])).toString('hex')
})
if (stolenAfter.status !== 403) fail('21', 'E signed rotate with the new brain key')
steps['21'] = {
  deksRewrapped: true,
  fStillPlays: true,
  dStillPlays: true,
  oldRecoveryCannotSign: true,
  oldBrainKeyFails: true
}

asOwner()
const wrapBefore22 = session.wrapSnapshot(folder)
const redeemed = session.redeemOwnerEmailCode({ email: 'owner@example.test', folder })
if (redeemed.kind !== 'pbt_') fail('22', 'owner email code did not redeem a pbt_ token')
session.afterPlyntrSeatRevoke('brain-owner', 'brain-owner')
const wrapAfter22 = session.wrapSnapshot(folder)
if (!wrapBefore22 || !wrapAfter22) fail('22', 'missing wrap snapshot')
if (wrapAfter22.passphrase !== wrapBefore22.passphrase || wrapAfter22.recovery !== wrapBefore22.recovery) {
  fail('22', 'seat revoke without proof changed wrap bytes')
}
if (wrapAfter22.brainVersion !== wrapBefore22.brainVersion) fail('22', 'seat revoke without proof changed the brain key version')
const rotatePending = session.attemptRotateScope(folder)
if (rotatePending.status !== 423) fail('22', 'rotate-scope was ' + rotatePending.status)
let uploadPending: { ok?: boolean; status?: number } = { ok: true }
try {
  uploadPending = (await invoke('media:add', { folder, root: 'projects/alpha/', path: filePath })) as {
    ok?: boolean
    status?: number
  }
} catch (err) {
  const msg = String((err as Error).message || err)
  if (!msg.includes(grants.FINISH_REMOVE) && !/423/.test(msg)) fail('22', 'upload error was ' + msg)
  uploadPending = { ok: false, status: 423 }
}
if (uploadPending.ok || uploadPending.status !== 423) {
  if (uploadPending.status !== 423) fail('22', 'upload without proof was ' + JSON.stringify(uploadPending))
}
asDevice(userDataD)
const dState = session.runMediaCheckIn(folder)
if (dState.status !== 401) fail('22', 'D state after unproven seat revoke was ' + dState.status)
if (dState.wiped) fail('22', 'unproven seat revoke wiped a media folder')
if (!existsSync(join(userDataD, 'media', brainId))) fail('22', 'D media folder was wiped')
const blockedCopy = grants.finishRemoveCopy('owner@example.test')
if (!blockedCopy.includes('Type your passphrase to finish removing')) {
  fail('22', 'missing finish-remove copy')
}
steps['22'] = {
  seatRevokeWithoutProof: {
    blocked: true,
    wrapBytesSame: true,
    brainVersionSame: true,
    rotateScope: 423,
    wiped: false
  }
}

for (const body of reclaimBodies) {
  const raw = JSON.stringify(body)
  if (containsSecret(Buffer.from(raw), String(pass1)) || containsSecret(Buffer.from(raw), String(rec1))) {
    fail('16', 'reclaim response contained the passphrase or recovery key')
  }
  if (containsSecret(Buffer.from(raw), brainKeyNow) || containsSecret(Buffer.from(raw), recRaw)) {
    fail('16', 'reclaim response contained a raw key')
  }
  if (reclaimStartHasSecrets(body)) fail('16', 'a reclaim response leaked a private key or token')
}

for (const s of SLICE6_OWN) {
  if (!(s in steps)) fail(s, 'slice 6 must claim this step')
}

const reclaim = {
  projectStart: 403,
  teamStart: 403,
  revokedOwner: 403,
  stranger: 403,
  brainKeySignature: 403,
  tokenReuse: 403,
  finishPlays: true,
  emailCannotReplaceWrap: true,
  recoveryCanReplacePassphrase: true,
  deksRewrapped: true,
  fStillPlays: true,
  dStillPlays: true,
  oldRecoveryCannotSign: true,
  oldBrainKeyFails: true,
  stolenRotate: 403,
  seatRevokeWithoutProof: {
    blocked: true,
    wrapBytesSame: true,
    brainVersionSame: true,
    rotateScope: 423,
    wiped: false
  }
}

const artifact = {
  pass: true,
  steps,
  objectSha256,
  plaintextSha256,
  markerInObject: false,
  pointerPath: added.rel,
  pointerKeys,
  seatB: seatBResult,
  seatC: seatCResult,
  recoveryShownOnce: true,
  passphraseShownOnce: true,
  bareKeysInStore: false,
  bareKeysOnDisk: false,
  dekWrapAloneDecrypts: false,
  reclaim,
  tamper: { flipped: 'refused', truncated: 'refused' },
  cap: { before: 409, over: 413, raced: 1 },
  revoke: { state: 410, wiped: true, rotated: true, oldWrapFails: true, downloadRefused: true },
  forkButtons: 3,
  watcherDelta: 0,
  rendererChecks,
  network: 0,
  playA
}
writeArtifact(artifact)
console.log('MEDIA_PASS')
