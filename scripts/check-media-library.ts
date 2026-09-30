// Stored-file library check. Dry-run through the media IPC, the same harness as scripts/check-media.ts,
// plus one live case where GET /v1/media/objects is 404 while /v1/media/health is up.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { createRequire, registerHooks } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const onHandlers = globalThis.__ipcOn ||= new Map()
export const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => onHandlers.set(name, fn), removeHandler(name) { handlers.delete(name) } }
export const app = { getFileIcon: async () => ({}), getPath: () => globalThis.__userData, getAppPath: () => globalThis.__appPath, getVersion: () => '0.0.0', getName: () => 'Brain', isPackaged: false, on() {}, whenReady: () => Promise.resolve() }
export const BrowserWindow = { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) }
export const shell = { openPath: async () => '' }
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
export const protocol = { registerSchemesAsPrivileged() {}, handle() {} }
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
g.__userData = mkdtempSync(join(tmpdir(), 'media-lib-boot-'))
g.__seal = seal
g.__unseal = unseal

const mediaCalls: string[] = []
g.fetch = (async (input: string | URL) => {
  const url = String(input)
  mediaCalls.push(url)
  throw new Error('check-media-library forbids network: ' + url)
}) as typeof fetch

const req = createRequire(join(rootRepo, 'package.json'))
const boom = () => {
  throw new Error('check-media-library forbids sockets')
}
req('node:net').connect = boom
req('node:tls').connect = boom
req('node:https').request = boom

function fail(step: string, why: string): never {
  console.error(`MEDIA_LIBRARY_FAIL ${step}: ${why}`)
  process.exit(1)
}

const vault = await import('../src/main/shell-vault.ts')
const brainsMod = await import('../src/main/brains.ts')
const ipc = await import('../src/main/media/ipc.ts')
const session = await import('../src/main/media/session.ts')
const storeMod = await import('../src/main/media/store.ts')
const pointer = await import('../src/main/media/pointer.ts')
const safe = await import('../src/main/media/renderer-safe.ts')
const hmacSeat = await import('../src/main/media/hmac-seat.ts')
const { MEDIA_LIBRARY_NOT_YET } = await import('../src/shared/media.ts')

type Row = { id: string; title: string; mime: string; bytes: number; createdAt: string; root: string }
type Lib = { ok: true; files: Row[] } | { ok: false; detail: string }

const FORBIDDEN = new Set([
  'dekWrap',
  'dek_wrap',
  'objectKey',
  'object_key',
  'createdByEmail',
  'created_by_email',
  'uploadId',
  'upload_id',
  'url',
  'token',
  'email'
])

function badKeys(value: unknown, path = '$', out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => badKeys(v, `${path}[${i}]`, out))
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN.has(k) || k.toLowerCase().includes('wrap')) out.push(`${path}.${k}`)
      badKeys(v, `${path}.${k}`, out)
    }
  }
  return out
}

async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  const fn = g.__ipc.get(name)
  if (!fn) fail('ipc', 'missing handler ' + name)
  const out = await fn({}, ...args)
  if (!['media:takePassphrase', 'media:takeRecoveryKey'].includes(name)) {
    try {
      safe.assertRendererSafe(out)
    } catch (err) {
      fail('ipc', name + ' failed assertRendererSafe: ' + String((err as Error).message || err))
    }
  }
  return out
}

async function library(folder: string, step: string): Promise<Row[]> {
  const out = (await invoke('media:library', { folder })) as Lib
  const bad = badKeys(out)
  if (bad.length) fail(step, 'library payload leaked ' + bad.join(', '))
  if (!out.ok) fail(step, 'library failed: ' + out.detail)
  for (const row of out.files) {
    const keys = Object.keys(row).sort().join(',')
    if (keys !== 'bytes,createdAt,id,mime,root,title') fail(step, 'library row has keys ' + keys)
  }
  return out.files
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkFiles(p, out)
    else out.push(p)
  }
  return out
}

function notesUnder(folder: string): string[] {
  return walkFiles(folder).filter((p) => p.endsWith('.media.md'))
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
  brainsMod.rememberBrain({ path: folder, name: 'Alpha', slug: 'alpha', role: 'owner', syncMode: 'local', brainId })
  brainsMod.switchBrain(folder)
}

/** Balanced-paren slice starting at `open` (the index of a '('). */
function parenBody(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return src.slice(open)
}

