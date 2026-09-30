import { randomBytes, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, dialog, safeStorage } from 'electron'
import { canTurnOnGithubSync } from '../../shared/contracts.ts'
import {
  MEDIA_JOIN_SIGN_IN,
  MEDIA_JOIN_WAIT,
  MEDIA_LIBRARY_FAIL,
  MEDIA_LIBRARY_NOT_YET,
  MEDIA_NEEDS_NET,
  MEDIA_NOT_APPROVED,
  MEDIA_OFF_KEYLESS,
  MEDIA_OFF_OTHER,
  MEDIA_OFF_OWNER,
  MEDIA_ON,
  MEDIA_OPEN_FAIL,
  MEDIA_REMOVED,
  MEDIA_UPLOADS_PAUSED,
  MEDIA_WRONG_PROJECT,
  macLabel,
  macLabelFromHostname,
  mediaUsedLine,
  shouldShowStorageAsk,
  type MediaAddResult,
  type MediaEnableResult,
  type MediaLibraryFile,
  type MediaLibraryResult,
  type MediaStatus,
  type MediaWaiting
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
  KEY_UNLOCK_FAIL,
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
import { sealedPassphraseWrap, type LivePassphraseWrap } from './passphrase-wrap.ts'
import { recordMintedInvite as writeMintedInvite, readMintedInvites } from './minted.ts'
import { cleanMediaTitle, mediaId8, readPointer, writePointer } from './pointer.ts'
import { readWrapsFile, upsertWrap } from './wraps-file.ts'
import { assertPassphrase, generatePassphrase } from './passphrase.ts'
import { isMediaDryRun } from './transport.ts'
import { hexBuf, mediaLiveGet, mediaLiveJson, mediaLivePut } from './live-client.ts'
import { liveSnapForFolder, readLiveSnap, rowFromLiveSnap, writeLiveSnap } from './live-state.ts'
import { isBuilderRole, joinReady, missingWraps, seatWrapPlan, type LiveScope } from './seat-wraps.ts'
import {
  MEDIA_BRAINS_PATH,
  MEDIA_DEVICES_PATH,
  MEDIA_OBJECTS_PATH,
  MEDIA_RECLAIM_FINISH_PATH,
  MEDIA_RECLAIM_START_PATH,
  MEDIA_SCOPES_PATH,
  MEDIA_STATE_PATH,
  MEDIA_UPLOADS_PATH,
  MEDIA_WRAP_PASSPHRASE_PATH,
  MEDIA_WRAPS_PATH,
  wrapProofMessage
} from './worker-shapes.ts'
import { dumpMemoryMediaStore, memoryMediaStore, type MediaBrainRow, type MediaDeviceRow } from './store.ts'
import { readMediaConfig, removeMediaConfig, writeMediaConfig } from './media-config.ts'
import { EXISTS_DETAIL, NO_BRAIN_DETAIL, conflictBrainId, reclaimStartOutcome } from './enable-flow.ts'
import { dropPmsSeat, readAnyPmsSeat, readPmsSeat, writePmsSeat } from './pms-seats.ts'
import {
  postMediaBrainsClaim,
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
// Proof material for the live passphrase or recovery wrap, so a new passphrase can be signed for. Memory only.
const proofs = new Map<string, { ikm: Buffer; info: string }>()

function holdProof(mediaBrainId: string, ikm: Buffer, info: string): void {
  proofs.get(mediaBrainId)?.ikm.fill(0)
  proofs.set(mediaBrainId, { ikm, info })
}
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
  if (!isMediaDryRun()) {
    const id = readMediaConfig(folder)?.mediaBrainId || liveSnapForFolder(userData(), folder)?.mediaBrainId
    if (!id) return undefined
    const snap = readLiveSnap(userData(), id)
    if (snap) return rowFromLiveSnap({ ...snap, folder }, userData())
    return rowFromLiveSnap(
      {
        mediaBrainId: id,
        deviceId: '',
        bucket: '',
        folder,
        bucketStatus: 'off',
        capBytes: null,
        usedBytes: 0
      },
      userData()
    )
  }
  const on = store().brains.filter((b) => b.status === 'on')
  const hit = on.find((b) => b.folder === folder)
  if (hit) return hit
  const cfg = readMediaConfig(folder)
  if (cfg) return on.find((b) => b.id === cfg.mediaBrainId)
  return undefined
}

function liveDeviceId(mediaBrainId: string): string {
  return readLiveSnap(userData(), mediaBrainId)?.deviceId || ''
}

function wrapLive(w: { ephPub: Buffer; nonce: Buffer; ciphertext: Buffer }): {
  ephPub: string
  nonce: string
  ciphertext: string
} {
  return { ephPub: hexBuf(w.ephPub), nonce: hexBuf(w.nonce), ciphertext: hexBuf(w.ciphertext) }
}

function canTurnOnStorage(who: MediaActor, folder: string): boolean {
  const roster = roleForKeylessWrite(folder)
  if (roster) return canTurnOnGithubSync(roster, false)
  if (who.token) return canTurnOnGithubSync(who.role, who.joe)
  if (who.hmac) return false
  return Boolean(who.email)
}

/** HMAC / Ads2AI project seats resolve through media_brains.hq_repo only. Do not re-read the worker HqRepo binding. */
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
  if (n.endsWith('.mp4') || n.endsWith('.m4v')) return 'video/mp4'
  if (n.endsWith('.mkv')) return 'video/x-matroska'
  if (n.endsWith('.avi')) return 'video/x-msvideo'
  if (n.endsWith('.heic')) return 'image/heic'
  if (n.endsWith('.heif')) return 'image/heif'
  if (n.endsWith('.avif')) return 'image/avif'
  if (n.endsWith('.bmp')) return 'image/bmp'
  if (n.endsWith('.tif') || n.endsWith('.tiff')) return 'image/tiff'
  if (n.endsWith('.mp3')) return 'audio/mpeg'
  if (n.endsWith('.m4a')) return 'audio/mp4'
  if (n.endsWith('.wav')) return 'audio/wav'
  if (n.endsWith('.aac')) return 'audio/aac'
  if (n.endsWith('.flac')) return 'audio/flac'
  if (n.endsWith('.ogg') || n.endsWith('.oga')) return 'audio/ogg'
  if (n.endsWith('.opus')) return 'audio/opus'
  if (n.endsWith('.aif') || n.endsWith('.aiff')) return 'audio/aiff'
  if (n.endsWith('.pdf')) return 'application/pdf'
  if (n.endsWith('.zip')) return 'application/zip'
  return 'application/octet-stream'
}

/** Live storage is on for this folder and this Mac may add files (owner or scout, not a project seat). */
export function mediaAutoStoreReady(folder: string): boolean {
  if (isMediaDryRun()) return false
  const cfg = readMediaConfig(folder)
  if (!cfg || !readLiveSnap(userData(), cfg.mediaBrainId)?.deviceId) return false
  const who = actor(folder)
  if (!who.token || who.hmac || who.role === 'project') return false
  return canTurnOnGithubSync(who.role, who.joe)
}

/** A user turned something on, so skip the one-minute pause a refusal set. */
function kickAutoStore(folder: string): void {
  void import('./auto-store.ts').then((m) => m.maybeAutoStore(folder, { force: true })).catch(() => undefined)
}

