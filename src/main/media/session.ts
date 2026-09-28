import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, dialog, safeStorage } from 'electron'
import { canTurnOnGithubSync } from '../../shared/contracts.ts'
import {
  MEDIA_NEEDS_NET,
  MEDIA_NOT_APPROVED,
  MEDIA_OPEN_FAIL,
  MEDIA_REMOVED,
  MEDIA_WRONG_PROJECT,
  mediaUsedLine,
  shouldShowStorageAsk,
  type MediaAddResult,
  type MediaEnableResult,
  type MediaStatus
} from '../../shared/media.ts'
import { brainIdForFolder, seatForBrain, seatTokenForFolder } from '../plyntr-seats.ts'
import { getAccount, loadAccount } from '../session-token.ts'
import { getSettings } from '../settings-store.ts'
import { isJoeSuperAdmin } from '../super-admin.ts'
import { cachePath, cipherCacheExists, touchCipherCache, writeCipherCache } from './cache.ts'
import { assertMediaId, CHUNK_SIZE_DEFAULT, CHUNK_SIZE_MIN, newDek } from './crypto.ts'
import { ensureDeviceKey, type SafeStorageApi } from './device-key.ts'
import { dryObjectPath, enableDirectoryBucket, putDryObject } from './dry-worker.ts'
import { encryptMedia } from './format.ts'
import {
  createBrainKey,
  createRecoveryKey,
  createScopeKey,
  dropKeys,
  holdKey,
  takeKey,
  unwrapDek,
  unwrapKeyFromDevice,
  wrapBrainKeyWithPassphrase,
  wrapBrainKeyWithRecovery,
  wrapDek,
  wrapKeyToDevice,
  type DeviceKeyWrap
} from './keys.ts'
import { writePointer } from './pointer.ts'
import { readWrapsFile, upsertWrap } from './wraps-file.ts'
import { assertPassphrase, generatePassphrase } from './passphrase.ts'
import { isMediaDryRun } from './transport.ts'
import { dumpMemoryMediaStore, memoryMediaStore, type MediaBrainRow } from './store.ts'

export const NO_CAP = 'no_cap'
export const OVER_CAP = 'over_cap'
export const NO_SEAT = 'Sign in to this brain before turning on storage.'
export const NO_BUILDER = 'Only an owner or scout can turn on Plyntr storage.'
export const ASKED_FILE = 'media-asked.json'

const ORIGIN = 'https://brain-sync.joe-84a.workers.dev'

const shots = new Map<string, { passphrase?: string; recovery?: string }>()
const routesCache = new Map<string, boolean>()

export class MediaErr extends Error {
  status: number
  error: string
  constructor(status: number, error: string, detail: string) {
    super(detail)
    this.status = status
    this.error = error
  }
}

function userData(): string {
  return app.getPath('userData')
}

function safe(): SafeStorageApi {
  return safeStorage
}

function askedPath(): string {
  return join(userData(), ASKED_FILE)
}

function readAsked(): Record<string, boolean> {
  try {
    const raw = JSON.parse(readFileSync(askedPath(), 'utf8')) as { mediaAsked?: Record<string, boolean> }
    return raw.mediaAsked || {}
  } catch {
    return {}
  }
}

function writeAsked(next: Record<string, boolean>): void {
  mkdirSync(userData(), { recursive: true })
  writeFileSync(askedPath(), JSON.stringify({ mediaAsked: next }))
}

export function mediaAskedFor(folder: string): boolean {
  return Boolean(readAsked()[String(folder || '')])
}

export function markMediaAsked(folder: string): void {
  const path = String(folder || '')
  if (!path) return
  const cur = readAsked()
  cur[path] = true
  writeAsked(cur)
}

export function mediaChunkSize(): number {
  if (isMediaDryRun()) {
    const n = Number(process.env.BRAIN_MEDIA_CHUNK || 0)
    if (n) return n
  }
  return CHUNK_SIZE_DEFAULT
}

export function mediaPartSize(): number {
  if (isMediaDryRun()) {
    const n = Number(process.env.BRAIN_MEDIA_PART || 0)
    if (n) return n
  }
  return 16 * 4 * 1024 * 1024
}

export function mediaCutover(): number {
  if (isMediaDryRun()) {
    const n = Number(process.env.BRAIN_MEDIA_CUTOVER || 0)
    if (n) return n
  }
  return 64 * 1024 * 1024
}