function functionBody(src: string, header: string): { start: number; body: string } {
  const start = src.indexOf(header)
  if (start < 0) return { start: -1, body: '' }
  const end = src.indexOf('\n}\n', start)
  return { start, body: src.slice(start, end < 0 ? src.length : end + 2) }
}

ipc.registerMediaIpc()

// --- 1: owner with storage on, two files through media:add ---
const userData = mkdtempSync(join(tmpdir(), 'media-lib-owner-'))
const folder = mkdtempSync(join(tmpdir(), 'media-lib-brain-'))
setupFolder(userData, folder, 'brain-library')
const enabled = (await invoke('media:enable', { folder })) as { ok: boolean }
if (!enabled?.ok) fail('1', 'enable failed')
await invoke('media:takePassphrase', folder)
await invoke('media:takeRecoveryKey', folder)
await invoke('media:setCap', { folder, capBytes: 50 * 1024 * 1024 })
const bucket = (await invoke('media:turnOnBucket', folder)) as { ok: boolean }
if (!bucket?.ok) fail('1', 'bucket did not turn on')

const uploads = mkdtempSync(join(tmpdir(), 'media-lib-files-'))
const frontPath = join(uploads, 'front.png')
const sidePath = join(uploads, 'side.mp4')
writeFileSync(frontPath, Buffer.alloc(3000, 1))
writeFileSync(sidePath, Buffer.alloc(70 * 1024, 2))
const addFront = (await invoke('media:add', { folder, root: 'projects/alpha/', path: frontPath })) as { ok: boolean }
const addSide = (await invoke('media:add', { folder, root: 'projects/beta/', path: sidePath })) as { ok: boolean }
if (!addFront.ok || !addSide.ok) fail('1', 'media:add failed ' + JSON.stringify({ addFront, addSide }))
const mem = storeMod.memoryMediaStore(userData)
const frontObj = mem.objects.find((o) => o.title === 'front')
const sideObj = mem.objects.find((o) => o.title === 'side')
if (!frontObj || !sideObj) fail('1', 'dry rows did not store title front and side')
for (const o of [frontObj, sideObj]) {
  if (!o.created_at || Number.isNaN(Date.parse(o.created_at)) || new Date(o.created_at).toISOString() !== o.created_at) {
    fail('1', 'dry row created_at is not an ISO string: ' + o.created_at)
  }
}

// --- 2: delete every note; the list still comes from the storage rows ---
const notes = notesUnder(folder)
if (notes.length !== 2) fail('2', 'expected two notes, found ' + notes.length)
for (const n of notes) rmSync(n)
if (notesUnder(folder).length) fail('2', 'notes still on disk')
const cacheBefore = walkFiles(userData).length
const callsBefore = mediaCalls.length
const owned = await library(folder, '2')
if (walkFiles(userData).length !== cacheBefore) fail('2', 'media:library wrote a file (a download or cache fill ran)')
if (mediaCalls.length !== callsBefore) fail('2', 'dry media:library touched the network')
const front = owned.find((r) => r.id === frontObj.id)
const side = owned.find((r) => r.id === sideObj.id)
if (!front || !side) fail('2', 'owner list is missing a file after the notes were deleted')
if (front.title !== 'front' || side.title !== 'side') fail('2', 'names did not survive deleting notes')
if (!front.mime.startsWith('image/') || !side.mime.startsWith('video/')) fail('2', 'mime wrong: ' + front.mime + ' ' + side.mime)
if (front.bytes !== 3000 || side.bytes !== 70 * 1024) fail('2', 'byte sizes wrong')
if (front.createdAt !== frontObj.created_at || side.createdAt !== sideObj.created_at) fail('2', 'date is not the stored created_at')
if (front.root !== 'projects/alpha/' || side.root !== 'projects/beta/') fail('2', 'folder root wrong')

// --- 3: uploading and deleted rows are left out ---
const planted = [
  { ...frontObj, id: randomUUID(), status: 'uploading' as const, title: 'halfway' },
  { ...frontObj, id: randomUUID(), status: 'deleted' as const, title: 'gone' }
]
mem.objects.push(...planted)
const afterPlant = await library(folder, '3')
if (afterPlant.some((r) => planted.some((p) => p.id === r.id))) fail('3', 'uploading or deleted row is in the owner list')
if (afterPlant.length !== 2) fail('3', 'owner list should hold exactly the two ready files')