export async function mediaStatus(folder: string): Promise<MediaStatus> {
  const routes = await routesLive()
  if (!isMediaDryRun()) return liveMediaStatus(folder, routes)
  const who = actor(folder)
  const row = brainForFolder(folder)
  const on = Boolean(row) && (isMediaDryRun() || Boolean(who.token))
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
          label: d.label || '',
          fingerprint: d.fingerprint,
          project: projectLabel(d.roots),
          mine: false
        }))
    : []
  const others = on
    ? store()
        .devices.filter(
          (d) => d.media_brain_id === row?.id && d.status === 'approved' && d.fingerprint
        )
        .map((d) => ({
          deviceId: d.id,
          name: d.email.split('@')[0] || 'Mac',
          label: d.label || (d.fingerprint === fingerprint ? thisMacLabel() : ''),
          fingerprint: d.fingerprint,
          project: projectLabel(d.roots),
          mine: d.fingerprint === fingerprint
        }))
    : []
  const base: MediaStatus = {
    routes,
    on,
    joining: false,
    hasSeatToken: Boolean(who.token),
    fingerprint,
    usedBytes: row?.used_bytes || 0,
    capBytes: row ? row.cap_bytes : null,
    bucketStatus: row?.bucket_status || 'off',
    waiting: waiting.map((w) => ({ ...w, project: w.project || 'brain' })),
    others: others.map((w) => ({ ...w, project: w.project || 'brain' })),
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

type LivePhase = 'none' | 'sign_in' | 'waiting' | 'on'

type LiveJoin = {
  phase: LivePhase
  /** The token that reached this brain's storage. Empty when none did. */
  token?: string
  wiped?: boolean
  row?: MediaBrainRow
  state?: Record<string, unknown>
}

type LiveDevice = {
  id: string
  email: string
  label: string
  fingerprint: string
  status: string
  publicKey: string
  role: string
  roots: string[] | null
  held: { scope: string; keyVersion: number }[]
}

const joins = new Map<string, Promise<LiveJoin>>()
const fastJoinPolls = new Set<string>()
const linkTried = new Set<string>()
const FAST_JOIN_MS = 2000
const FAST_JOIN_TICKS = 30

function isBuilderActor(who: MediaActor): boolean {
  return Boolean(who.token) && !who.hmac && who.role !== 'project' && canTurnOnGithubSync(who.role, who.joe)
}

function liveScopes(st: Record<string, unknown>): LiveScope[] {
  const raw = Array.isArray(st.scopes) ? (st.scopes as Record<string, unknown>[]) : []
  return raw
    .map((x) => ({ id: String(x.id || ''), root: String(x.root || ''), keyVersion: Number(x.keyVersion || 1) }))
    .filter((x) => x.id)
}

function liveDevices(st: Record<string, unknown>): LiveDevice[] {
  const raw = Array.isArray(st.devices) ? (st.devices as Record<string, unknown>[]) : []
  return raw
    .map((d) => ({
      id: String(d.id || ''),
      email: String(d.email || ''),
      label: String(d.label || ''),
      fingerprint: String(d.fingerprint || ''),
      status: String(d.status || ''),
      publicKey: String(d.publicKey || ''),
      role: String(d.role || d.seatKind || ''),
      roots: Array.isArray(d.roots) ? d.roots.map(String) : null,
      held: Array.isArray(d.held)
        ? (d.held as Record<string, unknown>[]).map((h) => ({
            scope: String(h.scope || ''),
            keyVersion: Number(h.keyVersion || 0)
          }))
        : []
    }))
    .filter((d) => d.id)
}

function waitingRow(d: LiveDevice, mine = false): MediaWaiting {
  return {
    deviceId: d.id,
    name: d.email.split('@')[0] || 'Mac',
    // Older Macs registered as plain "Mac"; the fingerprint says more than that.
    label: d.label && d.label !== 'Mac' ? d.label : '',
    fingerprint: d.fingerprint,
    project: d.roots?.length ? d.roots.map((r) => r.replace(/\/$/, '')).join(', ') : 'brain',
    mine
  }
}

/** This Mac's name as other computers see it: the hostname without .local. */
function thisMacLabel(): string {
  try {
    return macLabelFromHostname(hostname())
  } catch {
    return 'Mac'
  }
}

/**
 * Normal sign-in is enough: register this Mac with the brain's storage and pull whatever keys an owner or
 * scout Mac has wrapped to it. One run per folder at a time.
 */
function liveSilentJoin(folder: string): Promise<LiveJoin> {
  const hit = joins.get(folder)
  if (hit) return hit
  const run = liveSilentJoinOnce(folder)
    .catch((): LiveJoin => {
      const id = readMediaConfig(folder)?.mediaBrainId || liveSnapForFolder(userData(), folder)?.mediaBrainId
      if (!id) return { phase: 'none' }
      // Offline: a Mac that already joined keeps working from its local keys.
      const row = brainForFolder(folder)
      const token = readPmsSeat(userData(), id, safe())?.token || actor(folder).token
      return readLiveSnap(userData(), id)?.deviceId ? { phase: 'on', row, token } : { phase: 'waiting' }
    })
    .finally(() => joins.delete(folder))
  joins.set(folder, run)
  return run
}

async function liveSilentJoinOnce(folder: string): Promise<LiveJoin> {
  const who = actor(folder)
  const known = readMediaConfig(folder)?.mediaBrainId || liveSnapForFolder(userData(), folder)?.mediaBrainId || ''
  if (!who.token) return { phase: known ? 'sign_in' : 'none' }
  let deviceId = known ? liveDeviceId(known) : ''
  // A brain made with an email code is not linked to Plyntr seats yet, so the storage seat on this Mac is the way in.
  const tokens = [who.token]
  const pmsToken = known ? readPmsSeat(userData(), known, safe())?.token || '' : ''
  if (pmsToken && pmsToken !== who.token) tokens.push(pmsToken)
  let token = who.token
  let st = { status: 0, json: {} as Record<string, unknown> }
  for (const t of tokens) {
    token = t
    st = await mediaLiveJson({ method: 'GET', path: MEDIA_STATE_PATH, token, deviceId: deviceId || undefined })
    if (st.status !== 401 && st.status !== 404) break
  }
  if (st.status === 410) {
    if (known) mediaWipeBrain(known, userData())
    return { phase: 'none', wiped: true }
  }
  if (st.status !== 200) return { phase: known ? 'waiting' : 'none' }
  const id = String(st.json.id || '')
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return { phase: known ? 'waiting' : 'none' }
  if (id !== known) deviceId = liveDeviceId(id)
  const live = ensureDeviceKey(userData(), id, safe())
  if (!deviceId) {
    const reg = await mediaLiveJson({
      method: 'POST',
      path: MEDIA_DEVICES_PATH,
      token,
      body: { publicKey: hexBuf(live.publicKey), fingerprint: live.fingerprint, label: thisMacLabel() }
    })
    if (reg.status === 410) {
      mediaWipeBrain(id, userData())
      return { phase: 'none', wiped: true }
    }
    // 409 means this Mac is already registered; its id comes back either way.
    deviceId = reg.status === 200 || reg.status === 409 ? String(reg.json.id || '') : ''
    if (!deviceId) return { phase: 'waiting' }
    st = await mediaLiveJson({ method: 'GET', path: MEDIA_STATE_PATH, token, deviceId })
    if (st.status === 410) {
      mediaWipeBrain(id, userData())
      return { phase: 'none', wiped: true }
    }
    if (st.status !== 200) return { phase: 'waiting' }
  }
  if (token.startsWith('pms_') && who.brainId && st.json.plyntrBrainId === '' && !linkTried.has(id)) {
    // Owner or scout Mac: link the brain once so HQ seats on it can join with their normal sign-in.
    linkTried.add(id)
    await mediaLiveJson({
      method: 'POST',
      path: `${MEDIA_BRAINS_PATH}/${id}/link`,
      token,
      deviceId,
      body: { plyntrBrainId: who.brainId }
    }).catch(() => undefined)
  }
  const brainKeyVersion = Number(st.json.brainKeyVersion || 1)
  const prev = readLiveSnap(userData(), id)
  writeLiveSnap(userData(), {
    mediaBrainId: id,
    deviceId,
    bucket: prev?.bucket || '',
    folder,
    bucketStatus: st.json.bucketStatus === 'on' ? 'on' : 'off',
    capBytes: st.json.capBytes == null ? null : Number(st.json.capBytes),
    usedBytes: Number(st.json.usedBytes || 0),
    brainKeyVersion
  })
  const wraps = Array.isArray(st.json.wraps) ? (st.json.wraps as Record<string, unknown>[]) : []
  for (const w of wraps) {
    if (!w.scope || !w.ciphertext) continue
    upsertWrap(userData(), id, {
      scope: String(w.scope),
      key_version: Number(w.keyVersion || 1),
      eph_pub: String(w.ephPub || ''),
      nonce: String(w.nonce || ''),
      ciphertext: String(w.ciphertext || '')
    })
  }
  const ready = joinReady({
    builder: !who.hmac && isBuilderRole(who.role),
    wraps: readWrapsFile(userData(), id),
    scopes: liveScopes(st.json),
    brainKeyVersion
  })
  if (!ready) startFastJoinPoll(folder)
  return { phase: ready ? 'on' : 'waiting', token, row: brainForFolder(folder), state: st.json }
}

/** Every 2s for about a minute after a Mac starts waiting, then the 10-minute state poll takes over. */
function startFastJoinPoll(folder: string): void {
  if (fastJoinPolls.has(folder)) return
  fastJoinPolls.add(folder)
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
    void liveSilentJoin(folder).then((j) => {
      if (j.phase === 'on' || j.phase === 'none' || ticks >= FAST_JOIN_TICKS) stop()
    })
  }, FAST_JOIN_MS)
  const stop = () => {
    clearInterval(timer)
    fastJoinPolls.delete(folder)
  }
  if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()
}