function store() {
  return memoryMediaStore(userData())
}

function brainForFolder(folder: string): MediaBrainRow | undefined {
  return store().brains.find((b) => b.folder === folder && b.status === 'on')
}

function brainKeyId(id: string): string {
  return `brain:${id}`
}

function scopeKeyId(id: string): string {
  return `scope:${id}`
}

function wrapToHex(w: DeviceKeyWrap): { eph_pub: string; nonce: string; ciphertext: string } {
  return {
    eph_pub: w.ephPub.toString('hex'),
    nonce: w.nonce.toString('hex'),
    ciphertext: w.ciphertext.toString('hex')
  }
}

async function routesLive(): Promise<boolean> {
  if (isMediaDryRun()) return true
  const hit = routesCache.get(userData())
  if (hit != null) return hit
  try {
    const res = await fetch(`${ORIGIN}/v1/media/health`)
    const ok = res.status === 200
    routesCache.set(userData(), ok)
    return ok
  } catch {
    routesCache.set(userData(), false)
    return false
  }
}

function actor(folder: string): { email: string; role: string; joe: boolean; token: string; brainId: string } {
  const token = seatTokenForFolder(folder)
  const brainId = brainIdForFolder(folder)
  const seat = brainId ? seatForBrain(brainId) : null
  const acct = getAccount() || loadAccount()
  const joe = isJoeSuperAdmin(acct, getSettings())
  return {
    email: String(seat?.email || acct?.email || ''),
    role: String(seat?.role || ''),
    joe,
    token,
    brainId
  }
}

export function listMediaRoots(folder: string): { id: string; name: string; root: string }[] {
  const out: { id: string; name: string; root: string }[] = []
  for (const top of ['projects', 'clients']) {
    const dir = join(folder, top)
    if (!existsSync(dir)) continue
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue
        out.push({ id: e.name, name: e.name.replace(/-/g, ' '), root: `${top}/${e.name}/` })
      }
    } catch {
      /* */
    }
  }
  return out.sort((a, b) => a.root.localeCompare(b.root))
}

function mimeFor(path: string): string {
  const n = basename(path).toLowerCase()
  if (n.endsWith('.png')) return 'image/png'
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg'
  if (n.endsWith('.gif')) return 'image/gif'
  if (n.endsWith('.webp')) return 'image/webp'
  if (n.endsWith('.mov')) return 'video/quicktime'
  if (n.endsWith('.webm')) return 'video/webm'
  return 'video/mp4'
}

export async function mediaStatus(folder: string): Promise<MediaStatus> {
  const routes = await routesLive()
  const who = actor(folder)
  const row = brainForFolder(folder)
  const on = Boolean(row)
  let fingerprint = ''
  if (row) {
    try {
      fingerprint = ensureDeviceKey(userData(), row.id, safe()).fingerprint
    } catch {
      fingerprint = ''
    }
  }
  const waiting = on
    ? store()
        .devices.filter((d) => d.media_brain_id === row?.id && d.status === 'pending')
        .map((d) => ({
          deviceId: d.id,
          name: d.email.split('@')[0] || 'Mac',
          fingerprint: d.fingerprint,
          project: ''
        }))
    : []
  const base: MediaStatus = {
    routes,
    on,
    hasSeatToken: Boolean(who.token),
    fingerprint,
    usedBytes: row?.used_bytes || 0,
    capBytes: row ? row.cap_bytes : null,
    bucketStatus: row?.bucket_status || 'off',
    waiting: waiting.map((w) => ({
      deviceId: w.deviceId,
      name: w.name,
      fingerprint: w.fingerprint,
      project: w.project || 'brain'
    })),
    projects: listMediaRoots(folder),
    detail: ''
  }
  if (!routes) return base
  if (!on) {
    if (!who.token) base.detail = 'On this computer.'
    else if (canTurnOnGithubSync(who.role, who.joe)) base.detail = 'On this computer. Only this Mac has them.'
    else base.detail = 'On this computer. Your owner can turn on Plyntr storage.'
    return base
  }
  base.detail = mediaUsedLine(base)
  return base
}

