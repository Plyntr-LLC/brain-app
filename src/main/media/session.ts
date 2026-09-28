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
import { brainIdForFolder, roleForKeylessWrite, seatForBrain, seatTokenForFolder } from '../plyntr-seats.ts'
import { currentBrainFolder } from '../brains.ts'
import { getAccount, loadAccount } from '../session-token.ts'
import { getSettings } from '../settings-store.ts'
import { isJoeSuperAdmin } from '../super-admin.ts'
import { cachePath, cipherCacheExists, touchCipherCache, writeCipherCache } from './cache.ts'
import { assertMediaId, CHUNK_SIZE_DEFAULT, CHUNK_SIZE_MIN, newDek } from './crypto.ts'
import { ensureDeviceKey, type SafeStorageApi } from './device-key.ts'
import { dryObjectPath, enableDirectoryBucket, putDryObject } from './dry-worker.ts'
import { encryptMedia } from './format.ts'
import {
  autoWrapPending,
  completeReservation,
  DEVICE_REVOKED,
  finishRemoveCopy,
  markMediaRevokedWorker,
  pullDeviceWraps,
  projectLabel,
  releaseReservation,
  rotateFullBrain,
  rotateProjectScope,
  revokeCopy,
  ROTATION_PENDING,
  tryReserve,
  workerStateForDevice,
  wrapScopesToDevice
} from './grants.ts'
import {
  mintProjectHmacToken,
  normalizeMediaRoot,
  PBT_ON_PROJECT,
  readHmacSeat,
  rootsOverlap,
  verifyProjectHmacToken,
  writeHmacSeat
} from './hmac-seat.ts'
import {
  createBrainKey,
  createRecoveryKey,
  createScopeKey,
  dropKeys,
  holdKey,
  PASSPHRASE_INFO,
  parseRecoveryKey,
  RECOVERY_INFO,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  signWithProof,
  takeKey,
  unwrapBrainKeyWithPassphrase,
  unwrapBrainKeyWithRecovery,
  unwrapDek,
  unwrapKeyFromDevice,
  wrapBrainKeyWithPassphrase,
  wrapBrainKeyWithRecovery,
  wrapDek,
  wrapKeyToDevice,
  wrapKeyWithBrain,
  unwrapKeyWithBrain,
  passphraseIkm,
  type DeviceKeyWrap
} from './keys.ts'
import { recordMintedInvite as writeMintedInvite, readMintedInvites } from './minted.ts'
import { writePointer } from './pointer.ts'
import { readWrapsFile, upsertWrap } from './wraps-file.ts'
import { assertPassphrase, generatePassphrase } from './passphrase.ts'
import { isMediaDryRun } from './transport.ts'
import { dumpMemoryMediaStore, memoryMediaStore, type MediaBrainRow, type MediaDeviceRow } from './store.ts'
import { readMediaConfig, writeMediaConfig } from './media-config.ts'
import { dropPmsSeat, mintPmsToken, readAnyPmsSeat, readPmsSeat, writePmsSeat } from './pms-seats.ts'
import {
  postMediaEmailCode,
  postMediaInvite,
  postReclaimFinish,
  postReclaimStart,
  postWrapPassphrase,
  refuseBrainKeyProof,
  signedPayload,
  wrapBytesSnapshot
} from './reclaim.ts'

export const NO_CAP = 'no_cap'
export const OVER_CAP = 'over_cap'
export { DEVICE_REVOKED, PBT_ON_PROJECT, mintProjectHmacToken, revokeCopy }
export const NO_SEAT = 'Sign in to this brain before turning on storage.'
export const NO_BUILDER = 'Only an owner or scout can turn on Plyntr storage.'
export const ASKED_FILE = 'media-asked.json'
export const DRY_HQ_REPO = 'plyntr/alpha-brain'

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
  const on = store().brains.filter((b) => b.status === 'on')
  const hit = on.find((b) => b.folder === folder)
  if (hit) return hit
  const cfg = readMediaConfig(folder)
  if (cfg) return on.find((b) => b.id === cfg.mediaBrainId)
  return undefined
}

function canTurnOnStorage(who: MediaActor, folder: string): boolean {
  const roster = roleForKeylessWrite(folder)
  if (roster) return canTurnOnGithubSync(roster, false)
  if (who.token) return canTurnOnGithubSync(who.role, who.joe)
  if (who.hmac) return false
  return Boolean(who.email)
}

