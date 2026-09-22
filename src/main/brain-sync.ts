import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { memberTokenForTeam, readTeamIdentity, readWatching } from './agency-brain'
import * as ads2ai from './ads2ai'
import { gitSyncAuthed } from './clone'
import { isHqMiniFolder } from './hq-sync'
import { getMemberToken } from './session-token'
import { plyntrGitToken } from './plyntr-sync'
import { brainIdForSlug, seatTokenForFolder } from './plyntr-seats'
import { brainRowForPath } from './brains'
import { readSyncManifest, syncModesConflict } from './sync-manifest'
import { AB_OWNS_PLYNTR, gitCredentialForMode } from './watcher-choice'

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false
let cwd = ''
let lastTick = ''
let lastFolder = ''
let lastError = ''
let lastErrorFolder = ''

function abOwns(folder: string): boolean {
  const w = readWatching()
  return Boolean(w.brainPath && w.watching && w.brainPath === folder)
}

function dryRun(): boolean {
  return process.env.BRAIN_APP_DRY_RUN === '1'
}

async function tick(): Promise<void> {
  if (ticking || dryRun()) return
  if (!cwd || !existsSync(join(cwd, '.git'))) return
  if (abOwns(cwd)) {
    const parsed = readSyncManifest(cwd)
    if (parsed?.ok && parsed.manifest.mode === 'plyntr') noteError(cwd, AB_OWNS_PLYNTR)
    return
  }
  if (isHqMiniFolder(cwd)) return
  const folder = cwd
  ticking = true
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
    if (!sync.ok) {
      noteError(folder, sync.detail || 'Sync failed.')
      return
    }
    lastError = ''
    lastErrorFolder = folder
    lastTick = new Date().toISOString()
    lastFolder = folder
  } finally {
    ticking = false
  }
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