export async function mediaShouldAsk(opts: { folder: string; role?: string }): Promise<boolean> {
  const folder = String(opts.folder || '')
  const st = await mediaStatus(folder)
  const who = actor(folder)
  return shouldShowStorageAsk({
    role: opts.role || who.role,
    joe: who.joe,
    storageOn: st.on,
    mediaAsked: mediaAskedFor(folder),
    hasSeatToken: st.hasSeatToken,
    routes: st.routes
  })
}

export function mediaSkip(folder: string): { ok: true } {
  markMediaAsked(folder)
  return { ok: true }
}

function slot(id: string): { passphrase?: string; recovery?: string } {
  let hit = shots.get(id)
  if (!hit) {
    hit = {}
    shots.set(id, hit)
  }
  return hit
}

export function takePassphrase(folder: string): string | null {
  const row = brainForFolder(folder)
  if (!row) return null
  const s = slot(row.id)
  const v = s.passphrase || null
  s.passphrase = undefined
  return v
}

export function takeRecoveryKey(folder: string): string | null {
  const row = brainForFolder(folder)
  if (!row) return null
  const s = slot(row.id)
  const v = s.recovery || null
  s.recovery = undefined
  return v
}

export async function mediaEnable(opts: { folder: string; passphrase?: string }): Promise<MediaEnableResult> {
  const folder = String(opts.folder || '')
  if (!isMediaDryRun()) throw new Error('Storage enable is dry-run only in this slice.')
  const who = actor(folder)
  if (!who.token) throw new Error(NO_SEAT)
  if (!canTurnOnGithubSync(who.role, who.joe)) throw new Error(NO_BUILDER)
  const existing = brainForFolder(folder)
  if (existing) {
    const st = await mediaStatus(folder)
    return { ok: true, fingerprint: st.fingerprint, detail: 'Plyntr storage is on.' }
  }
  const mediaBrainId = randomBytes(12).toString('hex')
  const live = ensureDeviceKey(userData(), mediaBrainId, safe())
  const brainKey = createBrainKey()
  holdKey(brainKeyId(mediaBrainId), brainKey)
  const phrase = opts.passphrase ? assertPassphrase(opts.passphrase) : generatePassphrase()
  const recovery = createRecoveryKey()
  const passWrap = wrapBrainKeyWithPassphrase({ brainKey, passphrase: phrase, mediaBrainId })
  const recWrap = wrapBrainKeyWithRecovery({ brainKey, recoveryKey: recovery.raw, mediaBrainId })
  const deviceWrap = wrapKeyToDevice({
    key: brainKey,
    devicePublicKey: live.publicKey,
    mediaBrainId,
    scope: 'brain',
    version: 1
  })
  const bucket = `bm-${mediaBrainId}`
  const mem = store()
  mem.brains.push({
    id: mediaBrainId,
    plyntr_brain_id: who.brainId || mediaBrainId,
    folder,
    bucket,
    bucket_status: 'off',
    cap_bytes: null,
    used_bytes: 0,
    reserved_bytes: 0,
    brain_key_version: 1,
    recovery_wrap: recWrap.wrap.toString('hex'),
    passphrase_wrap: passWrap.wrap.toString('hex'),
    passphrase_salt: passWrap.salt.toString('hex'),
    passphrase_proof: passWrap.proofPublicKey.toString('hex'),
    recovery_proof: recWrap.proofPublicKey.toString('hex'),
    created_by_email: who.email,
    status: 'on'
  })
  const packed = wrapToHex(deviceWrap)
  mem.wraps.push({
    id: randomUUID(),
    media_brain_id: mediaBrainId,
    scope: 'brain',
    key_version: 1,
    target: 'device',
    device_id: live.fingerprint,
    eph_pub: packed.eph_pub,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  })
  upsertWrap(userData(), mediaBrainId, {
    scope: 'brain',
    key_version: 1,
    eph_pub: packed.eph_pub,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  })
  mem.devices.push({
    id: live.fingerprint,
    media_brain_id: mediaBrainId,
    email: who.email,
    fingerprint: live.fingerprint,
    status: 'approved'
  })
  const held = slot(mediaBrainId)
  if (!opts.passphrase) held.passphrase = phrase
  held.recovery = recovery.display
  recovery.raw.fill(0)
  markMediaAsked(folder)
  return { ok: true, fingerprint: live.fingerprint, detail: 'Plyntr storage is on.' }
}