/**
 * From a Mac that holds the keys, wrap to every Mac on this brain what its seat allows and it does not hold
 * yet. Owner and scout get the brain key; team and project never do. Returns the device ids that got wraps.
 */
async function liveAutoWrap(opts: {
  row: MediaBrainRow
  token: string
  state: Record<string, unknown>
  only?: string
}): Promise<string[]> {
  const me = liveDeviceId(opts.row.id)
  const brainKeyVersion = Number(opts.state.brainKeyVersion || opts.row.brain_key_version || 1)
  const scopes = liveScopes(opts.state)
  const wrapped: string[] = []
  for (const d of liveDevices(opts.state)) {
    if (d.id === me || (opts.only && d.id !== opts.only)) continue
    if (d.status !== 'pending' && d.status !== 'approved') continue
    if (!/^[0-9a-f]{64}$/i.test(d.publicKey)) continue
    const devicePublicKey = Buffer.from(d.publicKey, 'hex')
    const rows: Record<string, unknown>[] = []
    for (const p of missingWraps(seatWrapPlan({ role: d.role, roots: d.roots }, scopes, brainKeyVersion), d.held)) {
      const key =
        p.scope === 'brain'
          ? p.keyVersion === opts.row.brain_key_version
            ? ensureBrainKeyInMemory(opts.row)
            : null
          : ensureProjectKeyInMemory(opts.row, p.scope, p.keyVersion)
      if (!key) continue
      const w = wrapKeyToDevice({ key, devicePublicKey, mediaBrainId: opts.row.id, scope: p.scope, version: p.keyVersion })
      rows.push({ deviceId: d.id, scope: p.scope, keyVersion: p.keyVersion, ...wrapLive(w) })
    }
    if (!rows.length) continue
    const res = await mediaLiveJson({ method: 'POST', path: MEDIA_WRAPS_PATH, token: opts.token, deviceId: me, body: { wraps: rows } })
    if (res.status === 200) wrapped.push(d.id)
  }
  return wrapped
}

async function liveMediaStatus(folder: string, routes: boolean): Promise<MediaStatus> {
  const who = actor(folder)
  const join: LiveJoin = routes ? await liveSilentJoin(folder) : { phase: 'none' }
  const row = join.row || brainForFolder(folder)
  let fingerprint = ''
  if (row) {
    try {
      fingerprint = ensureDeviceKey(userData(), row.id, safe()).fingerprint
    } catch {
      fingerprint = ''
    }
  }
  const snap = row ? readLiveSnap(userData(), row.id) : null
  const base: MediaStatus = {
    routes,
    on: false,
    joining: false,
    hasSeatToken: Boolean(who.token),
    fingerprint,
    usedBytes: snap?.usedBytes || 0,
    capBytes: snap?.capBytes ?? null,
    bucketStatus: snap?.bucketStatus || 'off',
    waiting: [],
    others: [],
    projects: listMediaRoots(folder),
    detail: ''
  }
  if (!routes) return base
  if (join.phase === 'waiting' || join.phase === 'sign_in') {
    return { ...base, joining: true, detail: join.phase === 'sign_in' ? MEDIA_JOIN_SIGN_IN : MEDIA_JOIN_WAIT }
  }
  if (join.phase === 'none') {
    const detail = canTurnOnStorage(who, folder) ? MEDIA_OFF_OWNER : who.token ? MEDIA_OFF_OTHER : MEDIA_OFF_KEYLESS
    return { ...base, detail }
  }
  if (join.state && join.token && row && isBuilderActor(who)) {
    const wrapped = await liveAutoWrap({ row, token: join.token, state: join.state }).catch(() => [] as string[])
    const devices = liveDevices(join.state)
    const me = liveDeviceId(row.id)
    base.waiting = devices.filter((d) => d.status === 'pending' && !wrapped.includes(d.id)).map((d) => waitingRow(d))
    base.others = devices
      .filter((d) => d.status === 'approved' && d.fingerprint)
      .map((d) => waitingRow(d, d.id === me))
  }
  const on: MediaStatus = { ...base, on: true }
  on.detail = mediaUsedLine(on)
  return on
}

/** Session start, window focus, and the 10-minute poll: join if needed, then wrap for anyone waiting. */
export async function liveMediaCheckIn(folder: string): Promise<{ status: number; wiped: boolean }> {
  const join = await liveSilentJoin(folder)
  if (join.wiped) return { status: 410, wiped: true }
  if (join.phase === 'none') return { status: 204, wiped: false }
  if (join.phase !== 'on') return { status: 202, wiped: false }
  const who = actor(folder)
  if (join.state && join.token && join.row && isBuilderActor(who)) {
    await liveAutoWrap({ row: join.row, token: join.token, state: join.state }).catch(() => [])
  }
  return { status: 200, wiped: false }
}

/** Settings Allow: the manual backup for auto-wrap, same live path. */
export async function liveMediaAllow(opts: { folder: string; deviceId: string }): Promise<{ ok: true; detail: string }> {
  const folder = String(opts.folder || '')
  const who = actor(folder)
  if (!isBuilderActor(who)) throw new Error('Only an owner or scout can allow a computer.')
  const join = await liveSilentJoin(folder)
  if (join.phase !== 'on' || !join.row || !join.state || !join.token) throw new Error('Turn on storage first.')
  const wrapped = await liveAutoWrap({ row: join.row, token: join.token, state: join.state, only: String(opts.deviceId || '') })
  if (!wrapped.length) throw new Error('Nothing this Mac can share with that computer yet.')
  void liveMediaCheckIn(folder).catch(() => undefined)
  return { ok: true, detail: 'That computer can open files here now.' }
}

/** Owner or scout names a computer on this brain, this Mac included. */
export async function liveRenameDevice(opts: { folder: string; deviceId: string; label: string }): Promise<{
  ok: boolean
  detail: string
}> {
  const folder = String(opts.folder || '')
  if (!isBuilderActor(actor(folder))) throw new Error('Only an owner or scout can name a computer.')
  const label = macLabel(opts.label)
  if (!label) return { ok: false, detail: 'Type a name for that computer.' }
  const join = await liveSilentJoin(folder)
  if (join.phase !== 'on' || !join.row || !join.token) throw new Error('Turn on storage first.')
  const res = await mediaLiveJson({
    method: 'PATCH',
    path: `${MEDIA_DEVICES_PATH}/${encodeURIComponent(String(opts.deviceId || ''))}`,
    token: join.token,
    deviceId: liveDeviceId(join.row.id),
    body: { label }
  })
  if (res.status !== 200) return { ok: false, detail: 'Could not rename that computer.' }
  return { ok: true, detail: `Saved the name ${label}.` }
}

/**
 * Remove one computer from a Mac that still has storage. No passphrase: the worker blocks that one device
 * and the brain key stays the same. Emergency restore is the path when no computer with storage is left.
 */
export async function liveRevokeDevice(opts: { folder: string; deviceId: string }): Promise<{
  ok: true
  detail: string
  kind: string
}> {
  const folder = String(opts.folder || '')
  if (!isBuilderActor(actor(folder))) throw new Error('Only an owner or scout can remove a computer.')
  const join = await liveSilentJoin(folder)
  if (join.phase !== 'on' || !join.row || !join.token) throw new Error('Turn on storage first.')
  const target = String(opts.deviceId || '')
  const me = liveDeviceId(join.row.id)
  if (!target) throw new Error('Pick a computer.')
  if (target === me) throw new Error('This is the computer you are on. Remove it from another computer.')
  const res = await mediaLiveJson({
    method: 'POST',
    path: `${MEDIA_DEVICES_PATH}/${encodeURIComponent(target)}/revoke`,
    token: join.token,
    deviceId: me,
    body: {}
  })
  if (res.status === 403) throw new Error('Only an owner can remove an owner or scout computer.')
  if (res.status === 404) throw new Error('That computer is not on this brain.')
  if (res.status !== 200) throw new Error('Could not remove that computer.')
  return { ok: true, detail: 'That computer is removed. It cannot open files here now.', kind: String(res.json.mode || '') }
}