// --- 4: a project hmac seat sees only its roots ---
const seat = session.mintProjectMediaSeat({ folder, email: 'alpha-person@example.test', roots: ['projects/alpha/'] })
const userDataP = mkdtempSync(join(tmpdir(), 'media-lib-project-'))
session.mediaDropKeys()
g.__userData = userDataP
vault.useRoot(userDataP)
hmacSeat.writeHmacSeat(userDataP, {
  token: seat.token,
  email: 'alpha-person@example.test',
  roots: ['projects/alpha/'],
  hq_repo: 'plyntr/alpha-brain',
  seat_id: seat.seat_id
})
const projectRows = await library(folder, '4')
if (!projectRows.some((r) => r.id === frontObj.id)) fail('4', 'project seat did not see front')
if (projectRows.some((r) => r.id === sideObj.id)) fail('4', 'project seat saw side in another folder')
session.mediaDropKeys()
g.__userData = userData
vault.useRoot(userData)
vault.signInEmailOnly('owner@example.test')

// --- 5: an empty stored name fills from a note once and is never replaced ---
const added = new Date().toISOString().slice(0, 10)
frontObj.title = ''
const frontNote = pointer.writePointer({
  folder,
  root: 'projects/alpha/',
  fields: { brain_media: 1, media_id: frontObj.id, title: 'front', mime: frontObj.mime, bytes: frontObj.bytes, added }
})
const filled = await library(folder, '5')
if (filled.find((r) => r.id === frontObj.id)?.title !== 'front') fail('5', 'empty name was not filled from the note')
if (frontObj.title !== 'front') fail('5', 'fill did not reach the storage row')
rmSync(frontNote.path)
pointer.writePointer({
  folder,
  root: 'projects/alpha/',
  fields: { brain_media: 1, media_id: frontObj.id, title: 'side', mime: frontObj.mime, bytes: frontObj.bytes, added }
})
const kept = await library(folder, '5')
if (kept.find((r) => r.id === frontObj.id)?.title !== 'front') fail('5', 'a stored name was replaced by a rewritten note')
if (frontObj.title !== 'front') fail('5', 'storage row name changed')
for (const n of notesUnder(folder)) rmSync(n)
const noNote = await library(folder, '5')
if (noNote.find((r) => r.id === frontObj.id)?.title !== 'front') fail('5', 'a missing note cleared a stored name')

// --- 6: newline and key-like names are refused on upload and on fill ---
const BAD = ['bad\nname', 'pms_abc123']
for (const t of BAD) if (pointer.cleanMediaTitle(t) !== null) fail('6', 'cleanMediaTitle kept ' + JSON.stringify(t))
if (pointer.cleanMediaTitle('  front  ') !== 'front') fail('6', 'cleanMediaTitle did not trim')
if (pointer.cleanMediaTitle('a'.repeat(20) + ' ' + 'b'.repeat(220)) !== null) fail('6', 'a 241-character name was kept')
const rowsBefore = mem.objects.length
for (const t of BAD) {
  const p = join(uploads, `${t}.png`)
  writeFileSync(p, Buffer.alloc(1000, 3))
  const res = (await invoke('media:add', { folder, root: 'projects/alpha/', path: p })) as {
    ok: boolean
    error?: string
    detail?: string
  }
  if (res.ok || res.error !== 'bad_title') fail('6', 'upload named ' + JSON.stringify(t) + ' was not refused: ' + JSON.stringify(res))
  if (String(res.detail || '').includes(t)) fail('6', 'refusal echoed the name to the window')
}
if (mem.objects.length !== rowsBefore) fail('6', 'a refused upload stored a row')
if (notesUnder(folder).length) fail('6', 'a refused upload wrote a note')
sideObj.title = ''
const noteDir = join(folder, 'projects', 'beta', 'media')
mkdirSync(noteDir, { recursive: true })
const id8 = sideObj.id.replace(/-/g, '').slice(0, 8)
for (const [i, t] of BAD.entries()) {
  writeFileSync(
    join(noteDir, `bad-${i}--${id8}.media.md`),
    `---\nbrain_media: 1\nmedia_id: ${sideObj.id}\ntitle: ${t}\nmime: ${sideObj.mime}\nbytes: ${sideObj.bytes}\nadded: ${added}\n---\nx\n`
  )
}
const refusedFill = (await invoke('media:library', { folder })) as Lib
if (!refusedFill.ok) fail('6', 'library failed on a bad note')
const refusedText = JSON.stringify(refusedFill)
if (refusedText.includes('pms_') || refusedText.includes('bad\\nname')) fail('6', 'a refused name reached the window')
if (sideObj.title !== '') fail('6', 'a refused note name was stored: ' + JSON.stringify(sideObj.title))
if (mem.objects.some((o) => /[\r\n]|pms_/.test(String(o.title || '')))) fail('6', 'a refused name is on a storage row')
for (const n of notesUnder(folder)) rmSync(n)
sideObj.title = 'side'