export function mediaSetPassphrase(opts: { folder: string; passphrase: string }): { ok: true } {
  const folder = String(opts.folder || '')
  const row = brainForFolder(folder)
  if (!row) throw new Error('Turn on storage first.')
  const pass = assertPassphrase(opts.passphrase)
  const brainKey = takeKey(brainKeyId(row.id))
  if (!brainKey) throw new Error('This Mac does not have the storage key in memory. Turn storage on again.')
  const wrap = wrapBrainKeyWithPassphrase({ brainKey, passphrase: pass, mediaBrainId: row.id })
  row.passphrase_wrap = wrap.wrap.toString('hex')
  row.passphrase_salt = wrap.salt.toString('hex')
  row.passphrase_proof = wrap.proofPublicKey.toString('hex')
  return { ok: true }
}

export function mediaSetCap(opts: { folder: string; capBytes: number }): { ok: true; capBytes: number } {
  const row = brainForFolder(String(opts.folder || ''))
  if (!row) throw new Error('Turn on storage first.')
  const n = Number(opts.capBytes)
  if (!Number.isInteger(n) || n <= 0) throw new Error('Enter a storage limit in bytes.')
  row.cap_bytes = n
  return { ok: true, capBytes: n }
}

export function mediaTurnOnBucket(folder: string): { ok: true; bucket: string } {
  if (!isMediaDryRun()) throw new Error('Bucket create is dry-run only in this slice.')
  const row = brainForFolder(String(folder || ''))
  if (!row) throw new Error('Turn on storage first.')
  enableDirectoryBucket(userData(), row.bucket)
  row.bucket_status = 'on'
  return { ok: true, bucket: row.bucket }
}

function ensureScope(row: MediaBrainRow, root: string): { id: string; version: number } {
  const mem = store()
  const hit = mem.scopes.find((s) => s.media_brain_id === row.id && s.root === root)
  if (hit) return { id: hit.id, version: hit.key_version }
  const brainKey = takeKey(brainKeyId(row.id))
  if (!brainKey) throw new Error('This Mac does not have the storage key in memory. Turn storage on again.')
  const projectKey = createScopeKey()
  const id = randomUUID()
  holdKey(scopeKeyId(id), projectKey)
  const escrow = wrapKeyToDevice({
    key: projectKey,
    devicePublicKey: ensureDeviceKey(userData(), row.id, safe()).publicKey,
    mediaBrainId: row.id,
    scope: id,
    version: 1
  })
  const packed = wrapToHex(escrow)
  mem.scopes.push({
    id,
    media_brain_id: row.id,
    root,
    key_version: 1,
    escrow_wrap: Buffer.concat([escrow.ephPub, escrow.nonce, escrow.ciphertext]).toString('hex')
  })
  mem.wraps.push({
    id: randomUUID(),
    media_brain_id: row.id,
    scope: id,
    key_version: 1,
    target: 'device',
    device_id: ensureDeviceKey(userData(), row.id, safe()).fingerprint,
    eph_pub: packed.eph_pub,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  })
  upsertWrap(userData(), row.id, {
    scope: id,
    key_version: 1,
    eph_pub: packed.eph_pub,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  })
  return { id, version: 1 }
}