/** Emergency restore: email code plus the six words or the recovery key. */
export async function liveReclaimOnThisMac(opts: {
  folder: string
  email: string
  code: string
  passphrase?: string
  recovery?: string
}): Promise<MediaEnableResult> {
  const folder = String(opts.folder || '')
  const who = actor(folder)
  if (!canTurnOnStorage(who, folder) || who.hmac || who.role === 'project') throw new Error(NO_BUILDER)
  const id = readMediaConfig(folder)?.mediaBrainId || liveSnapForFolder(userData(), folder)?.mediaBrainId
  if (!id) throw new Error('Turn on storage first.')
  return liveReconnect({
    folder,
    mediaBrainId: id,
    email: String(opts.email || who.email || '').trim().toLowerCase(),
    code: String(opts.code || '').trim(),
    passphrase: opts.passphrase,
    recoveryKey: opts.recovery
  })
}

export async function liveRequestMediaCode(email: string): Promise<boolean> {
  const want = String(email || '').trim().toLowerCase()
  if (!want.includes('@')) return false
  try {
    await mintStorageCode(want)
    return true
  } catch {
    return false
  }
}

export const MEDIA_ADD_BY_SEAT = 'Add them to this brain. Plyntr storage comes with their seat.'

/** Add a person on a storage-only brain. A brain linked to Plyntr adds people through its seats. */
export async function liveInvitePerson(opts: { folder: string; email: string; role?: string }): Promise<{
  ok: boolean
  detail: string
}> {
  const folder = String(opts.folder || '')
  const who = actor(folder)
  if (!isBuilderActor(who)) throw new Error(NO_BUILDER)
  const row = brainForFolder(folder)
  if (!row) return { ok: false, detail: 'Turn on storage first.' }
  const email = String(opts.email || '').trim().toLowerCase()
  if (!email.includes('@')) return { ok: false, detail: 'Enter their email.' }
  if (who.token.startsWith('pbt_')) return { ok: false, detail: MEDIA_ADD_BY_SEAT }
  const res = await mediaLiveJson({
    method: 'POST',
    path: '/v1/media/invites',
    token: who.token,
    deviceId: liveDeviceId(row.id),
    body: { email, name: email, role: opts.role || 'team' }
  })
  if (res.status === 403) return { ok: false, detail: MEDIA_ADD_BY_SEAT }
  if (res.status !== 200) return { ok: false, detail: 'Could not add that person.' }
  // A scout Mac with Brain open wraps to them within seconds of them joining; start this one now.
  void liveMediaCheckIn(folder).catch(() => undefined)
  return { ok: true, detail: res.json.emailed ? 'Invite sent.' : 'Invite made, but the email did not go out. Try again.' }
}