// --- 7: the IPC payload, walked key by key ---
const walked = (await invoke('media:library', { folder })) as Lib
safe.assertRendererSafe(walked)
const leaked = badKeys(walked)
if (leaked.length) fail('7', 'library payload has ' + leaked.join(', '))
if (badKeys({ files: [{ object_key: 'o/x', created_by_email: 'a@b', dekWrap: 'w' }] }).length !== 3) {
  fail('7', 'the key walk misses nested keys')
}

// --- 8: nothing in the list path downloads or plays ---
const sessionSrc = readFileSync(join(rootRepo, 'src/main/media/session.ts'), 'utf8')
const libPath = ['function noteTitle', 'function libraryFile', 'function newestFirst', 'async function liveLibrary', 'export async function mediaLibrary']
  .map((h) => functionBody(sessionSrc, h))
if (libPath.some((b) => b.start < 0)) fail('8', 'library functions missing from session.ts')
for (const b of libPath) {
  for (const spy of ['prepareMediaPlay', 'mediaDownload', 'mediaLiveGet', 'playMedia', 'ensureObjectCached', 'ensureLiveObjectCached', 'writeCipherCache', '/download']) {
    if (b.body.includes(spy)) fail('8', 'library path calls ' + spy)
  }
}
const ipcSrc = readFileSync(join(rootRepo, 'src/main/media/ipc.ts'), 'utf8')
const libHandler = parenBody(ipcSrc, ipcSrc.indexOf("ipcMain.handle('media:library'") + "ipcMain.handle".length)
if (!libHandler.includes('mediaLibrary(') || /exportMedia|prepare|play|download/i.test(libHandler.replace(/mediaLibrary/g, ''))) {
  fail('8', 'media:library handler does more than list')
}

// --- 9: Settings See files, and the library pane ---
const panelSrc = readFileSync(join(rootRepo, 'src/renderer/src/MediaStoragePanel.tsx'), 'utf8')
const onStart = panelSrc.indexOf('<p>{MEDIA_ON}</p>')
const onEnd = panelSrc.indexOf('\n}\n', onStart)
const onBranch = onStart >= 0 ? panelSrc.slice(onStart, onEnd) : ''
if (!onBranch.includes('See files')) fail('9', 'storage-on branch has no See files')
if (!onBranch.includes('media.library')) fail('9', 'storage-on branch See files does not call media.library')
const usedLine = onBranch.indexOf('{mediaUsedLine(st)}')
if (usedLine < 0 || onBranch.indexOf('See files') < usedLine) fail('9', 'See files is not after the used-space line')
if (panelSrc.includes('setSt(null)')) fail('9', 'MediaStoragePanel can set status to null')
if (/routes\s*:\s*false/.test(panelSrc)) fail('9', 'MediaStoragePanel can set routes to false')
for (let i = panelSrc.indexOf('useEffect('); i >= 0; i = panelSrc.indexOf('useEffect(', i + 1)) {
  if (parenBody(panelSrc, i + 'useEffect'.length).includes('media.library')) fail('9', 'a useEffect in MediaStoragePanel calls media.library')
}
for (const src of [panelSrc]) {
  for (const bad of ['.media.md', 'parsePointer', 'files.read']) if (src.includes(bad)) fail('9', 'MediaStoragePanel reads ' + bad)
}
const paneSrc = readFileSync(join(rootRepo, 'src/renderer/src/MediaLibraryPane.tsx'), 'utf8')
for (const bad of ['.media.md', 'parsePointer', 'files.read']) if (paneSrc.includes(bad)) fail('9', 'library pane reads ' + bad)
if (!paneSrc.includes('window.brain.media.library(')) fail('9', 'library pane does not load the list itself')
const pic = functionBody(paneSrc, 'function LibraryPicture')
const guard = "if (!row.mime.startsWith('image/')) return null"
const guardAt = pic.start >= 0 ? pic.start + pic.body.indexOf(guard) : -1
if (pic.start < 0 || pic.body.indexOf(guard) < 0) fail('9', 'library pane has no image-only picture guard')
for (const token of ['brain-media://', '<img', '<video']) {
  for (let i = paneSrc.indexOf(token); i >= 0; i = paneSrc.indexOf(token, i + 1)) {
    if (i < guardAt || i > pic.start + pic.body.length) fail('9', `${token} in the library pane is outside the image-only branch`)
  }
}
const twSrc = readFileSync(join(rootRepo, 'src/renderer/src/TerminalWorkspace.tsx'), 'utf8')
if (!/type:\s*'chat' \| 'file' \| 'term' \| 'factory' \| 'library'/.test(twSrc)) fail('9', 'Tab.type has no library')
const openStored = functionBody(twSrc.replace(/\n  }\n/g, '\n}\n'), 'function openStored')
if (!openStored.body.includes("fileKind: 'media'") || !openStored.body.includes('mediaId: row.id')) {
  fail('9', 'opening a library row does not make a media file tab')
}
if (!twSrc.includes('<MediaLibraryPane') || !twSrc.includes("t.type === 'library'")) fail('9', 'library tab does not render the pane')
if (!twSrc.includes("t.fileKind === 'media' ? (\n                  <MediaFilePane")) fail('9', 'media file tab no longer uses MediaFilePane')
const settingsSrc = readFileSync(join(rootRepo, 'src/renderer/src/SettingsPanel.tsx'), 'utf8')
const firstRunSrc = readFileSync(join(rootRepo, 'src/renderer/src/FirstRun.tsx'), 'utf8')
if (!settingsSrc.includes('onSeeFiles={onSeeFiles}')) fail('9', 'SettingsPanel does not pass See files down')
if (!firstRunSrc.includes('onSeeFiles={') || !firstRunSrc.includes('libraryAsk={libraryAsk}')) fail('9', 'FirstRun does not thread See files to the workspace')

