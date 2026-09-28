import { canTurnOnGithubSync } from './contracts.ts'

export type MediaWaiting = {
  deviceId: string
  name: string
  fingerprint: string
  project: string
}

export type MediaStatus = {
  routes: boolean
  on: boolean
  hasSeatToken: boolean
  fingerprint: string
  usedBytes: number
  capBytes: number | null
  bucketStatus: 'off' | 'on'
  waiting: MediaWaiting[]
  projects: { id: string; name: string; root: string }[]
  detail: string
}

export type MediaEnableResult = {
  ok: boolean
  fingerprint: string
  detail: string
}

export type MediaAddResult =
  | { ok: true; rel: string; parts: number; detail: string }
  | { ok: false; status: number; error: string; detail: string }

export function shouldShowStorageAsk(opts: {
  role?: string
  joe?: boolean
  storageOn: boolean
  mediaAsked: boolean
  hasSeatToken: boolean
  routes: boolean
}): boolean {
  if (!opts.routes) return false
  if (opts.storageOn || opts.mediaAsked) return false
  if (!opts.hasSeatToken) return false
  return canTurnOnGithubSync(opts.role, Boolean(opts.joe))
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

export const MEDIA_OFF_OWNER = 'On this computer. Only this Mac has them.'
export const MEDIA_OFF_OTHER = 'On this computer. Your owner can turn on Plyntr storage.'
export const MEDIA_OFF_KEYLESS = 'On this computer.'
export const MEDIA_ON = 'Plyntr storage is on.'
export const MEDIA_NOTES = 'Your notes stay in this folder either way.'
export const MEDIA_PASS_COPY =
  'Choose a passphrase. You will type it, with the email code, to open these videos on a new computer. Plyntr cannot see it or reset it.'
export const MEDIA_RECOVERY_COPY = 'Save this too. It works if you forget the passphrase.'
export const MEDIA_PROJECT_WATCH = 'You can watch videos in the projects you are on.'
export const MEDIA_ASK_H1 = 'Where should big videos and pictures live?'
export const MEDIA_ASK_BODY =
  'Your notes stay in this folder either way. Big files can stay on this computer, or go to Plyntr storage so the people on each project can watch them.'