export async function mediaShouldAsk(opts: { folder: string; role?: string }): Promise<boolean> {
  const folder = String(opts.folder || '')
  const st = await mediaStatus(folder)
  const who = actor(folder)
  const roster = roleForKeylessWrite(folder)
  return shouldShowStorageAsk({
    role: opts.role || who.role || roster,
    joe: who.joe,
    storageOn: st.on || st.joining,
    mediaAsked: mediaAskedFor(folder),
    hasSeatToken: st.hasSeatToken,
    routes: st.routes,
    hasMediaConfig: Boolean(readMediaConfig(folder))
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

async function mintStorageCode(email: string): Promise<void> {
  const minted = await mediaLiveJson({
    method: 'POST',
    path: '/v1/media/codes/email',
    body: { email }
  })
  if (minted.status !== 200) throw new Error('Could not send a storage code.')
}

async function liveReconnect(opts: {
  folder: string
  mediaBrainId: string
  email: string
  code: string
  passphrase?: string
  recoveryKey?: string
}): Promise<MediaEnableResult> {
  const folder = opts.folder
  const recoveryText = String(opts.recoveryKey || '').trim()
  const email = String(opts.email || '').trim().toLowerCase()
  if (!email) throw new Error(NO_SEAT)
  let code = String(opts.code || '').trim()
  if (!code) {
    const minted = await mediaLiveJson({
      method: 'POST',
      path: '/v1/media/codes/email',
      body: { email }
    })
    if (minted.status !== 200) throw new Error('Could not send a storage code.')
    return {
      ok: false,
      fingerprint: '',
      detail:
        'Check your email for a code. Enter it and the six-word passphrase from when you first turned storage on, then turn storage on again.',
      needsCode: true,
      needsPassphrase: true
    }
  }
  if (!opts.passphrase && !recoveryText) {
    return {
      ok: false,
      fingerprint: '',
      detail: 'Type the six-word passphrase from when you first turned storage on, then turn storage on again.',
      needsPassphrase: true
    }
  }
  const live = ensureDeviceKey(userData(), opts.mediaBrainId, safe())
  const start = await mediaLiveJson({
    method: 'POST',
    path: MEDIA_RECLAIM_START_PATH,
    body: {
      email,
      code,
      mediaBrainId: opts.mediaBrainId,
      device: { publicKey: hexBuf(live.publicKey), fingerprint: live.fingerprint, label: thisMacLabel() }
    }
  })
  const outcome = reclaimStartOutcome(start.status)
  if (outcome === 'no_brain') {
    // The code is spent and media.json points at a brain that is gone. Drop it so the next enable creates.
    removeMediaConfig(folder)
    await mintStorageCode(email)
    return { ok: false, fingerprint: '', detail: NO_BRAIN_DETAIL, needsCode: true }
  }
  if (outcome !== 'ok') {
    return { ok: false, fingerprint: '', detail: 'That code did not work.', needsCode: true, needsPassphrase: true }
  }
  const wrapObj = (start.json.passphraseWrap || (start.json.wraps as { passphrase?: unknown } | undefined)?.passphrase) as
    | LivePassphraseWrap
    | undefined
  const salt = Buffer.from(String(wrapObj?.salt || start.json.salt || ''), 'hex')
  const wrap = sealedPassphraseWrap(wrapObj)
  const challengeB64 = String(start.json.challenge || '')
  const challenge = Buffer.from(challengeB64, 'base64')
  const reclaimToken = String(start.json.token || '')
  let brainKey: Buffer | null = null
  let proof: { ikm: Buffer; info: string } | null = null
  if (opts.passphrase) {
    try {
      brainKey = unwrapBrainKeyWithPassphrase({
        wrap: {
          salt,
          N: Number(wrapObj?.N || start.json.N || SCRYPT_N),
          r: Number(wrapObj?.r || start.json.r || SCRYPT_R),
          p: Number(wrapObj?.p || start.json.p || SCRYPT_P),
          wrap,
          proofPublicKey: Buffer.alloc(0)
        },
        passphrase: opts.passphrase,
        mediaBrainId: opts.mediaBrainId
      })
      proof = { ikm: passphraseIkm(opts.passphrase, salt), info: PASSPHRASE_INFO(opts.mediaBrainId) }
    } catch (err) {
      if ((err as Error)?.message !== KEY_UNLOCK_FAIL) throw err
    }
  }
  if (!brainKey && recoveryText) {
    const recObj = (start.json.recoveryWrap || (start.json.wraps as { recovery?: unknown } | undefined)?.recovery) as
      | { wrap?: string }
      | string
      | undefined
    const recHex = typeof recObj === 'string' ? recObj : String(recObj?.wrap || '')
    try {
      const raw = parseRecoveryKey(recoveryText)
      brainKey = unwrapBrainKeyWithRecovery({
        wrap: { wrap: /^[0-9a-f]+$/i.test(recHex) ? Buffer.from(recHex, 'hex') : Buffer.alloc(0), proofPublicKey: Buffer.alloc(0) },
        recoveryKey: raw,
        mediaBrainId: opts.mediaBrainId
      })
      proof = { ikm: raw, info: RECOVERY_INFO(opts.mediaBrainId) }
    } catch {
      brainKey = null
    }
  }
  if (!brainKey || !proof) {
    // Start already used the emailed code, so a retry needs a fresh one.
    return {
      ok: false,
      fingerprint: '',
      detail: recoveryText
        ? `${KEY_UNLOCK_FAIL} Check the passphrase and recovery key.`
        : `${KEY_UNLOCK_FAIL} Check the passphrase.`,
      needsCode: true,
      needsPassphrase: true
    }
  }
  const signature = signWithProof(proof.ikm, proof.info, challenge)
  const deviceWrap = wrapKeyToDevice({
    key: brainKey,
    devicePublicKey: live.publicKey,
    mediaBrainId: opts.mediaBrainId,
    scope: 'brain',
    version: Number(start.json.brainKeyVersion || 1)
  })
  const finish = await mediaLiveJson({
    method: 'POST',
    path: MEDIA_RECLAIM_FINISH_PATH,
    body: {
      token: reclaimToken,
      signature: signature.toString('base64'),
      devicePub: hexBuf(live.publicKey),
      fingerprint: live.fingerprint,
      device: { publicKey: hexBuf(live.publicKey), fingerprint: live.fingerprint, label: thisMacLabel() },
      deviceWrap: wrapLive(deviceWrap)
    }
  })
  const outToken = String(finish.json.token || '')
  if (finish.status !== 200 || (!outToken.startsWith('pms_') && !outToken.startsWith('pbt_'))) {
    brainKey.fill(0)
    proof.ikm.fill(0)
    return {
      ok: false,
      fingerprint: '',
      detail: 'Could not sign this Mac into storage. Check the passphrase.',
      needsCode: true,
      needsPassphrase: true
    }
  }
  holdKey(brainKeyId(opts.mediaBrainId), brainKey)
  holdProof(opts.mediaBrainId, proof.ikm, proof.info)
  const token = outToken
  const deviceId = String(finish.json.deviceId || '')
  const bucket = String(finish.json.bucket || readLiveSnap(userData(), opts.mediaBrainId)?.bucket || '')
  writePmsSeat(
    userData(),
    { email, role: 'owner', token, mediaBrainId: opts.mediaBrainId },
    safe()
  )
  writeLiveSnap(userData(), {
    mediaBrainId: opts.mediaBrainId,
    deviceId,
    bucket,
    folder,
    bucketStatus: (readLiveSnap(userData(), opts.mediaBrainId)?.bucketStatus || 'on') as 'off' | 'on',
    capBytes: readLiveSnap(userData(), opts.mediaBrainId)?.capBytes ?? 5368709120,
    usedBytes: readLiveSnap(userData(), opts.mediaBrainId)?.usedBytes ?? 0
  })
  const packed = wrapToHex(deviceWrap)
  upsertWrap(userData(), opts.mediaBrainId, {
    scope: 'brain',
    key_version: Number(start.json.brainKeyVersion || 1),
    eph_pub: packed.eph_pub,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  })
  writeMediaConfig(folder, opts.mediaBrainId, 'owner')
  return { ok: true, fingerprint: live.fingerprint, detail: 'Plyntr storage is on.' }
}

async function liveEnable(opts: {
  folder: string
  passphrase?: string
  recoveryKey?: string
  email?: string
  code?: string
}): Promise<MediaEnableResult> {
  const folder = String(opts.folder || '')
  const who = actor(folder)
  if (!canTurnOnStorage(who, folder)) throw new Error(NO_BUILDER)
  if (!who.token && !who.email && !opts.email) throw new Error(NO_SEAT)
  if (who.hmac || who.role === 'project') throw new Error(NO_BUILDER)
  // Storage already set up for this brain: this Mac joins on its normal sign-in. Nothing here creates or unwraps.
  const join = await liveSilentJoin(folder)
  if (join.phase === 'on' && join.row) {
    return { ok: true, fingerprint: ensureDeviceKey(userData(), join.row.id, safe()).fingerprint, detail: MEDIA_ON }
  }
  if (join.phase !== 'none') {
    return { ok: false, fingerprint: '', detail: join.phase === 'sign_in' ? MEDIA_JOIN_SIGN_IN : MEDIA_JOIN_WAIT }
  }
  const email = String(opts.email || who.email || '').trim().toLowerCase()
  const pbt = Boolean(who.token && who.token.startsWith('pbt_'))
  let claimedToken = who.token
  if (!pbt) {
    if (!email) throw new Error(NO_SEAT)
    let code = String(opts.code || '').trim()
    if (!code) {
      const minted = await mediaLiveJson({
        method: 'POST',
        path: '/v1/media/codes/email',
        body: { email }
      })
      if (minted.status !== 200) throw new Error('Could not send a storage code.')
      return {
        ok: false,
        fingerprint: '',
        detail: 'Check your email for a code, enter it, then turn storage on again.',
        needsCode: true
      }
    }
    claimedToken = ''
  }
  // First create: a typed passphrase becomes the wrap. Nothing here unwraps.
  const phrase = opts.passphrase ? assertPassphrase(opts.passphrase) : generatePassphrase()
  const mediaBrainId = randomBytes(16).toString('hex')
  const live = ensureDeviceKey(userData(), mediaBrainId, safe())
  const brainKey = createBrainKey()
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
  let hqRepo = ''
  try {
    const hq = await import('../hq-sync.ts')
    hqRepo = hq.hqRepoFromFolder(folder) || ''
  } catch {
    hqRepo = ''
  }
  const body = {
    id: mediaBrainId,
    hqRepo,
    passphraseWrap: {
      salt: hexBuf(passWrap.salt),
      N: passWrap.N,
      r: passWrap.r,
      p: passWrap.p,
      wrap: hexBuf(passWrap.wrap)
    },
    passphraseProofPub: hexBuf(passWrap.proofPublicKey),
    recoveryWrap: { wrap: hexBuf(recWrap.wrap) },
    recoveryProofPub: hexBuf(recWrap.proofPublicKey),
    device: { publicKey: hexBuf(live.publicKey), fingerprint: live.fingerprint, label: thisMacLabel() },
    deviceWrap: wrapLive(deviceWrap)
  }
  const headersToken = pbt ? who.token : undefined
  const claimBody = pbt
    ? body
    : { ...body, email, code: String(opts.code || '').trim(), plyntrBrainId: who.brainId || undefined }
  const created = await mediaLiveJson({
    method: 'POST',
    path: MEDIA_BRAINS_PATH,
    token: headersToken,
    body: claimBody
  })
  if (created.status !== 200) {
    brainKey.fill(0)
    recovery.raw.fill(0)
  }
  if (created.status === 409) {
    // Storage already exists. This Mac joins it like any other; the passphrase stays behind Emergency restore.
    const existingId = conflictBrainId(created.json, mediaBrainId)
    if (existingId) writeMediaConfig(folder, existingId, who.role)
    return { ok: false, fingerprint: '', detail: EXISTS_DETAIL }
  }
  if (created.status !== 200) {
    const err = String(created.json.error || created.status)
    throw new Error(err === 'invalid' ? 'Could not turn on storage.' : `Could not turn on storage (${err}).`)
  }
  const deviceId = String(created.json.deviceId || '')
  const bucket = String(created.json.bucket || '')
  if (!deviceId || !bucket) throw new Error('Could not turn on storage.')
  holdKey(brainKeyId(mediaBrainId), brainKey)
  if (String(created.json.token || '').startsWith('pms_')) {
    writePmsSeat(
      userData(),
      {
        email,
        role: 'owner',
        token: String(created.json.token),
        mediaBrainId
      },
      safe()
    )
    claimedToken = String(created.json.token)
  }
  writeLiveSnap(userData(), {
    mediaBrainId,
    deviceId,
    bucket,
    folder,
    bucketStatus: 'off',
    capBytes: null,
    usedBytes: 0
  })
  const packed = wrapToHex(deviceWrap)
  upsertWrap(userData(), mediaBrainId, {
    scope: 'brain',
    key_version: 1,
    eph_pub: packed.eph_pub,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  })
  writeMediaConfig(folder, mediaBrainId, who.role)
  holdProof(mediaBrainId, passphraseIkm(phrase, passWrap.salt), PASSPHRASE_INFO(mediaBrainId))
  const held = slot(mediaBrainId)
  if (!opts.passphrase) held.passphrase = phrase
  held.recovery = recovery.display
  recovery.raw.fill(0)
  markMediaAsked(folder)
  void claimedToken
  kickAutoStore(folder)
  return { ok: true, fingerprint: live.fingerprint, detail: 'Plyntr storage is on.' }
}

export async function mediaEnable(opts: {
  folder: string
  passphrase?: string
  recoveryKey?: string
  email?: string
  code?: string
}): Promise<MediaEnableResult> {
  const folder = String(opts.folder || '')
  if (!isMediaDryRun()) return liveEnable(opts)
  const who = actor(folder)
  if (!canTurnOnStorage(who, folder)) throw new Error(NO_BUILDER)
  if (!who.token && !who.email && !opts.email) throw new Error(NO_SEAT)
  const existing = brainForFolder(folder)
  if (existing) {
    const st = await mediaStatus(folder)
    return { ok: true, fingerprint: st.fingerprint, detail: 'Plyntr storage is on.' }
  }
  const email = String(opts.email || who.email || '').trim().toLowerCase()
  const pbt = Boolean(who.token && who.token.startsWith('pbt_'))
  let claimedToken = who.token
  if (!pbt) {
    if (!email) throw new Error(NO_SEAT)
    let code = String(opts.code || '').trim()
    if (!code) {
      const minted = postMediaEmailCode({ userData: userData(), email })
      if (minted.status !== 200 || !minted.code) throw new Error('Could not send a storage code.')
      code = minted.code
    }
    const claim = postMediaBrainsClaim({ userData: userData(), email, code })
    if (claim.status === 409) throw new Error('Plyntr storage is already on. Use reclaim on this Mac.')
    if (claim.status !== 200 || !claim.seatToken || !claim.seatToken.startsWith('pms_')) {
      throw new Error('Could not claim storage with that email code.')
    }
    claimedToken = claim.seatToken
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
  const pms = !pbt
  const seatToken = pms ? claimedToken : who.token
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
  return { ok: true, fingerprint: live.fingerprint, detail: 'Plyntr storage is on.' }
}

async function liveSetPassphrase(row: MediaBrainRow, folder: string, pass: string): Promise<{ ok: true }> {
  const brainKey = ensureBrainKeyInMemory(row)
  const proof = proofs.get(row.id)
  if (!brainKey || !proof) throw new Error('This Mac does not have the storage key in memory. Turn storage on again.')
  const who = actor(folder)
  if (!who.token) throw new Error('This Mac is not signed into storage yet. Turn Plyntr storage on again.')
  const deviceId = liveDeviceId(row.id)
  const action = 'wrap-passphrase'
  const issued = await mediaLiveJson({
    method: 'POST',
    path: '/v1/media/challenges',
    token: who.token,
    deviceId,
    body: { action }
  })
  const challengeId = String(issued.json.id || '')
  const challengeB64 = String(issued.json.challenge || '')
  if (issued.status !== 200 || !challengeId || !challengeB64) throw new Error('Could not save the new passphrase.')
  const wrap = wrapBrainKeyWithPassphrase({ brainKey, passphrase: pass, mediaBrainId: row.id })
  const body: Record<string, unknown> = {
    brainKeyVersion: row.brain_key_version,
    passphraseWrap: { salt: hexBuf(wrap.salt), N: wrap.N, r: wrap.r, p: wrap.p, wrap: hexBuf(wrap.wrap) },
    passphraseProofPub: hexBuf(wrap.proofPublicKey)
  }
  const message = wrapProofMessage(Buffer.from(challengeB64, 'base64'), action, body)
  const signature = signWithProof(proof.ikm, proof.info, message)
  const res = await mediaLiveJson({
    method: 'POST',
    path: MEDIA_WRAP_PASSPHRASE_PATH,
    token: who.token,
    deviceId,
    body: { ...body, challengeId, signature: signature.toString('base64') }
  })
  if (res.status !== 200) throw new Error('Could not save the new passphrase.')
  holdProof(row.id, passphraseIkm(pass, wrap.salt), PASSPHRASE_INFO(row.id))
  return { ok: true }
}

export async function mediaSetPassphrase(opts: { folder: string; passphrase: string }): Promise<{ ok: true }> {
  const folder = String(opts.folder || '')
  const row = brainForFolder(folder)
  if (!row) throw new Error('Turn on storage first.')
  const pass = assertPassphrase(opts.passphrase)
  if (!isMediaDryRun()) return liveSetPassphrase(row, folder, pass)
  const brainKey = takeKey(brainKeyId(row.id))
  if (!brainKey) throw new Error('This Mac does not have the storage key in memory. Turn storage on again.')
  const wrap = wrapBrainKeyWithPassphrase({ brainKey, passphrase: pass, mediaBrainId: row.id })
  row.passphrase_wrap = wrap.wrap.toString('hex')
  row.passphrase_salt = wrap.salt.toString('hex')
  row.passphrase_proof = wrap.proofPublicKey.toString('hex')
  return { ok: true }
}

export async function mediaSetCap(opts: { folder: string; capBytes: number }): Promise<{ ok: true; capBytes: number }> {
  const folder = String(opts.folder || '')
  if (!canTurnOnStorage(actor(folder), folder)) throw new Error(NO_BUILDER)
  const row = brainForFolder(folder)
  if (!row) throw new Error('Turn on storage first.')
  const n = Number(opts.capBytes)
  if (!Number.isInteger(n) || n <= 0) throw new Error('Enter a storage limit in bytes.')
  if (!isMediaDryRun()) {
    const who = actor(folder)
    if (!who.token) {
      throw new Error('This Mac is not signed into storage yet. Turn Plyntr storage on again.')
    }
    const res = await mediaLiveJson({
      method: 'POST',
      path: `/v1/media/brains/${row.id}/cap`,
      token: who.token,
      deviceId: liveDeviceId(row.id),
      body: { capBytes: n }
    })
    if (res.status === 401 || res.status === 403) {
      throw new Error('This Mac is not signed into storage yet. Turn Plyntr storage on again.')
    }
    if (res.status !== 200) throw new Error('Could not save the storage limit.')
    const capBytes = Number(res.json.capBytes)
    if (!Number.isFinite(capBytes) || capBytes <= 0) throw new Error('Could not save the storage limit.')
    const snap = readLiveSnap(userData(), row.id)
    if (snap) writeLiveSnap(userData(), { ...snap, capBytes })
    return { ok: true, capBytes }
  }
  row.cap_bytes = n
  return { ok: true, capBytes: n }
}

export async function mediaTurnOnBucket(folder: string): Promise<{ ok: true; bucket: string }> {
  if (!canTurnOnStorage(actor(String(folder || '')), String(folder || ''))) throw new Error(NO_BUILDER)
  const row = brainForFolder(String(folder || ''))
  if (!row) throw new Error('Turn on storage first.')
  if (!isMediaDryRun()) {
    const who = actor(folder)
    const res = await mediaLiveJson({
      method: 'POST',
      path: `/v1/media/brains/${row.id}/bucket`,
      token: who.token,
      deviceId: liveDeviceId(row.id),
      body: {}
    })
    if (res.status === 423) throw new Error('Plyntr storage for this brain is not turned on yet. Plyntr will let you know.')
    if (res.status !== 200) throw new Error('Could not turn on the storage bucket.')
    const bucket = String(res.json.bucket || row.bucket)
    const snap = readLiveSnap(userData(), row.id)
    if (snap) writeLiveSnap(userData(), { ...snap, bucket, bucketStatus: 'on' })
    kickAutoStore(folder)
    return { ok: true, bucket }
  }
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

async function liveEnsureScope(
  row: MediaBrainRow,
  root: string,
  token: string
): Promise<{ id: string; version: number }> {
  const deviceId = liveDeviceId(row.id)
  const created = await mediaLiveJson({
    method: 'POST',
    path: MEDIA_SCOPES_PATH,
    token,
    deviceId,
    body: { root }
  })
  let scopeId = ''
  let version = 1
  if (created.status === 200) {
    scopeId = String(created.json.id || '')
    version = Number(created.json.keyVersion || 1)
  } else if (created.status === 409) {
    scopeId = String(created.json.id || '')
    const st = await mediaLiveJson({ method: 'GET', path: MEDIA_STATE_PATH, token, deviceId })
    const scopes = Array.isArray(st.json.scopes) ? st.json.scopes : []
    const hit = scopes.find((s: { id?: string; root?: string }) => s.id === scopeId || s.root === root)
    if (hit) {
      scopeId = String(hit.id || scopeId)
      version = Number((hit as { keyVersion?: number }).keyVersion || 1)
    }
  } else {
    throw new Error('Could not file this in that project.')
  }
  if (!scopeId) throw new Error('Could not file this in that project.')
  let projectKey = ensureProjectKeyInMemory(row, scopeId, version)
  if (!projectKey) {
    if (!ensureBrainKeyInMemory(row)) throw new Error('This Mac does not have the storage key in memory. Turn storage on again.')
    projectKey = createScopeKey()
    holdKey(scopeKeyId(scopeId), projectKey)
    const live = ensureDeviceKey(userData(), row.id, safe())
    const deviceWrap = wrapKeyToDevice({
      key: projectKey,
      devicePublicKey: live.publicKey,
      mediaBrainId: row.id,
      scope: scopeId,
      version
    })
    const packed = wrapToHex(deviceWrap)
    const posted = await mediaLiveJson({
      method: 'POST',
      path: MEDIA_WRAPS_PATH,
      token,
      deviceId,
      body: {
        wraps: [{ deviceId, scope: scopeId, keyVersion: version, ...wrapLive(deviceWrap) }]
      }
    })
    if (posted.status !== 200) throw new Error('Could not file this in that project.')
    upsertWrap(userData(), row.id, {
      scope: scopeId,
      key_version: version,
      eph_pub: packed.eph_pub,
      nonce: packed.nonce,
      ciphertext: packed.ciphertext
    })
    // Everyone whose seat covers this project gets the new key now, not at the next poll.
    if (row.folder) void liveMediaCheckIn(row.folder).catch(() => undefined)
  }
  return { id: scopeId, version }
}

export const MEDIA_TITLE_REFUSED = 'That file name cannot be stored. Rename the file and try again.'

/** The stored name: the filename without its extension. A refused name stops the upload before anything is stored. */
function uploadTitle(filePath: string): string {
  const raw = basename(filePath).replace(/\.[^.]+$/, '') || 'file'
  const title = cleanMediaTitle(raw)
  if (title == null) throw new MediaErr(400, 'bad_title', MEDIA_TITLE_REFUSED)
  return title
}

async function liveAdd(opts: { folder: string; root: string; path?: string }): Promise<MediaAddResult> {
  const folder = String(opts.folder || '')
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
  const title = uploadTitle(filePath)
  const plain = readFileSync(filePath)
  const token = who.token
  const deviceId = liveDeviceId(row.id)
  const scope = await liveEnsureScope(row, root, token)
  const projectKey = ensureProjectKeyInMemory(row, scope.id, scope.version)
  if (!projectKey) {
    throw new Error('This Mac does not have the project key.')
  }
  const mediaId = randomUUID()
  const dek = newDek()
  const encrypted = encryptMedia({ plaintext: plain, mediaId, chunkSize: mediaChunkSize(), dek })
  const cipherBytes = encrypted.object.length
  const dekWrap = wrapDek({
    dek,
    projectKey,
    mediaId,
    scopeId: scope.id,
    keyVersion: scope.version
  })
  const partSize = mediaPartSize()
  const cut = mediaCutover()
  let parts = 1
  if (cipherBytes > cut) parts = Math.max(1, Math.ceil(cipherBytes / partSize))
  const started = await mediaLiveJson({
    method: 'POST',
    path: MEDIA_UPLOADS_PATH,
    token,
    deviceId,
    body: {
      id: mediaId,
      cipherBytes,
      bytes: plain.length,
      mime: mimeFor(filePath),
      title,
      scopeId: scope.id,
      dekWrap: hexBuf(dekWrap),
      dekVersion: scope.version,
      partCount: parts
    }
  })
  if (started.status === 409) {
    dek.fill(0)
    return { ok: false, status: 409, error: 'no_cap', detail: 'Plyntr has not set a storage limit for this brain yet.' }
  }
  if (started.status === 413) {
    dek.fill(0)
    return { ok: false, status: 413, error: 'over_cap', detail: "This brain's storage is full. Ask Plyntr to raise the limit." }
  }
  if (started.status === 423 && started.json.error === ROTATION_PENDING) {
    dek.fill(0)
    return { ok: false, status: 423, error: ROTATION_PENDING, detail: MEDIA_UPLOADS_PAUSED }
  }
  if (started.status === 423) {
    dek.fill(0)
    return { ok: false, status: 423, error: 'bucket_off', detail: 'Plyntr storage for this brain is not turned on yet. Plyntr will let you know.' }
  }
  if (started.status === 403) {
    dek.fill(0)
    return { ok: false, status: 403, error: 'wrong_project', detail: MEDIA_WRONG_PROJECT }
  }
  if (started.status !== 200) {
    dek.fill(0)
    return { ok: false, status: started.status, error: 'upload', detail: 'Could not upload that file.' }
  }
  const objectId = String(started.json.id || mediaId)
  const etags: { partNumber: number; etag: string }[] = []
  const blob = encrypted.object
  const sliceSize = parts === 1 ? blob.length : partSize
  for (let i = 0; i < parts; i++) {
    const partNumber = i + 1
    const chunk = blob.subarray(i * sliceSize, i === parts - 1 ? blob.length : (i + 1) * sliceSize)
    const part = await mediaLiveJson({
      method: 'POST',
      path: `${MEDIA_UPLOADS_PATH}/${objectId}/parts`,
      token,
      deviceId,
      body: { partNumber }
    })
    if (part.status !== 200 || typeof part.json.url !== 'string') {
      await mediaLiveJson({ method: 'POST', path: `${MEDIA_UPLOADS_PATH}/${objectId}/abort`, token, deviceId, body: {} })
      dek.fill(0)
      throw new Error('Could not upload that file.')
    }
    const put = await mediaLivePut(String(part.json.url), Buffer.from(chunk))
    if (put.status >= 300) {
      await mediaLiveJson({ method: 'POST', path: `${MEDIA_UPLOADS_PATH}/${objectId}/abort`, token, deviceId, body: {} })
      dek.fill(0)
      throw new Error('Could not upload that file.')
    }
    etags.push({ partNumber, etag: put.etag })
  }
  const done = await mediaLiveJson({
    method: 'POST',
    path: `${MEDIA_UPLOADS_PATH}/${objectId}/complete`,
    token,
    deviceId,
    body: { parts: etags }
  })
  dek.fill(0)
  if (done.status !== 200) throw new Error('Could not upload that file.')
  writeCipherCache(userData(), row.id, objectId, blob)
  const pointer = writePointer({
    folder,
    root,
    fields: {
      brain_media: 1,
      media_id: objectId,
      title,
      mime: mimeFor(filePath),
      bytes: plain.length,
      added: new Date().toISOString().slice(0, 10)
    }
  })
  return { ok: true, rel: pointer.rel, parts, detail: `Saved ${title}.` }
}

export async function mediaAdd(opts: {
  folder: string
  root: string
  path?: string
}): Promise<MediaAddResult> {
  const folder = String(opts.folder || '')
  if (!isMediaDryRun()) return liveAdd(opts)
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
  const title = uploadTitle(filePath)
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
    created_by_email: who.email,
    title,
    created_at: new Date().toISOString()
  })
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

/** Dry run: name a computer in the local store. */
export function mediaRenameDevice(opts: { folder: string; deviceId: string; label: string }): { ok: boolean; detail: string } {
  const folder = String(opts.folder || '')
  const who = actor(folder)
  if (!canTurnOnGithubSync(who.role, who.joe)) throw new Error('Only an owner or scout can name a computer.')
  const row = brainForFolder(folder)
  if (!row) throw new Error('Turn on storage first.')
  const label = macLabel(opts.label)
  if (!label) return { ok: false, detail: 'Type a name for that computer.' }
  const device = store().devices.find((d) => d.media_brain_id === row.id && d.id === String(opts.deviceId || ''))
  if (!device) return { ok: false, detail: 'Could not rename that computer.' }
  device.label = label
  return { ok: true, detail: `Saved the name ${label}.` }
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

async function ensureLiveObjectCached(
  brain: MediaBrainRow,
  objectId: string,
  token: string,
  deviceId: string
): Promise<string> {
  if (cipherCacheExists(userData(), brain.id, objectId)) {
    touchCipherCache(userData(), brain.id, objectId)
    return cachePath(userData(), brain.id, objectId)
  }
  const signed = await mediaLiveJson({
    method: 'POST',
    path: `/v1/media/objects/${objectId}/download`,
    token,
    deviceId,
    body: {}
  })
  if (signed.status === 403) throw new MediaErr(403, 'wrong_project', MEDIA_WRONG_PROJECT)
  if (signed.status !== 200 || typeof signed.json.url !== 'string') throw new Error(MEDIA_NEEDS_NET)
  const got = await mediaLiveGet(String(signed.json.url))
  if (got.status !== 200 || !got.body.length) throw new Error(MEDIA_NEEDS_NET)
  return writeCipherCache(userData(), brain.id, objectId, got.body)
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

export async function prepareMediaPlay(opts: { folder: string; mediaId: string }): Promise<{
  cacheFile: string
  dek: Buffer
  mime: string
  plainLen: number
  mediaBrainId: string
}> {
  const folder = String(opts.folder || '')
  const mediaId = assertMediaId(opts.mediaId)
  const brain = brainForFolder(folder)
  if (!brain) throw new Error(MEDIA_OPEN_FAIL)
  if (!isMediaDryRun()) {
    const who = actor(folder)
    const deviceId = liveDeviceId(brain.id)
    const meta = await mediaLiveJson({
      method: 'GET',
      path: `/v1/media/objects/${mediaId}`,
      token: who.token,
      deviceId
    })
    if (meta.status === 403) throw new MediaErr(403, 'wrong_project', MEDIA_WRONG_PROJECT)
    if (meta.status === 410) throw new MediaErr(410, DEVICE_REVOKED, MEDIA_OPEN_FAIL)
    if (meta.status !== 200) throw new Error(MEDIA_OPEN_FAIL)
    if (String(meta.json.status) === 'deleted') throw new Error(MEDIA_REMOVED)
    const scopeId = String(meta.json.scopeId || '')
    const dekVersion = Number(meta.json.dekVersion || 1)
    const projectKey = projectKeyFor(brain.id, scopeId, dekVersion)
    const dek = unwrapDek({
      wrap: Buffer.from(String(meta.json.dekWrap || ''), 'hex'),
      projectKey,
      mediaId,
      scopeId,
      keyVersion: dekVersion
    })
    const cacheFile = await ensureLiveObjectCached(brain, mediaId, who.token, deviceId)
    return {
      cacheFile,
      dek,
      mime: String(meta.json.mime || 'application/octet-stream'),
      plainLen: Number(meta.json.bytes || 0),
      mediaBrainId: brain.id
    }
  }
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

export async function mediaDownload(opts: { folder: string; mediaId: string }): Promise<{
  status: number
  error?: string
}> {
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
    const prep = await prepareMediaPlay(opts)
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

const MEDIA_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LIBRARY_ROOT_RE = /^(projects|clients)\/[^/]+\/$/

/** The title in a note still on disk for this file, cleaned. Empty when there is no usable note. */
function noteTitle(folder: string, root: string, mediaId: string): string {
  if (!folder || !LIBRARY_ROOT_RE.test(root) || root.includes('..')) return ''
  let id8 = ''
  try {
    id8 = mediaId8(mediaId)
  } catch {
    return ''
  }
  const dir = join(folder, ...root.split('/').filter(Boolean), 'media')
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return ''
  }
  for (const name of names) {
    if (!name.endsWith(`--${id8}.media.md`)) continue
    try {
      const note = readPointer(join(dir, name))
      if (note.media_id.toLowerCase() !== mediaId.toLowerCase()) continue
      const title = cleanMediaTitle(note.title)
      if (title) return title
    } catch {
      /* a broken note fills nothing */
    }
  }
  return ''
}

function libraryFile(f: MediaLibraryFile): MediaLibraryFile {
  return {
    id: f.id,
    title: cleanMediaTitle(f.title) || '',
    mime: String(f.mime || 'application/octet-stream'),
    bytes: Number(f.bytes) || 0,
    createdAt: String(f.createdAt || ''),
    root: f.root
  }
}

function newestFirst(files: MediaLibraryFile[]): MediaLibraryFile[] {
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title))
}

async function liveLibrary(folder: string, row: MediaBrainRow): Promise<MediaLibraryResult> {
  const who = actor(folder)
  const tokens = [who.token, readPmsSeat(userData(), row.id, safe())?.token || ''].filter(Boolean)
  if (!tokens.length) return { ok: false, detail: NO_SEAT }
  const deviceId = liveDeviceId(row.id) || undefined
  let token = tokens[0]
  let res = { status: 0, json: {} as Record<string, unknown> }
  try {
    for (const t of tokens) {
      token = t
      res = await mediaLiveJson({ method: 'GET', path: MEDIA_OBJECTS_PATH, token, deviceId })
      if (res.status !== 401) break
    }
  } catch {
    return { ok: false, detail: MEDIA_NEEDS_NET }
  }
  // A worker without the list route yet. Storage itself is still up, so the routes cache is left alone.
  if (res.status === 404) return { ok: false, detail: MEDIA_LIBRARY_NOT_YET }
  if (res.status !== 200) return { ok: false, detail: MEDIA_LIBRARY_FAIL }
  const raw = Array.isArray(res.json.files) ? (res.json.files as Record<string, unknown>[]) : []
  const files: MediaLibraryFile[] = []
  for (const f of raw) {
    const id = String(f.id || '')
    const root = String(f.root || '')
    if (!MEDIA_ID_RE.test(id) || !LIBRARY_ROOT_RE.test(root)) continue
    let title = cleanMediaTitle(f.title) || ''
    if (!title) {
      const fromNote = noteTitle(folder, root, id)
      if (fromNote) {
        const filled = await mediaLiveJson({
          method: 'POST',
          path: `${MEDIA_OBJECTS_PATH}/${id}/title`,
          token,
          deviceId,
          body: { title: fromNote }
        }).catch(() => null)
        title = (filled?.status === 200 ? cleanMediaTitle(filled.json.title) : null) || fromNote
      }
    }
    files.push(
      libraryFile({
        id,
        title,
        mime: String(f.mime || ''),
        bytes: Number(f.bytes) || 0,
        createdAt: String(f.createdAt || ''),
        root
      })
    )
  }
  return { ok: true, files: newestFirst(files) }
}

/**
 * Stored files this seat may open, read from the storage records, not from notes. A note still on disk only
 * fills a name that was never stored; a stored name is never replaced. Nothing here downloads a file.
 */
export async function mediaLibrary(folder: string): Promise<MediaLibraryResult> {
  const path = String(folder || '')
  const row = brainForFolder(path)
  if (!row) return { ok: false, detail: 'Turn on storage first.' }
  if (!isMediaDryRun()) return liveLibrary(path, row)
  const who = actor(path)
  if (!who.token) return { ok: false, detail: NO_SEAT }
  const mem = store()
  const roots = mediaAccessRoots(path)
  const files: MediaLibraryFile[] = []
  for (const o of mem.objects) {
    if (o.media_brain_id !== row.id || o.status !== 'ready') continue
    const scope = mem.scopes.find((sc) => sc.id === o.scope_id)
    if (!scope) continue
    if (roots !== 'full' && !rootsOverlap(roots, scope.root)) continue
    if (!o.title) {
      const fromNote = noteTitle(path, scope.root, o.id)
      if (fromNote) o.title = fromNote
    }
    files.push(
      libraryFile({
        id: o.id,
        title: o.title || '',
        mime: o.mime,
        bytes: o.bytes,
        createdAt: o.created_at || '',
        root: scope.root
      })
    )
  }
  return { ok: true, files: newestFirst(files) }
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