function brainForHqRepo(hqRepo: string): MediaBrainRow | undefined {
  const want = String(hqRepo || '').trim().toLowerCase()
  if (!want) return undefined
  return store().brains.find((b) => String(b.hq_repo || '').trim().toLowerCase() === want && b.status === 'on')
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

type MediaActor = {
  email: string
  role: string
  joe: boolean
  token: string
  brainId: string
  roots: string[]
  hmac: boolean
}

function actor(folder: string): MediaActor {
  const hmac = readHmacSeat(userData())
  if (hmac?.token) {
    const verified = verifyProjectHmacToken(hmac.token)
    if (verified.ok) {
      return {
        email: verified.payload.email || hmac.email,
        role: 'project',
        joe: false,
        token: hmac.token,
        brainId: '',
        roots: verified.payload.roots.length ? verified.payload.roots : hmac.roots,
        hmac: true
      }
    }
  }
  const token = seatTokenForFolder(folder)
  const brainId = brainIdForFolder(folder)
  const seat = brainId ? seatForBrain(brainId) : null
  const acct = getAccount() || loadAccount()
  const joe = isJoeSuperAdmin(acct, getSettings())
  const row = brainForFolder(folder)
  const pms = row ? readPmsSeat(userData(), row.id, safe()) : readAnyPmsSeat(userData(), safe())
  const roster = roleForKeylessWrite(folder)
  return {
    email: String(seat?.email || pms?.email || acct?.email || ''),
    role: String(seat?.role || pms?.role || roster || ''),
    joe,
    token: token || pms?.token || '',
    brainId,
    roots: [],
    hmac: false
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
          project: projectLabel(d.roots)
        }))
    : []
  const others = on
    ? store()
        .devices.filter(
          (d) =>
            d.media_brain_id === row?.id &&
            d.status === 'approved' &&
            d.fingerprint &&
            d.fingerprint !== fingerprint
        )
        .map((d) => ({
          deviceId: d.id,
          name: d.email.split('@')[0] || 'Mac',
          fingerprint: d.fingerprint,
          project: projectLabel(d.roots)
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
    others: others.map((w) => ({
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
    if (canTurnOnStorage(who, folder)) base.detail = 'On this computer. Only this Mac has them.'
    else if (!who.token) base.detail = 'On this computer.'
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
  const roster = roleForKeylessWrite(folder)
  return shouldShowStorageAsk({
    role: opts.role || who.role || roster,
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

export async function mediaEnable(opts: { folder: string; passphrase?: string; email?: string; code?: string }): Promise<MediaEnableResult> {
  const folder = String(opts.folder || '')
  if (!isMediaDryRun()) throw new Error('Storage enable is dry-run only in this slice.')
  const who = actor(folder)
  if (!canTurnOnStorage(who, folder)) throw new Error(NO_BUILDER)
  if (!who.token && !who.email && !opts.email) throw new Error(NO_SEAT)
  const existing = brainForFolder(folder)
  if (existing) {
    const st = await mediaStatus(folder)
    return { ok: true, fingerprint: st.fingerprint, detail: 'Plyntr storage is on.' }
  }
  const email = String(opts.email || who.email || '').trim().toLowerCase()
  let claimed = Boolean(who.token && who.token.startsWith('pbt_'))
  if (!claimed) {
    if (!email) throw new Error(NO_SEAT)
    const minted = postMediaEmailCode({ userData: userData(), email })
    if (minted.status !== 200 || !minted.code) throw new Error('Could not send a storage code.')
    const code = String(opts.code || minted.code)
    if (!code) throw new Error('Type the email code.')
    claimed = true
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
  let hqRepo = DRY_HQ_REPO
  try {
    const hq = await import('../hq-sync.ts')
    hqRepo = hq.hqRepoFromFolder(folder) || DRY_HQ_REPO
  } catch {
    hqRepo = DRY_HQ_REPO
  }
  const mem = store()
  const pms = !who.token || !who.token.startsWith('pbt_')
  const seatToken = pms ? mintPmsToken() : who.token
  mem.brains.push({
    id: mediaBrainId,
    plyntr_brain_id: who.brainId || mediaBrainId,
    hq_repo: hqRepo,
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
    created_by_email: email || who.email,
    status: 'on',
    brain_rotation_pending: '',
    user_data: userData()
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
    email: email || who.email,
    fingerprint: live.fingerprint,
    public_key: live.publicKey.toString('hex'),
    seat_kind: 'full',
    seat_id: who.brainId || live.fingerprint,
    roots: [],
    status: 'approved'
  })
  mem.seats.push({
    id: who.brainId || live.fingerprint,
    media_brain_id: mediaBrainId,
    email: email || who.email,
    role: who.role === 'scout' ? 'scout' : 'owner',
    roots: [],
    status: 'active',
    kind: pms ? 'pms' : 'pbt'
  })
  if (pms) {
    writePmsSeat(
      userData(),
      {
        email: email || who.email,
        role: 'owner',
        token: seatToken,
        mediaBrainId
      },
      safe()
    )
  }
  writeMediaConfig(folder, mediaBrainId, who.hmac ? 'project' : who.role)
  const held = slot(mediaBrainId)
  if (!opts.passphrase) held.passphrase = phrase
  held.recovery = recovery.display
  recovery.raw.fill(0)
  markMediaAsked(folder)
  void claimed
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

function bucketDir(row: MediaBrainRow): string {
  return row.user_data || userData()
}

function ensureBrainKeyInMemory(row: MediaBrainRow): Buffer | null {
  const held = takeKey(brainKeyId(row.id))
  if (held) return held
  const wrap = readWrapsFile(userData(), row.id).find(
    (w) => w.scope === 'brain' && w.key_version === row.brain_key_version
  )
  if (!wrap) return null
  try {
    const live = ensureDeviceKey(userData(), row.id, safe())
    const key = unwrapKeyFromDevice({
      wrap: {
        ephPub: Buffer.from(wrap.eph_pub, 'hex'),
        nonce: Buffer.from(wrap.nonce, 'hex'),
        ciphertext: Buffer.from(wrap.ciphertext, 'hex')
      },
      devicePrivateKey: live.privateKey,
      mediaBrainId: row.id,
      scope: 'brain',
      version: row.brain_key_version
    })
    holdKey(brainKeyId(row.id), key)
    return key
  } catch {
    return null
  }
}

function ensureProjectKeyInMemory(row: MediaBrainRow, scopeId: string, keyVersion: number): Buffer | null {
  const held = takeKey(scopeKeyId(scopeId))
  if (held) return held
  try {
    const key = unwrapLocalScopeKey(row.id, scopeId, keyVersion)
    holdKey(scopeKeyId(scopeId), key)
    return key
  } catch {
    return null
  }
}

function unwrapLocalScopeKey(brainId: string, scopeId: string, keyVersion: number): Buffer {
  const row = readWrapsFile(userData(), brainId).find((w) => w.scope === scopeId && w.key_version === keyVersion)
  if (!row) throw new Error(MEDIA_NOT_APPROVED)
  const live = ensureDeviceKey(userData(), brainId, safe())
  return unwrapKeyFromDevice({
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
}

function scopeKeyMap(row: MediaBrainRow): Map<string, Buffer> {
  const map = new Map<string, Buffer>()
  const brainKey = ensureBrainKeyInMemory(row)
  for (const scope of store().scopes.filter((s) => s.media_brain_id === row.id)) {
    let key = ensureProjectKeyInMemory(row, scope.id, scope.key_version)
    if (!key && brainKey) {
      const brainWrap = store().wraps.find(
        (w) =>
          w.media_brain_id === row.id &&
          w.scope === scope.id &&
          w.key_version === scope.key_version &&
          w.target === 'brain'
      )
      if (brainWrap?.ciphertext) {
        try {
          key = unwrapKeyWithBrain({
            wrap: Buffer.from(brainWrap.ciphertext, 'hex'),
            brainKey,
            mediaBrainId: row.id,
            scope: scope.id,
            version: scope.key_version
          })
          holdKey(scopeKeyId(scope.id), key)
        } catch {
          key = null
        }
      }
    }
    if (key) map.set(scope.id, key)
  }
  return map
}

function ownerDevice(row: MediaBrainRow): MediaDeviceRow | undefined {
  try {
    const fp = ensureDeviceKey(userData(), row.id, safe()).fingerprint
    return store().devices.find((d) => d.media_brain_id === row.id && d.fingerprint === fp)
  } catch {
    return undefined
  }
}

function ensureScope(row: MediaBrainRow, root: string): { id: string; version: number } {
  const mem = store()
  const hit = mem.scopes.find((s) => s.media_brain_id === row.id && s.root === root)
  if (hit) return { id: hit.id, version: hit.key_version }
  if (!ensureBrainKeyInMemory(row)) {
    throw new Error('This Mac does not have the storage key in memory. Turn storage on again.')
  }
  const projectKey = createScopeKey()
  const id = randomUUID()
  holdKey(scopeKeyId(id), projectKey)
  const live = ensureDeviceKey(userData(), row.id, safe())
  const escrow = wrapKeyToDevice({
    key: projectKey,
    devicePublicKey: live.publicKey,
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
    escrow_wrap: Buffer.concat([escrow.ephPub, escrow.nonce, escrow.ciphertext]).toString('hex'),
    needs_rotation: false
  })
  mem.wraps.push({
    id: randomUUID(),
    media_brain_id: row.id,
    scope: id,
    key_version: 1,
    target: 'device',
    device_id: live.fingerprint,
    eph_pub: packed.eph_pub,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  })
  const brainKey = takeKey(brainKeyId(row.id))
  if (brainKey) {
    mem.wraps.push({
      id: randomUUID(),
      media_brain_id: row.id,
      scope: id,
      key_version: 1,
      target: 'brain',
      device_id: '',
      eph_pub: '',
      nonce: '',
      ciphertext: wrapKeyWithBrain({
        key: projectKey,
        brainKey,
        mediaBrainId: row.id,
        scope: id,
        version: 1
      }).toString('hex')
    })
  }
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
  const reserved = tryReserve(row, cipherBytes)
  if (reserved === NO_CAP) {
    dek.fill(0)
    throw new MediaErr(409, NO_CAP, 'Plyntr has not set a storage limit for this brain yet.')
  }
  if (reserved === OVER_CAP) {
    dek.fill(0)
    throw new MediaErr(413, OVER_CAP, "This brain's storage is full. Ask Plyntr to raise the limit.")
  }
  if (reserved === ROTATION_PENDING) {
    dek.fill(0)
    throw new MediaErr(423, ROTATION_PENDING, finishRemoveCopy(row.brain_rotation_pending))
  }
  if (reserved !== 'ok') {
    dek.fill(0)
    throw new Error('Plyntr storage for this brain is not turned on yet. Plyntr will let you know.')
  }
  await Promise.resolve()
  const scope = ensureScope(row, root)
  const projectKey = ensureProjectKeyInMemory(row, scope.id, scope.version)
  if (!projectKey) {
    releaseReservation(row, cipherBytes)
    dek.fill(0)
    throw new Error('This Mac does not have the project key.')
  }
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
  putDryObject(bucketDir(row), row.bucket, `o/${mediaId}`, encrypted.object)
  completeReservation(row, cipherBytes)
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

export function mediaAllow(opts: { folder: string; deviceId: string }): { ok: true; detail: string } {
  const folder = String(opts.folder || '')
  const who = actor(folder)
  if (!canTurnOnGithubSync(who.role, who.joe)) throw new Error('Only an owner or scout can allow a computer.')
  const row = brainForFolder(folder)
  if (!row) throw new Error('Turn on storage first.')
  if (!ensureBrainKeyInMemory(row)) {
    throw new Error('This Mac does not have the storage key in memory. Turn storage on again.')
  }
  const mem = store()
  const device = mem.devices.find((d) => d.media_brain_id === row.id && d.id === String(opts.deviceId || ''))
  if (!device) throw new Error('That computer is not waiting.')
  wrapScopesToDevice({
    mem,
    row,
    device,
    scopeKeys: scopeKeyMap(row)
  })
  device.status = 'approved'
  return { ok: true, detail: 'That computer can open files here now.' }
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

export function mediaWorkerState(folder: string): { status: number; error?: string; mediaBrainId?: string } {
  const snap = mediaDeviceState(folder)
  if (!snap) return { status: 204 }
  const live = (() => {
    try {
      return ensureDeviceKey(userData(), snap.mediaBrainId, safe()).fingerprint
    } catch {
      return ''
    }
  })()
  const row = store().devices.find((d) => d.media_brain_id === snap.mediaBrainId && d.fingerprint === live)
  const state = workerStateForDevice(row)
  return { ...state, mediaBrainId: snap.mediaBrainId }
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
  const hmacPath = join(root, 'media', 'hmac-seat.json')
  if (existsSync(hmacPath)) {
    try {
      rmSync(hmacPath, { force: true })
    } catch {
      /* */
    }
  }
  dropPmsSeat(root, id)
}

function mediaAccessRoots(folder: string): 'full' | string[] {
  const who = actor(folder)
  if (who.hmac || who.role === 'project') return who.roots
  return 'full'
}

function projectKeyFor(brainId: string, scopeId: string, keyVersion: number): Buffer {
  try {
    const key = unwrapLocalScopeKey(brainId, scopeId, keyVersion)
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
  const src = dryObjectPath(bucketDir(brain), brain.bucket, objectKey)
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
  if (object.media_brain_id !== brain.id) throw new MediaErr(403, 'wrong_project', MEDIA_WRONG_PROJECT)
  if (object.status !== 'ready') throw new Error(MEDIA_OPEN_FAIL)
  let fingerprint = ''
  try {
    fingerprint = ensureDeviceKey(userData(), brain.id, safe()).fingerprint
  } catch {
    throw new Error(MEDIA_NOT_APPROVED)
  }
  const device = mem.devices.find((d) => d.media_brain_id === brain.id && d.fingerprint === fingerprint)
  if (!device || device.status === 'pending') throw new Error(MEDIA_NOT_APPROVED)
  if (device.status === 'revoked') throw new MediaErr(410, DEVICE_REVOKED, MEDIA_OPEN_FAIL)
  if (device.status === 'blocked') throw new MediaErr(401, 'blocked', MEDIA_OPEN_FAIL)
  const scope = mem.scopes.find((s) => s.id === object.scope_id)
  if (!scope) throw new Error(MEDIA_OPEN_FAIL)
  const roots = mediaAccessRoots(folder)
  if (roots !== 'full') {
    const ok = rootsOverlap(roots, scope.root)
    if (!ok) throw new MediaErr(403, 'wrong_project', MEDIA_WRONG_PROJECT)
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

export function mediaDownload(opts: { folder: string; mediaId: string }): {
  status: number
  error?: string
} {
  const folder = String(opts.folder || '')
  const who = actor(folder)
  const brain = brainForFolder(folder)
  if (!brain) return { status: 404, error: 'missing' }
  const mem = store()
  if (who.hmac) {
    const device = mem.devices.find(
      (d) => d.media_brain_id === brain.id && d.email.toLowerCase() === who.email.toLowerCase()
    )
    if (device?.status === 'revoked') return { status: 410, error: DEVICE_REVOKED }
    if (device?.status === 'blocked') return { status: 401, error: 'blocked' }
    const object = mem.objects.find((o) => o.id === opts.mediaId)
    const scope = object ? mem.scopes.find((s) => s.id === object.scope_id) : undefined
    if (object && scope && !rootsOverlap(who.roots, scope.root)) {
      return { status: 403, error: 'wrong_project' }
    }
  }
  try {
    const prep = prepareMediaPlay(opts)
    prep.dek.fill(0)
    return { status: 200 }
  } catch (err) {
    if (err instanceof MediaErr) return { status: err.status, error: err.error }
    const msg = String((err as Error).message || err)
    if (msg === MEDIA_WRONG_PROJECT) return { status: 403, error: 'wrong_project' }
    if (msg === MEDIA_NOT_APPROVED) return { status: 403, error: 'not_approved' }
    return { status: 403, error: 'refused' }
  }
}

export function recordMintedInvite(opts: {
  brainId?: string
  folder?: string
  email: string
  roots: string[]
  role?: string
}): void {
  const folder = String(opts.folder || currentBrainFolder() || '')
  const mem = store()
  const row =
    (folder ? brainForFolder(folder) : undefined) ||
    mem.brains.find((b) => b.plyntr_brain_id === String(opts.brainId || '') || b.id === String(opts.brainId || ''))
  if (!row) return
  const roots = (opts.roots || []).map(normalizeMediaRoot).filter(Boolean)
  if (opts.role === 'project' && !roots.length) return
  writeMintedInvite(userData(), row.id, {
    inviteEmail: opts.email,
    roots: roots.length ? roots : []
  })
}

export function mintProjectMediaSeat(opts: {
  folder: string
  email: string
  roots: string[]
  hq_repo?: string
  device_id?: string
}): { seat_id: string; token: string; roots: string[] } {
  const folder = String(opts.folder || '')
  const row = brainForFolder(folder)
  if (!row) throw new Error('Turn on storage first.')
  const email = String(opts.email || '').trim().toLowerCase()
  const roots = (opts.roots || []).map(normalizeMediaRoot).filter(Boolean)
  const seat_id = randomUUID()
  store().seats.push({
    id: seat_id,
    media_brain_id: row.id,
    email,
    role: 'project',
    roots,
    status: 'active'
  })
  recordMintedInvite({ folder, email, roots, role: 'project' })
  const token = mintProjectHmacToken({
    seat_id,
    email,
    hq_repo: opts.hq_repo || row.hq_repo || DRY_HQ_REPO,
    device_id: opts.device_id || randomUUID().replace(/-/g, ''),
    roots
  })
  if (!row.hq_repo) row.hq_repo = opts.hq_repo || DRY_HQ_REPO
  return { seat_id, token, roots }
}

export function registerMediaDevice(opts: { folder: string; token: string }): {
  ok: true
  deviceId: string
  fingerprint: string
  email: string
  roots: string[]
} {
  const folder = String(opts.folder || '')
  const verified = verifyProjectHmacToken(opts.token)
  if (!verified.ok) throw new Error(PBT_ON_PROJECT)
  const row =
    brainForHqRepo(verified.payload.hq_repo) || brainForFolder(folder) || store().brains[0]
  if (!row) throw new Error('Turn on storage first.')
  const seatRow = store().seats.find(
    (s) =>
      s.media_brain_id === row.id &&
      (s.id === verified.payload.seat_id || s.email === verified.payload.email) &&
      s.status === 'active'
  )
  const roots = (seatRow?.roots?.length ? seatRow.roots : verified.payload.roots).map(normalizeMediaRoot)
  const live = ensureDeviceKey(userData(), row.id, safe())
  const mem = store()
  const existing = mem.devices.find((d) => d.media_brain_id === row.id && d.fingerprint === live.fingerprint)
  const device: MediaDeviceRow = existing || {
    id: live.fingerprint,
    media_brain_id: row.id,
    email: verified.payload.email,
    fingerprint: live.fingerprint,
    public_key: live.publicKey.toString('hex'),
    seat_kind: 'project',
    seat_id: verified.payload.seat_id,
    roots,
    status: 'pending'
  }
  if (!existing) mem.devices.push(device)
  else {
    device.email = verified.payload.email
    device.roots = roots
    device.public_key = live.publicKey.toString('hex')
    device.seat_id = verified.payload.seat_id
    if (device.status !== 'revoked') device.status = device.status === 'approved' ? 'approved' : 'pending'
  }
  writeHmacSeat(userData(), {
    token: opts.token,
    email: verified.payload.email,
    roots,
    hq_repo: verified.payload.hq_repo,
    seat_id: verified.payload.seat_id
  })
  return {
    ok: true,
    deviceId: device.id,
    fingerprint: live.fingerprint,
    email: device.email,
    roots: device.roots
  }
}

export function runMediaCheckIn(folder: string): {
  status: number
  error?: string
  wiped: boolean
  wrapped: string[]
  rotated: string[]
} {
  const path = String(folder || '')
  const row = brainForFolder(path)
  if (!row) return { status: 204, wiped: false, wrapped: [], rotated: [] }
  const state = mediaWorkerState(path)
  if (state.status === 410) {
    mediaWipeBrain(row.id, userData())
    return { status: 410, error: DEVICE_REVOKED, wiped: true, wrapped: [], rotated: [] }
  }
  if (state.status === 401) {
    return { status: 401, wiped: false, wrapped: [], rotated: [] }
  }
  const who = actor(path)
  const wrapped: string[] = []
  const rotated: string[] = []
  const live = (() => {
    try {
      return ensureDeviceKey(userData(), row.id, safe())
    } catch {
      return null
    }
  })()
  if (canTurnOnGithubSync(who.role, who.joe) && ensureBrainKeyInMemory(row)) {
    if (row.brain_rotation_pending) {
      /* check-in never rotates the brain key */
    } else {
      const mem = store()
      const keys = scopeKeyMap(row)
      const keep = mem.devices.filter((d) => d.media_brain_id === row.id && d.status === 'approved')
      const me = ownerDevice(row)
      for (const scope of mem.scopes.filter((s) => s.media_brain_id === row.id && s.needs_rotation)) {
        const oldKey = keys.get(scope.id)
        if (!oldKey) continue
        const newKey = createScopeKey()
        rotateProjectScope({
          mem,
          row,
          scope,
          oldKey,
          newKey,
          keepDevices: keep,
          ownerUserData: userData(),
          ownerDeviceId: me?.id,
          brainKey: ensureBrainKeyInMemory(row) || undefined
        })
        holdKey(scopeKeyId(scope.id), newKey)
        keys.set(scope.id, newKey)
        rotated.push(scope.id)
      }
      wrapped.push(
        ...autoWrapPending({
          mem,
          row,
          minted: readMintedInvites(userData(), row.id),
          scopeKeys: keys
        })
      )
    }
  }
  if (live) pullDeviceWraps(userData(), row.id, live.fingerprint)
  return { status: 200, wiped: false, wrapped, rotated }
}

export function revokeMediaDevice(opts: {
  folder: string
  deviceId?: string
  seatId?: string
  email?: string
  proof?: boolean
  passphrase?: string
  recovery?: string
  signature?: string
  kind?: 'passphrase' | 'recovery'
}): { ok: true; detail: string; kind: 'project' | 'blocked' | 'wiped' } {
  const row = brainForFolder(String(opts.folder || ''))
  if (!row) throw new Error('Turn on storage first.')
  const device = store().devices.find(
    (d) =>
      d.media_brain_id === row.id &&
      (d.id === opts.deviceId || d.seat_id === opts.seatId || (opts.email && d.email === String(opts.email).toLowerCase()))
  )
  const email = String(opts.email || device?.email || '')
  const pass = String(opts.passphrase || '')
  const rec = String(opts.recovery || '')
  if (opts.signature && !pass) {
    const check = refuseBrainKeyProof({
      userData: userData(),
      mediaBrainId: row.id,
      signature: String(opts.signature),
      kind: 'revoke',
      extra: device?.id || ''
    })
    if (check.status !== 200) {
      return { ok: true, detail: finishRemoveCopy(email), kind: 'blocked' }
    }
  }
  const proven = Boolean(opts.proof || pass || rec)
  if (proven && pass) {
    const data = signedPayload('revoke', row, device?.id || '')
    const salt = Buffer.from(row.passphrase_salt, 'hex')
    const derivedWrap = {
      salt,
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      wrap: Buffer.from(row.passphrase_wrap, 'hex'),
      proofPublicKey: Buffer.from(row.passphrase_proof, 'hex')
    }
    const brainKey = unwrapBrainKeyWithPassphrase({ wrap: derivedWrap, passphrase: pass, mediaBrainId: row.id })
    holdKey(brainKeyId(row.id), brainKey)
    const ikm = passphraseIkm(pass, salt)
    const sig = opts.signature ? Buffer.from(opts.signature, 'hex') : signWithProof(ikm, PASSPHRASE_INFO(row.id), data)
    ikm.fill(0)
    const check = refuseBrainKeyProof({
      userData: userData(),
      mediaBrainId: row.id,
      signature: sig.toString('hex'),
      kind: 'revoke',
      extra: device?.id || ''
    })
    if (check.status !== 200) {
      return { ok: true, detail: finishRemoveCopy(email), kind: 'blocked' }
    }
    const mem = store()
    const keep = mem.devices.filter(
      (d) => d.media_brain_id === row.id && d.status === 'approved' && d.id !== device?.id
    )
    if (device) {
      mem.wraps = mem.wraps.filter((w) => !(w.media_brain_id === row.id && w.device_id === device.id))
      device.status = 'revoked'
    }
    const me = (() => {
      try {
        return ensureDeviceKey(userData(), row.id, safe()).fingerprint
      } catch {
        return ''
      }
    })()
    const rotated = rotateFullBrain({
      mem,
      row,
      passphrase: pass,
      scopeKeys: scopeKeyMap(row),
      keepDevices: keep,
      ownerUserData: userData(),
      ownerDeviceId: me || ownerDevice(row)?.id
    })
    holdKey(brainKeyId(row.id), rotated.brainKey)
    slot(row.id).recovery = rotated.recoveryDisplay
    return { ok: true, detail: revokeCopy(email), kind: 'wiped' }
  }
  const result = markMediaRevokedWorker(email, row, device?.roots, Boolean(opts.proof))
  return { ok: true, detail: result.detail, kind: result.kind }
}

export function afterPlyntrSeatRevoke(brainId: string, seatId: string): void {
  const mem = store()
  const row =
    mem.brains.find((b) => b.plyntr_brain_id === brainId || b.id === brainId) ||
    (currentBrainFolder() ? brainForFolder(currentBrainFolder()) : undefined)
  if (!row) return
  const seat = mem.seats.find((s) => s.id === seatId && s.media_brain_id === row.id)
  const device = mem.devices.find((d) => d.media_brain_id === row.id && d.seat_id === seatId)
  const email = seat?.email || device?.email
  if (!email) return
  markMediaRevokedWorker(email, row, seat?.roots || device?.roots, false)
}

export function afterHqProjectRevoke(seatId: string): void {
  const mem = store()
  const device = mem.devices.find((d) => d.seat_id === seatId)
  const seat = mem.seats.find((s) => s.id === seatId)
  const row = device
    ? mem.brains.find((b) => b.id === device.media_brain_id)
    : seat
      ? mem.brains.find((b) => b.id === seat.media_brain_id)
      : currentBrainFolder()
        ? brainForFolder(currentBrainFolder())
        : undefined
  if (!row) return
  const email = seat?.email || device?.email
  if (!email) return
  markMediaRevokedWorker(email, row, seat?.roots || device?.roots, false)
}

export function requestMediaEmailCode(email: string): { status: number; body: Record<string, unknown>; code?: string } {
  return postMediaEmailCode({ userData: userData(), email })
}

export function mediaReclaimStart(opts: {
  email: string
  code: string
  devicePublicKey: string
  mediaBrainId?: string
}): { status: number; body: Record<string, unknown> } {
  return postReclaimStart({
    userData: userData(),
    email: opts.email,
    code: opts.code,
    devicePublicKey: opts.devicePublicKey,
    mediaBrainId: opts.mediaBrainId
  })
}

export function mediaReclaimFinish(opts: {
  token: string
  signature: string
  kind?: string
  devicePublicKey: string
  deviceId?: string
  wrap?: { eph_pub: string; nonce: string; ciphertext: string }
  scopeWraps?: Array<{ scope: string; key_version: number; eph_pub: string; nonce: string; ciphertext: string }>
  emailHasPbt?: boolean
}): { status: number; body: Record<string, unknown>; seatToken?: string } {
  return postReclaimFinish({
    userData: userData(),
    token: opts.token,
    signature: opts.signature,
    kind: opts.kind,
    devicePublicKey: opts.devicePublicKey,
    deviceId: opts.deviceId,
    wrap: opts.wrap,
    scopeWraps: opts.scopeWraps,
    emailHasPbt: opts.emailHasPbt
  })
}

export function reclaimOnThisMac(opts: {
  folder: string
  email: string
  code: string
  passphrase?: string
  recovery?: string
}): { ok: boolean; fingerprint: string; detail: string; status?: number } {
  const folder = String(opts.folder || '')
  const row = brainForFolder(folder)
  if (!row) throw new Error('Turn on storage first.')
  const live = ensureDeviceKey(userData(), row.id, safe())
  const start = postReclaimStart({
    userData: userData(),
    email: opts.email,
    code: opts.code,
    devicePublicKey: live.publicKey.toString('hex'),
    mediaBrainId: row.id
  })
  if (start.status !== 200) {
    return { ok: false, fingerprint: '', detail: 'That code did not work.', status: start.status }
  }
  const salt = Buffer.from(String(start.body.salt || ''), 'hex')
  const passWrap = Buffer.from(String(start.body.passphrase_wrap || ''), 'hex')
  const recWrap = Buffer.from(String(start.body.recovery_wrap || ''), 'hex')
  const challenge = Buffer.from(String(start.body.challenge || ''), 'hex')
  const token = String(start.body.token || '')
  let brainKey: Buffer
  let sig: Buffer
  if (opts.passphrase) {
    brainKey = unwrapBrainKeyWithPassphrase({
      wrap: {
        salt,
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        wrap: passWrap,
        proofPublicKey: Buffer.from(row.passphrase_proof, 'hex')
      },
      passphrase: opts.passphrase,
      mediaBrainId: row.id
    })
    const ikm = passphraseIkm(opts.passphrase, salt)
    sig = signWithProof(ikm, PASSPHRASE_INFO(row.id), challenge)
    ikm.fill(0)
  } else if (opts.recovery) {
    const raw = parseRecoveryKey(opts.recovery)
    brainKey = unwrapBrainKeyWithRecovery({
      wrap: { wrap: recWrap, proofPublicKey: Buffer.from(row.recovery_proof, 'hex') },
      recoveryKey: raw,
      mediaBrainId: row.id
    })
    sig = signWithProof(raw, RECOVERY_INFO(row.id), challenge)
  } else {
    return { ok: false, fingerprint: '', detail: 'Type your passphrase or recovery key.' }
  }
  holdKey(brainKeyId(row.id), brainKey)
  const deviceWrap = wrapToHex(
    wrapKeyToDevice({
      key: brainKey,
      devicePublicKey: live.publicKey,
      mediaBrainId: row.id,
      scope: 'brain',
      version: row.brain_key_version
    })
  )
  const scopeWraps: Array<{
    scope: string
    key_version: number
    eph_pub: string
    nonce: string
    ciphertext: string
  }> = []
  for (const scope of store().scopes.filter((s) => s.media_brain_id === row.id)) {
    const brainWrap = store().wraps.find(
      (w) =>
        w.media_brain_id === row.id &&
        w.scope === scope.id &&
        w.key_version === scope.key_version &&
        w.target === 'brain'
    )
    let key = ensureProjectKeyInMemory(row, scope.id, scope.key_version)
    if (!key && brainWrap?.ciphertext) {
      try {
        key = unwrapKeyWithBrain({
          wrap: Buffer.from(brainWrap.ciphertext, 'hex'),
          brainKey,
          mediaBrainId: row.id,
          scope: scope.id,
          version: scope.key_version
        })
        holdKey(scopeKeyId(scope.id), key)
      } catch {
        key = null
      }
    }
    if (!key) continue
    const packed = wrapToHex(
      wrapKeyToDevice({
        key,
        devicePublicKey: live.publicKey,
        mediaBrainId: row.id,
        scope: scope.id,
        version: scope.key_version
      })
    )
    scopeWraps.push({
      scope: scope.id,
      key_version: scope.key_version,
      eph_pub: packed.eph_pub,
      nonce: packed.nonce,
      ciphertext: packed.ciphertext
    })
  }
  const who = actor(folder)
  const finished = postReclaimFinish({
    userData: userData(),
    token,
    signature: sig.toString('hex'),
    kind: opts.passphrase ? 'passphrase' : 'recovery',
    devicePublicKey: live.publicKey.toString('hex'),
    deviceId: live.fingerprint,
    wrap: deviceWrap,
    scopeWraps,
    emailHasPbt: Boolean(who.token && who.token.startsWith('pbt_'))
  })
  if (finished.status !== 200) {
    return { ok: false, fingerprint: '', detail: 'That computer could not be opened.', status: finished.status }
  }
  upsertWrap(userData(), row.id, {
    scope: 'brain',
    key_version: row.brain_key_version,
    eph_pub: deviceWrap.eph_pub,
    nonce: deviceWrap.nonce,
    ciphertext: deviceWrap.ciphertext
  })
  for (const sw of scopeWraps) {
    upsertWrap(userData(), row.id, {
      scope: sw.scope,
      key_version: sw.key_version,
      eph_pub: sw.eph_pub,
      nonce: sw.nonce,
      ciphertext: sw.ciphertext
    })
  }
  if (finished.seatToken?.startsWith('pms_')) {
    writePmsSeat(
      userData(),
      {
        email: String(opts.email || '').toLowerCase(),
        role: 'owner',
        token: finished.seatToken,
        mediaBrainId: row.id
      },
      safe()
    )
  }
  return { ok: true, fingerprint: live.fingerprint, detail: 'This computer can open files here now.' }
}

export function mediaWrapPassphrase(opts: {
  folder: string
  signature?: string
  kind?: string
  email?: string
  code?: string
  recovery?: string
  passphrase?: string
}): { status: number; body: Record<string, unknown> } {
  const row = brainForFolder(String(opts.folder || ''))
  if (!row) return { status: 404, body: { error: 'not_found' } }
  if (opts.email && opts.code && !opts.signature && !opts.recovery) {
    return postWrapPassphrase({
      userData: userData(),
      mediaBrainId: row.id,
      email: opts.email,
      code: opts.code
    })
  }
  if (!opts.recovery || !opts.passphrase) {
    return postWrapPassphrase({
      userData: userData(),
      mediaBrainId: row.id,
      signature: opts.signature,
      kind: opts.kind,
      wrap: row.passphrase_wrap,
      proofPublicKey: row.passphrase_proof,
      salt: row.passphrase_salt,
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P
    })
  }
  const raw = parseRecoveryKey(opts.recovery)
  const brainKey = unwrapBrainKeyWithRecovery({
    wrap: { wrap: Buffer.from(row.recovery_wrap, 'hex'), proofPublicKey: Buffer.from(row.recovery_proof, 'hex') },
    recoveryKey: raw,
    mediaBrainId: row.id
  })
  const next = wrapBrainKeyWithPassphrase({ brainKey, passphrase: opts.passphrase, mediaBrainId: row.id })
  const data = signedPayload('wrap-passphrase', row)
  const sig = opts.signature ? Buffer.from(opts.signature, 'hex') : signWithProof(raw, RECOVERY_INFO(row.id), data)
  return postWrapPassphrase({
    userData: userData(),
    mediaBrainId: row.id,
    signature: sig.toString('hex'),
    kind: 'recovery',
    wrap: next.wrap.toString('hex'),
    proofPublicKey: next.proofPublicKey.toString('hex'),
    salt: next.salt.toString('hex'),
    N: next.N,
    r: next.r,
    p: next.p
  })
}

export function mediaRotateWithProof(opts: {
  folder: string
  signature: string
}): { status: number; body: Record<string, unknown> } {
  const row = brainForFolder(String(opts.folder || ''))
  if (!row) return { status: 404, body: { error: 'not_found' } }
  return refuseBrainKeyProof({
    userData: userData(),
    mediaBrainId: row.id,
    signature: opts.signature,
    kind: 'rotate'
  })
}

export function attemptRotateScope(folder: string): { status: number; error?: string } {
  const row = brainForFolder(String(folder || ''))
  if (!row) return { status: 404, error: 'missing' }
  if (row.brain_rotation_pending) return { status: 423, error: ROTATION_PENDING }
  const mem = store()
  const scope = mem.scopes.find((s) => s.media_brain_id === row.id)
  if (!scope) return { status: 404, error: 'missing' }
  const oldKey = ensureProjectKeyInMemory(row, scope.id, scope.key_version)
  if (!oldKey) return { status: 403, error: 'forbidden' }
  const newKey = createScopeKey()
  const keep = mem.devices.filter((d) => d.media_brain_id === row.id && d.status === 'approved')
  rotateProjectScope({
    mem,
    row,
    scope,
    oldKey,
    newKey,
    keepDevices: keep,
    ownerUserData: userData(),
    ownerDeviceId: ownerDevice(row)?.id
  })
  holdKey(scopeKeyId(scope.id), newKey)
  return { status: 200 }
}

export function addMediaMember(opts: {
  folder: string
  email: string
  role: string
  status?: string
  seatKind?: 'full' | 'project'
  roots?: string[]
}): { ok: true } {
  const row = brainForFolder(String(opts.folder || ''))
  if (!row) throw new Error('Turn on storage first.')
  const email = String(opts.email || '').trim().toLowerCase()
  store().seats.push({
    id: randomUUID(),
    media_brain_id: row.id,
    email,
    role: String(opts.role || 'team'),
    roots: opts.roots || [],
    status: String(opts.status || 'active'),
    kind: 'pms'
  })
  if (opts.status === 'revoked' || opts.seatKind) {
    store().devices.push({
      id: randomUUID(),
      media_brain_id: row.id,
      email,
      fingerprint: randomBytes(4).toString('hex'),
      public_key: randomBytes(32).toString('hex'),
      seat_kind: opts.seatKind || 'full',
      seat_id: email,
      roots: opts.roots || [],
      status: opts.status === 'revoked' ? 'revoked' : 'approved'
    })
  }
  return { ok: true }
}

export function enrollFullBrainMac(opts: { folder: string; email: string; deviceUserData?: string }): {
  ok: true
  deviceId: string
  fingerprint: string
} {
  const row = brainForFolder(String(opts.folder || ''))
  if (!row) throw new Error('Turn on storage first.')
  const brainKey = ensureBrainKeyInMemory(row)
  if (!brainKey) throw new Error('This Mac does not have the storage key in memory. Turn storage on again.')
  const live = ensureDeviceKey(opts.deviceUserData || userData(), row.id, safe())
  const packed = wrapToHex(
    wrapKeyToDevice({
      key: brainKey,
      devicePublicKey: live.publicKey,
      mediaBrainId: row.id,
      scope: 'brain',
      version: row.brain_key_version
    })
  )
  const mem = store()
  mem.devices.push({
    id: live.fingerprint,
    media_brain_id: row.id,
    email: String(opts.email || '').toLowerCase(),
    fingerprint: live.fingerprint,
    public_key: live.publicKey.toString('hex'),
    seat_kind: 'full',
    seat_id: live.fingerprint,
    roots: [],
    status: 'approved'
  })
  mem.wraps.push({
    id: randomUUID(),
    media_brain_id: row.id,
    scope: 'brain',
    key_version: row.brain_key_version,
    target: 'device',
    device_id: live.fingerprint,
    eph_pub: packed.eph_pub,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  })
  upsertWrap(opts.deviceUserData || userData(), row.id, {
    scope: 'brain',
    key_version: row.brain_key_version,
    eph_pub: packed.eph_pub,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  })
  for (const scope of mem.scopes.filter((s) => s.media_brain_id === row.id)) {
    const key = ensureProjectKeyInMemory(row, scope.id, scope.key_version)
    if (!key) continue
    const sw = wrapToHex(
      wrapKeyToDevice({
        key,
        devicePublicKey: live.publicKey,
        mediaBrainId: row.id,
        scope: scope.id,
        version: scope.key_version
      })
    )
    mem.wraps.push({
      id: randomUUID(),
      media_brain_id: row.id,
      scope: scope.id,
      key_version: scope.key_version,
      target: 'device',
      device_id: live.fingerprint,
      eph_pub: sw.eph_pub,
      nonce: sw.nonce,
      ciphertext: sw.ciphertext
    })
  }
  return { ok: true, deviceId: live.fingerprint, fingerprint: live.fingerprint }
}

export function mintPmsInvite(opts: { folder: string; email: string; role?: string }): {
  status: number
  body: Record<string, unknown>
  code?: string
} {
  const who = actor(String(opts.folder || ''))
  const row = brainForFolder(String(opts.folder || ''))
  if (!row) return { status: 404, body: { error: 'not_found' } }
  const pmsBrain = store().seats.some((s) => s.media_brain_id === row.id && s.kind === 'pms')
  const result = postMediaInvite({
    userData: userData(),
    mediaBrainId: row.id,
    email: opts.email,
    role: opts.role,
    builderRole: who.role === 'scout' ? 'scout' : 'owner',
    pmsBrain
  })
  if (result.code) {
    recordMintedInvite({ folder: opts.folder, email: opts.email, roots: [], role: opts.role })
  }
  return result
}

export function redeemOwnerEmailCode(opts: { email: string; folder: string }): {
  status: number
  kind: 'pbt_' | 'pms_' | ''
} {
  postMediaEmailCode({ userData: userData(), email: opts.email })
  const token = actor(opts.folder).token || seatTokenForFolder(opts.folder)
  if (token.startsWith('pbt_')) return { status: 200, kind: 'pbt_' }
  if (token.startsWith('pms_')) return { status: 200, kind: 'pms_' }
  return { status: 403, kind: '' }
}

export function wrapSnapshot(folder: string): { passphrase: string; recovery: string; brainVersion: number } | null {
  const row = brainForFolder(String(folder || ''))
  if (!row) return null
  const snap = wrapBytesSnapshot(row)
  return { ...snap, brainVersion: row.brain_key_version }
}

export { signedPayload, refuseBrainKeyProof }