export async function mediaAdd(opts: {
  folder: string
  root: string
  path?: string
}): Promise<MediaAddResult> {
  const folder = String(opts.folder || '')
  if (!isMediaDryRun()) throw new Error('Storage upload is dry-run only in this slice.')
  const who = actor(folder)
  if (!who.token) throw new Error(NO_SEAT)
  if (!canTurnOnGithubSync(who.role, who.joe)) throw new Error(NO_BUILDER)
  const row = brainForFolder(folder)
  if (!row) throw new Error('Turn on storage first.')
  let filePath = String(opts.path || '')
  if (!filePath) {
    const picked = await dialog.showOpenDialog({
      title: 'Add a video or image',
      properties: ['openFile']
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, status: 400, error: 'canceled', detail: 'No file picked.' }
    filePath = picked.filePaths[0]
  }
  if (!existsSync(filePath)) throw new Error('That file is not on this computer.')
  const root = String(opts.root || '')
  if (!/^projects\/[^/]+\/$/.test(root) && !/^clients\/[^/]+\/$/.test(root)) {
    throw new Error('Pick a project in this folder.')
  }
  const plain = readFileSync(filePath)
  const chunkSize = mediaChunkSize()
  if (chunkSize < CHUNK_SIZE_MIN) throw new Error('Bad chunk size.')
  const mediaId = randomUUID()
  const dek = newDek()
  const encrypted = encryptMedia({ plaintext: plain, mediaId, chunkSize, dek })
  const cipherBytes = encrypted.object.length
  if (row.cap_bytes == null) {
    dek.fill(0)
    throw new MediaErr(409, NO_CAP, 'Plyntr has not set a storage limit for this brain yet.')
  }
  if (row.used_bytes + row.reserved_bytes + cipherBytes > row.cap_bytes) {
    dek.fill(0)
    throw new MediaErr(413, OVER_CAP, "This brain's storage is full. Ask Plyntr to raise the limit.")
  }
  if (row.bucket_status !== 'on') {
    dek.fill(0)
    throw new Error('Plyntr storage for this brain is not turned on yet. Plyntr will let you know.')
  }
  const scope = ensureScope(row, root)
  const projectKey = takeKey(scopeKeyId(scope.id))
  if (!projectKey) throw new Error('This Mac does not have the project key.')
  row.reserved_bytes += cipherBytes
  const dekWrap = wrapDek({
    dek,
    projectKey,
    mediaId,
    scopeId: scope.id,
    keyVersion: scope.version
  })
  dek.fill(0)
  const partSize = mediaPartSize()
  const cut = mediaCutover()
  let parts = 1
  if (cipherBytes > cut) parts = Math.max(1, Math.ceil(cipherBytes / partSize))
  putDryObject(userData(), row.bucket, `o/${mediaId}`, encrypted.object)
  row.reserved_bytes -= cipherBytes
  row.used_bytes += cipherBytes
  store().objects.push({
    id: mediaId,
    media_brain_id: row.id,
    scope_id: scope.id,
    object_key: `o/${mediaId}`,
    bytes: plain.length,
    cipher_bytes: cipherBytes,
    mime: mimeFor(filePath),
    dek_wrap: dekWrap.toString('hex'),
    dek_version: scope.version,
    status: 'ready',
    upload_id: randomUUID(),
    part_count: parts,
    created_by_email: who.email
  })
  const title = basename(filePath).replace(/\.[^.]+$/, '') || 'file'
  const pointer = writePointer({
    folder,
    root,
    fields: {
      brain_media: 1,
      media_id: mediaId,
      title,
      mime: mimeFor(filePath),
      bytes: plain.length,
      added: new Date().toISOString().slice(0, 10)
    }
  })
  return { ok: true, rel: pointer.rel, parts, detail: `Saved ${title}.` }
}

export function mediaAllow(_opts: { folder: string; deviceId: string }): { ok: true; detail: string } {
  return { ok: true, detail: 'That computer is waiting until grants land in a later slice.' }
}

export function mediaDumpStore(): ReturnType<typeof dumpMemoryMediaStore> {
  return dumpMemoryMediaStore(userData())
}

export function mediaDropKeys(): void {
  dropKeys()
}

export function mediaDeviceState(folder: string): { mediaBrainId: string; status: string } | null {
  const row = brainForFolder(folder)
  if (!row) return null
  let fingerprint = ''
  try {
    fingerprint = ensureDeviceKey(userData(), row.id, safe()).fingerprint
  } catch {
    return { mediaBrainId: row.id, status: 'pending' }
  }
  const device = store().devices.find((d) => d.media_brain_id === row.id && d.fingerprint === fingerprint)
  if (!device) return { mediaBrainId: row.id, status: 'pending' }
  return { mediaBrainId: row.id, status: device.status }
}

export function mediaWipeBrain(mediaBrainId: string, userDataDir?: string): void {
  const id = String(mediaBrainId || '')
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return
  const root = userDataDir || userData()
  rmSync(join(root, 'media', id), { recursive: true, force: true })
  dropKeys(brainKeyId(id))
  for (const s of store().scopes.filter((s) => s.media_brain_id === id)) {
    dropKeys(scopeKeyId(s.id))
  }
  const seatsPath = join(root, 'media', 'seats.json')
  if (!existsSync(seatsPath)) return
  try {
    const raw = JSON.parse(readFileSync(seatsPath, 'utf8')) as Record<string, unknown>
    if (raw && typeof raw === 'object' && id in raw) {
      delete raw[id]
      writeFileSync(seatsPath, JSON.stringify(raw))
    }
  } catch {
    /* */
  }
}

function mediaAccessRoots(folder: string): 'full' | string[] {
  const who = actor(folder)
  if (who.role === 'project') return []
  return 'full'
}

function projectKeyFor(brainId: string, scopeId: string, keyVersion: number): Buffer {
  const held = takeKey(scopeKeyId(scopeId))
  if (held) return held
  const row = readWrapsFile(userData(), brainId).find((w) => w.scope === scopeId && w.key_version === keyVersion)
  if (!row) throw new Error(MEDIA_NOT_APPROVED)
  const live = ensureDeviceKey(userData(), brainId, safe())
  try {
    const key = unwrapKeyFromDevice({
      wrap: {
        ephPub: Buffer.from(row.eph_pub, 'hex'),
        nonce: Buffer.from(row.nonce, 'hex'),
        ciphertext: Buffer.from(row.ciphertext, 'hex')
      },
      devicePrivateKey: live.privateKey,
      mediaBrainId: brainId,
      scope: scopeId,
      version: keyVersion
    })
    holdKey(scopeKeyId(scopeId), key)
    return key
  } catch {
    throw new Error(MEDIA_NOT_APPROVED)
  }
}

function ensureObjectCached(brain: MediaBrainRow, objectId: string, objectKey: string): string {
  if (cipherCacheExists(userData(), brain.id, objectId)) {
    touchCipherCache(userData(), brain.id, objectId)
    return cachePath(userData(), brain.id, objectId)
  }
  const src = dryObjectPath(userData(), brain.bucket, objectKey)
  if (!existsSync(src)) throw new Error(MEDIA_NEEDS_NET)
  try {
    return writeCipherCache(userData(), brain.id, objectId, readFileSync(src))
  } catch (err) {
    const msg = String((err as Error).message || err)
    if (msg === MEDIA_NEEDS_NET) throw err
    throw new Error(MEDIA_OPEN_FAIL)
  }
}

export function prepareMediaPlay(opts: { folder: string; mediaId: string }): {
  cacheFile: string
  dek: Buffer
  mime: string
  plainLen: number
  mediaBrainId: string
} {
  const folder = String(opts.folder || '')
  const mediaId = assertMediaId(opts.mediaId)
  const brain = brainForFolder(folder)
  if (!brain) throw new Error(MEDIA_OPEN_FAIL)
  const mem = store()
  const object = mem.objects.find((o) => o.id === mediaId)
  if (!object) throw new Error(MEDIA_OPEN_FAIL)
  if (object.status === 'deleted') throw new Error(MEDIA_REMOVED)
  if (object.media_brain_id !== brain.id) throw new Error(MEDIA_WRONG_PROJECT)
  if (object.status !== 'ready') throw new Error(MEDIA_OPEN_FAIL)
  let fingerprint = ''
  try {
    fingerprint = ensureDeviceKey(userData(), brain.id, safe()).fingerprint
  } catch {
    throw new Error(MEDIA_NOT_APPROVED)
  }
  const device = mem.devices.find((d) => d.media_brain_id === brain.id && d.fingerprint === fingerprint)
  if (!device || device.status === 'pending') throw new Error(MEDIA_NOT_APPROVED)
  if (device.status === 'blocked' || device.status === 'revoked') throw new Error(MEDIA_OPEN_FAIL)
  const scope = mem.scopes.find((s) => s.id === object.scope_id)
  if (!scope) throw new Error(MEDIA_OPEN_FAIL)
  const roots = mediaAccessRoots(folder)
  if (roots !== 'full') {
    const ok = roots.some((r) => scope.root === r || scope.root.startsWith(r))
    if (!ok) throw new Error(MEDIA_WRONG_PROJECT)
  }
  const projectKey = projectKeyFor(brain.id, scope.id, object.dek_version)
  const dek = unwrapDek({
    wrap: Buffer.from(object.dek_wrap, 'hex'),
    projectKey,
    mediaId: object.id,
    scopeId: scope.id,
    keyVersion: object.dek_version
  })
  const cacheFile = ensureObjectCached(brain, object.id, object.object_key)
  return {
    cacheFile,
    dek,
    mime: object.mime,
    plainLen: object.bytes,
    mediaBrainId: brain.id
  }
}
