import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { memberTokenForTeam, readTeamIdentity, readWatching } from './agency-brain'
import * as ads2ai from './ads2ai'
import { gitSyncAuthed } from './clone'
import { isHqMiniFolder } from './hq-sync'
import { getMemberToken } from './session-token'

let timer: ReturnType<typeof setInterval> | null = null
let cwd = ''
let lastTick = ''
let lastFolder = ''

function abOwns(folder: string): boolean {
  const w = readWatching()
  return Boolean(w.brainPath && w.watching && w.brainPath === folder)
}

function dryRun(): boolean {
  return process.env.BRAIN_APP_DRY_RUN === '1'
}

async function tick(): Promise<void> {
  if (dryRun()) return
  if (!cwd || !existsSync(join(cwd, '.git'))) return
  if (abOwns(cwd)) return
  if (isHqMiniFolder(cwd)) return
  const slug = readTeamIdentity(cwd)?.slug || ''
  let member = ''
  try {
    member = (slug && memberTokenForTeam(slug)) || getMemberToken()
  } catch {
    return
  }
  if (!member || !slug) return
  let token = ''
  try {
    const git = await ads2ai.gitToken(member, slug)
    token = String(git.token || '')
  } catch {
    return
  }
  if (!token) return
  const sync = await gitSyncAuthed(cwd, token)
  if (!sync.ok) return
  lastTick = new Date().toISOString()
  lastFolder = cwd
}

export function lastBrainSync(folder?: string): string {
  if (folder && lastFolder && folder !== lastFolder) return ''
  return lastTick
}

/** Quiet pull/push when Agency Brain is not watching this folder. Never force. */
export function startBrainSync(folder: string): void {
  if (!folder) return
  if (cwd !== folder) {
    lastTick = ''
    lastFolder = ''
  }
  cwd = folder
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
