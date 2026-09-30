import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { memberTokenForTeam, readTeamIdentity, readWatching } from './agency-brain'
import * as ads2ai from './ads2ai'
import { discardLocalSync, gitSyncAuthed, type SyncAuthed } from './clone'
import { isHqMiniFolder } from './hq-sync'
import { getMemberToken } from './session-token'
import { plyntrGitToken } from './plyntr-sync'
import { brainIdForSlug, seatTokenForFolder } from './plyntr-seats'
import { brainRowForPath } from './brains'
import { readSyncManifest, readSyncMode, syncModesConflict } from './sync-manifest'
import { setupTrace } from './setup-trace'
import { AB_OWNS_PLYNTR, gitCredentialForMode } from './watcher-choice'

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false
let discarding = false
let cwd = ''
let lastTick = ''
let lastFolder = ''
let lastError = ''
let lastErrorFolder = ''
let attentionFolder = ''
let attentionFiles: string[] = []
let tokenForCheck: (() => string) | null = null
let reachedGitForCheck = false

export function setCwdForCheck(folder: string): void {
  cwd = folder
}

export function setTokenForCheck(fn: (() => string) | null): void {
  tokenForCheck = fn
}

export function tickReachedGitForCheck(): boolean {
  return reachedGitForCheck
}

export function resetTickReachedForCheck(): void {
  reachedGitForCheck = false
}

export function syncAttention(folder?: string): { files: string[] } | null {
  if (!attentionFolder) return null
  if (folder && folder !== attentionFolder) return null
  return { files: attentionFiles }
}

function clearAttention(folder: string): void {
  if (!folder || folder === attentionFolder) {
    attentionFolder = ''
    attentionFiles = []
  }
}

function abOwns(folder: string): boolean {
  const w = readWatching()
  return Boolean(w.brainPath && w.watching && w.brainPath === folder)
}

function dryRun(): boolean {
  return process.env.BRAIN_APP_DRY_RUN === '1'
}

function noteAuthed(folder: string, sync: SyncAuthed): void {
  if (sync.status === 'attention') {
    attentionFolder = folder
    attentionFiles = sync.files
    if (lastErrorFolder === folder) {
      lastError = ''
    }
    return
  }
  clearAttention(folder)
  if (sync.status === 'failed') {
    noteError(folder, sync.detail || 'Sync failed.')
    return
  }
  lastError = ''
  lastErrorFolder = folder
  lastTick = new Date().toISOString()
  lastFolder = folder
}

async function tick(): Promise<void> {
  if (ticking || discarding || dryRun()) return
  if (!cwd || !existsSync(join(cwd, '.git'))) return
  if (abOwns(cwd)) {
    const parsed = readSyncManifest(cwd)
    if (parsed?.ok && parsed.manifest.mode === 'plyntr') noteError(cwd, AB_OWNS_PLYNTR)
    return
  }
  if (isHqMiniFolder(cwd)) return
  const folder = cwd
  ticking = true
  try {
    const auto = await import('./media/auto-store')
    await auto.maybeAutoStore(folder)
  } catch {
    /* storage off or offline; next tick */
  }
  if (cwd !== folder) {
    ticking = false
    return
  }
  if (tokenForCheck) {
    const token = tokenForCheck()
    try {
      reachedGitForCheck = true
      const sync = await gitSyncAuthed(folder, token)
      if (cwd === folder) noteAuthed(folder, sync)
    } finally {
      ticking = false
    }
    return
  }
  const manifest = readSyncManifest(folder)
  const row = brainRowForPath(folder)
  const plyntr = gitCredentialForMode(manifest?.ok ? manifest.manifest.mode : null) === 'plyntr'
  const slug = readTeamIdentity(folder)?.slug || ''
  let token = ''
  if (plyntr) {
    const seat = seatTokenForFolder(folder)
    const brainId = row?.brainId || brainIdForSlug(slug)
    if (!seat || !brainId) {
      noteError(folder, 'Sign in to this brain again.')
      ticking = false
      return
    }
    try {
      const git = await plyntrGitToken(brainId)
      token = String(git.token || '')
    } catch (err) {
      if (cwd === folder) noteError(folder, String((err as Error).message || err))
      ticking = false
      return
    }
  } else {
    let member = ''
    try {
      member = (slug && memberTokenForTeam(slug)) || getMemberToken()
    } catch (err) {
      if (cwd === folder) noteError(folder, String((err as Error).message || err))
      ticking = false
      return
    }
    if (cwd !== folder) {
      ticking = false
      return
    }
    if (!member || !slug) {
      noteError(folder, 'No team login for this folder, so it is not syncing.')
      ticking = false
      return
    }
    try {
      const git = await ads2ai.gitToken(member, slug)
      token = String(git.token || '')
    } catch (err) {
      if (cwd === folder) noteError(folder, String((err as Error).message || err))
      ticking = false
      return
    }
  }
  if (cwd !== folder) {
    ticking = false
    return
  }
  if (!token) {
    noteError(folder, 'Could not get a git token for this brain.')
    ticking = false
    return
  }
  try {
    const sync = await gitSyncAuthed(folder, token)
    if (cwd !== folder) return
    noteAuthed(folder, sync)
  } finally {
    ticking = false
  }
}

