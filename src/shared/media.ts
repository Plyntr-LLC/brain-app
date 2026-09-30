import { canTurnOnGithubSync } from './contracts.ts'

export type MediaWaiting = {
  deviceId: string
  name: string
  /** What the computer is called, e.g. Joes-MacBook-Pro. Empty on older rows; show the fingerprint then. */
  label: string
  fingerprint: string
  project: string
  /** True for the Mac this app is running on. */
  mine?: boolean
}

export type MediaStatus = {
  routes: boolean
  on: boolean
  /** The brain already has storage and this Mac is waiting for its keys. Nothing to type. */
  joining: boolean
  hasSeatToken: boolean
  fingerprint: string
  usedBytes: number
  capBytes: number | null
  bucketStatus: 'off' | 'on'
  waiting: MediaWaiting[]
  /** Every approved computer on this brain, this Mac included. Only an owner or scout sees the list. */
  others: MediaWaiting[]
  projects: { id: string; name: string; root: string }[]
  detail: string
}

export type MediaEnableResult = {
  ok: boolean
  fingerprint: string
  detail: string
  needsCode?: boolean
  needsPassphrase?: boolean
}

export type MediaAddResult =
  | { ok: true; rel: string; parts: number; detail: string }
  | { ok: false; status: number; error: string; detail: string }

/** One stored file in the library. The name is the filename without its extension. */
export type MediaLibraryFile = {
  id: string
  title: string
  mime: string
  bytes: number
  createdAt: string
  root: string
}

export type MediaLibraryResult = { ok: true; files: MediaLibraryFile[] } | { ok: false; detail: string }

export function shouldShowStorageAsk(opts: {
  role?: string
  joe?: boolean
  storageOn: boolean
  mediaAsked: boolean
  hasSeatToken: boolean
  routes: boolean
  /** media.json exists, so an owner already set storage up for this brain. */
  hasMediaConfig?: boolean
}): boolean {
  if (!opts.routes) return false
  if (opts.storageOn || opts.mediaAsked || opts.hasMediaConfig) return false
  if (opts.hasSeatToken) return canTurnOnGithubSync(opts.role, Boolean(opts.joe))
  return canTurnOnGithubSync(opts.role, false)
}

export function prettyStorageBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  const kb = n / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${Math.round((mb / 1024) * 10) / 10} GB`
}

export function mediaUsedLine(status: Pick<MediaStatus, 'usedBytes' | 'capBytes' | 'bucketStatus'>): string {
  if (status.bucketStatus !== 'on') {
    return 'Plyntr storage for this brain is not turned on yet. Plyntr will let you know.'
  }
  if (status.capBytes == null) {
    return 'Plyntr has not set a limit for this brain yet. Uploads start once it does.'
  }
  return `Used ${prettyStorageBytes(status.usedBytes)} of ${prettyStorageBytes(status.capBytes)}.`
}

export const STORAGE_FREE_GB = 10
export const STORAGE_CENTS_PER_GB = 1.5

export function parseStorageGb(text: string): number | null {
  const t = String(text ?? '').trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  if (!Number.isSafeInteger(n) || n < 1) return null
  return n
}

export function storageGbToBytes(gb: number): number {
  return Math.round(gb * 1024 ** 3)
}

export function storageBytesToGb(bytes: number | null): number | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null
  return Math.max(1, Math.round(bytes / 1024 ** 3))
}

export function storageMonthlyCents(gb: number): number {
  if (!Number.isFinite(gb)) return 0
  return Math.round(Math.max(0, gb - STORAGE_FREE_GB) * STORAGE_CENTS_PER_GB)
}

export function storageEstimateLine(gb: number): string {
  const dollars = (storageMonthlyCents(gb) / 100).toFixed(2)
  return `About $${dollars} a month. The first ${STORAGE_FREE_GB} GB is free.`
}

export const MEDIA_OFF_OWNER = 'On this computer. Only this Mac has them.'
export const MEDIA_OFF_OTHER = 'On this computer. Your owner can turn on Plyntr storage.'
export const MEDIA_OFF_KEYLESS = 'On this computer.'
export const MEDIA_ON = 'Plyntr storage is on.'
export const MEDIA_NOTES = 'Your notes stay in this folder either way.'
export const MEDIA_PASS_COPY =
  'Save these six words for emergency restore. You only need them if every computer that had storage is gone. New computers and new people join on their own. Plyntr cannot see or reset them.'
export const MEDIA_RECOVERY_COPY =
  'Save this recovery key too. It is the other emergency restore, if you lose the six words. Plyntr cannot reset it.'
export const MEDIA_JOIN_WAIT = 'Plyntr storage will finish when an owner or scout who already has it opens Brain.'
export const MEDIA_JOIN_SIGN_IN = 'Sign in to this brain and Plyntr storage finishes on its own.'
export const MEDIA_LOST_COPY =
  'Emergency only: use this if no other computer that already has storage can open Brain, or you need the six words. Ask for an email code, then type the six words or the recovery key.'

/** Default computer name from the hostname: Joes-MacBook-Pro.local becomes Joes-MacBook-Pro. */
export function macLabelFromHostname(hostname: string): string {
  return macLabel(String(hostname || '').replace(/\.local\.?$/i, '')) || 'Mac'
}

/** A computer name as the worker keeps it: trimmed, at most 40 characters. */
export function macLabel(raw: string): string {
  return String(raw || '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 40)
    .trim()
}

/** How a computer shows in a list: its name and fingerprint, or just the fingerprint. */
export function computerLine(c: { label?: string; fingerprint: string }): string {
  return c.label ? `${c.label} · ${c.fingerprint}` : c.fingerprint
}
export const MEDIA_UPLOADS_PAUSED =
  'New uploads are paused after a computer was removed. Ask Plyntr to finish the key change.'
export const MEDIA_PROJECT_WATCH = 'You can watch videos in the projects you are on.'
export const MEDIA_AUTO_STORE =
  'Images, videos, and other large files in a project or client folder are copied here on their own. The file stays where it is, and a note is added beside it in media/.'
export const MEDIA_ASK_H1 = 'Where should big videos and pictures live?'
export const MEDIA_ASK_BODY =
  'Your notes stay in this folder either way. Big files can stay on this computer, or go to Plyntr storage so the people on each project can watch them.'

export const MEDIA_WRONG_PROJECT = 'You are not on this project.'
export const MEDIA_NOT_APPROVED = 'This Mac is not approved yet. Ask your owner.'
export const MEDIA_NEEDS_NET = 'Needs the internet the first time.'
export const MEDIA_OPEN_FAIL = 'This file could not be opened.'
export const MEDIA_REMOVED = 'This file was removed from storage.'
export const MEDIA_LIBRARY_NOT_YET = 'The file list is not available yet.'
export const MEDIA_LIBRARY_FAIL = 'Could not load your stored files.'

export const MEDIA_PLAY_NOTES = [
  MEDIA_WRONG_PROJECT,
  MEDIA_NOT_APPROVED,
  MEDIA_NEEDS_NET,
  MEDIA_OPEN_FAIL
] as const

export function mediaPlayStatus(message: string): number {
  if (message === MEDIA_WRONG_PROJECT || message === MEDIA_NOT_APPROVED) return 403
  if (message === MEDIA_NEEDS_NET) return 503
  if (message === MEDIA_REMOVED) return 404
  return 400
}
