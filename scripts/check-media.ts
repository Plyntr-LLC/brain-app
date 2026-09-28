import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createRequire, registerHooks } from 'node:module'
import {
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
export const protocol = {}
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
const watcher = await import('../src/main/watcher-choice.ts')
const { shouldShowStorageAsk } = await import('../src/shared/media.ts')

async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  const fn = g.__ipc.get(name)
  if (!fn) fail('ipc', 'missing handler ' + name)
  return fn({}, ...args)
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
if (shouldShowStorageAsk({ role: 'team', joe: false, storageOn: false, mediaAsked: false, hasSeatToken: true, routes: true })) {
  fail('B', 'storage-ask would show for team')
}
if (shouldShowStorageAsk({ role: 'project', joe: false, storageOn: false, mediaAsked: false, hasSeatToken: true, routes: true })) {
  fail('B', 'storage-ask would show for project')
}
if (!shouldShowStorageAsk({ role: 'owner', joe: false, storageOn: false, mediaAsked: false, hasSeatToken: true, routes: true })) {
  fail('B', 'storage-ask would hide for owner')
}
if (shouldShowStorageAsk({ role: 'owner', joe: false, storageOn: false, mediaAsked: false, hasSeatToken: false, routes: true })) {
  fail('B', 'storage-ask would show without a seat token')
}
if (shouldShowStorageAsk({ role: 'owner', joe: true, storageOn: false, mediaAsked: false, hasSeatToken: false, routes: true })) {
  fail('B', 'storage-ask would show for keyless Joe')
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
    if (keyless) fail('B', 'storage-ask showed without a seat token when routes were live')
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

const enabled = (await invoke('media:enable', { folder })) as { ok: boolean; fingerprint: string }
if (!enabled?.ok) fail('2', 'enable failed')
const pass1 = await invoke('media:takePassphrase', folder)
const rec1 = await invoke('media:takeRecoveryKey', folder)
const pass2 = await invoke('media:takePassphrase', folder)
const rec2 = await invoke('media:takeRecoveryKey', folder)
if (typeof pass1 !== 'string' || !pass1.includes(' ')) fail('2', 'passphrase was not returned once')
if (typeof rec1 !== 'string' || !String(rec1).startsWith('RK1-')) fail('2', 'recovery key was not returned once')
if (pass2 != null || rec2 != null) fail('2', 'one-shot returned a secret twice')
rendererChecks.push('enable')
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
const obj = dumped.objects[0]
if (!obj) fail('12', 'no object row')
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

const artifact = {
  pass: true,
  steps,
  recoveryShownOnce: true,
  passphraseShownOnce: true,
  bareKeysInStore: false,
  bareKeysOnDisk: false,
  dekWrapAloneDecrypts: false,
  forkButtons: 3,
  watcherDelta: 0,
  rendererChecks,
  network: mediaCalls.length,
  cap: { before: 409 }
}
writeArtifact(artifact)
console.log('MEDIA_PASS')