/** Drop this Mac's commits when two computers diverged, then sync once. */
export async function discardDivergedSync(folder: string): Promise<{ ok: boolean; detail: string }> {
  const f = String(folder || '')
  if (!f) return { ok: false, detail: 'No folder is open.' }
  if (abOwns(f)) return { ok: false, detail: 'Agency Brain is syncing this folder.' }
  if (attentionFolder !== f) return { ok: false, detail: 'Nothing to discard.' }
  if (ticking) return { ok: false, detail: 'Sync is still running.' }
  if (discarding) return { ok: false, detail: 'Already discarding.' }
  discarding = true
  try {
    const dropped = await discardLocalSync(f)
    if (!dropped.ok) return dropped
    clearAttention(f)
    return dropped
  } finally {
    discarding = false
  }
}

export async function resumeBrainSync(): Promise<void> {
  await tick()
}

/** Check only. Holds the discard lock so a tick must not touch git. */
export function holdDiscardForCheck(): () => void {
  discarding = true
  return () => {
    discarding = false
  }
}

/** Check only. Holds the tick lock so discard must refuse. */
export function holdTickForCheck(): () => void {
  ticking = true
  return () => {
    ticking = false
  }
}

export function tickForCheck(): Promise<void> {
  return tick()
}

export function noteSyncForCheck(folder: string, sync: SyncAuthed): void {
  noteAuthed(folder, sync)
}

function noteError(folder: string, msg: string): void {
  lastError = msg.slice(0, 180)
  lastErrorFolder = folder
}

export function lastBrainSync(folder?: string): string {
  if (folder && lastFolder && folder !== lastFolder) return ''
  return lastTick
}

export function lastBrainSyncError(folder?: string): string {
  if (folder && lastErrorFolder && folder !== lastErrorFolder) return ''
  return lastError
}

export function setBrainSyncBlockedReason(folder: string, msg: string): void {
  if (!folder) return
  cwd = folder
  noteError(folder, msg)
}

/** Quiet pull/push when Agency Brain is not watching this folder. Never force. */
export function startBrainSync(folder: string): void {
  if (!folder) return
  if (readSyncMode(folder) === 'local') {
    if (cwd === folder && timer) {
      clearInterval(timer)
      timer = null
    }
    return
  }
  setupTrace({ event: 'watcher', fn: 'startBrainSync', folder })
  if (cwd !== folder) {
    lastTick = ''
    lastFolder = ''
    lastError = ''
    lastErrorFolder = ''
  }
  cwd = folder
  const parsed = readSyncManifest(folder)
  const rowMode = brainRowForPath(folder)?.syncMode
  const wantsPlyntr = parsed?.ok ? parsed.manifest.mode === 'plyntr' : rowMode === 'plyntr'
  if (syncModesConflict(folder) || (parsed && !parsed.ok && rowMode === 'plyntr')) {
    noteError(folder, parsed && !parsed.ok ? parsed.error : 'This folder has no Plyntr sync file.')
    return
  }
  if (wantsPlyntr && (!parsed || !parsed.ok || parsed.manifest.mode !== 'plyntr')) {
    noteError(folder, 'This folder has no Plyntr sync file.')
    return
  }
  if (wantsPlyntr && abOwns(folder)) {
    noteError(folder, AB_OWNS_PLYNTR)
    return
  }
  if (abOwns(folder) || isHqMiniFolder(folder) || dryRun()) return
  if (timer) clearInterval(timer)
  void tick()
  timer = setInterval(() => void tick(), 60_000)
}

export function stopBrainSync(): void {
  if (timer) clearInterval(timer)
  timer = null
  cwd = ''
}

export function brainSyncCwd(): string {
  return cwd
}