// --- 10: live, the list route 404s while health is up ---
{
  const prevDry = process.env.BRAIN_APP_DRY_RUN
  const prevFetch = g.fetch
  delete process.env.BRAIN_APP_DRY_RUN
  const liveUd = mkdtempSync(join(tmpdir(), 'media-lib-live-'))
  const keyless = mkdtempSync(join(tmpdir(), 'media-lib-keyless-'))
  const liveFolder = mkdtempSync(join(tmpdir(), 'media-lib-live-brain-'))
  const mediaBrainId = 'mb-live-library-01'
  setupFolder(liveUd, liveFolder, 'brain-live-library')
  writeFileSync(join(liveFolder, '.team-config', 'media.json'), JSON.stringify({ version: 1, mediaBrainId }) + '\n')
  const live: { method: string; path: string }[] = []
  g.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = String(init?.method || 'GET').toUpperCase()
    const path = new URL(url).pathname
    live.push({ method, path })
    if (path === '/v1/media/health') return new Response('{"ok":true}', { status: 200 })
    if (method === 'GET' && path === '/v1/media/objects') return new Response('{"error":"not found"}', { status: 404 })
    if (path === '/v1/media/state') {
      return new Response(
        JSON.stringify({ id: mediaBrainId, bucketStatus: 'on', capBytes: 1000, usedBytes: 0, brainKeyVersion: 1, wraps: [], scopes: [], devices: [] }),
        { status: 200 }
      )
    }
    throw new Error('check-media-library forbids network: ' + method + ' ' + url)
  }) as typeof fetch
  try {
    const st1 = (await invoke('media:status', keyless)) as { routes: boolean }
    if (!st1.routes) fail('10', 'media:status did not report routes before the library call')
    let lib: Lib
    try {
      lib = (await invoke('media:library', { folder: liveFolder })) as Lib
    } catch (err) {
      fail('10', 'media:library threw on 404: ' + String((err as Error).message || err))
    }
    if (!live.some((c) => c.method === 'GET' && c.path === '/v1/media/objects')) fail('10', 'media:library did not request /v1/media/objects')
    if (lib.ok || lib.detail !== MEDIA_LIBRARY_NOT_YET || lib.detail !== 'The file list is not available yet.') {
      fail('10', 'expected the not-available line, got ' + JSON.stringify(lib))
    }
    const st2 = (await invoke('media:status', keyless)) as { routes: boolean }
    if (!st2.routes) fail('10', 'a library 404 turned media routes off')
  } finally {
    if (prevDry === undefined) delete process.env.BRAIN_APP_DRY_RUN
    else process.env.BRAIN_APP_DRY_RUN = prevDry
    g.fetch = prevFetch
  }
}

console.log('MEDIA_LIBRARY_PASS')
process.exit(0)
