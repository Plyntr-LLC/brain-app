import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseGithubHqRepo } from './github-repo.ts'
import { parseSyncManifest } from './sync-manifest-parse.ts'
import { AB_OWNS_PLYNTR } from './watcher-choice.ts'

export const MOVE_ONLY_JOE = 'Only Joe can move this brain to Plyntr sync.'
export const MOVE_MINI = 'Project folders stay on project sync.'
export const MOVE_ALREADY = 'This brain is already on Plyntr sync.'
export const MOVE_NOT_BRAIN = 'This folder is not a company brain.'
export const MOVE_NO_REPO = 'This folder has no GitHub repo to move.'
export const MOVE_NO_TOKEN = 'The scout token did not come back. Sign in to platform sync, then try again.'
export const MOVE_NEED_INSTALL =
  'Install Plyntr sync on GitHub for this one repo. Click Install, then Only select repositories. Then try this again.'
export const MOVE_DONE =
  'This brain now syncs with Plyntr. This Mac stops using the Agency Brain git token for this folder.'

export function folderCanMoveToPlyntr(opts: {
  joe: boolean
  syncMode: string | null | undefined
  mini: boolean
  hasMarker: boolean
}): boolean {
  return Boolean(opts.joe && opts.hasMarker && !opts.mini && opts.syncMode !== 'plyntr')
}

export function brainRepoParts(repo: string): { org: string; slug: string; repo: string } | null {
  const parsed = parseGithubHqRepo(repo)
  if (!parsed) return null
  const [org, name] = parsed.split('/')
  if (!org || !name?.endsWith('-brain')) return null
  const slug = name.slice(0, -'-brain'.length)
  if (!slug) return null
  return { org, slug, repo: `${org}/${name}` }
}

export function plyntrSyncDocument(repo: string, createdAt: string) {
  return {
    version: 1 as const,
    mode: 'plyntr' as const,
    repo,
    githubApp: 'plyntr-brain-sync',
    bridgeApp: 'plyntr-brain-bridge',
    createdAt
  }
}

export function writePlyntrSyncFile(folder: string, repo: string, createdAt: string): void {
  const body = plyntrSyncDocument(repo, createdAt)
  const parsed = parseSyncManifest(body, `https://github.com/${repo}.git`)
  if (!parsed.ok) throw new Error(parsed.error)
  const dir = join(folder, '.team-config')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sync.json'), JSON.stringify(body, null, 2) + '\n')
}

export function gitRemoteRepo(folder: string): string {
  try {
    const origin = execFileSync('git', ['-C', folder, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return parseGithubHqRepo(origin)
  } catch {
    return ''
  }
}

export type MoveStep = {
  ok: boolean
  detail: string
  needInstall: boolean
  startedSync: boolean
  wroteManifest: boolean
  brainId: string
}

function stopped(detail: string, brainId = ''): MoveStep {
  return { ok: false, detail, needInstall: false, startedSync: false, wroteManifest: false, brainId }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runPlyntrMove(opts: {
  joe: boolean
  syncMode: string | null
  mini: boolean
  hasMarker: boolean
  abWatching: () => boolean
  repo: string
  installed: () => Promise<boolean>
  issueToken: () => Promise<{ brainId: string; hasToken: boolean }>
  openInstall: () => void | Promise<void>
  writeManifest: () => void
  remember: (brainId: string) => void
  holdSync: () => void
  startSync: () => void
  poll?: boolean
  pollMs?: number
  intervalMs?: number
}): Promise<MoveStep> {
  if (!opts.joe) return stopped(MOVE_ONLY_JOE)
  if (opts.mini) return stopped(MOVE_MINI)
  if (!opts.hasMarker) return stopped(MOVE_NOT_BRAIN)
  if (opts.syncMode === 'plyntr') return stopped(MOVE_ALREADY)
  if (opts.abWatching()) return stopped(AB_OWNS_PLYNTR)
  const parts = brainRepoParts(opts.repo)
  if (!parts) return stopped(MOVE_NO_REPO)

  const issued = await opts.issueToken()
  const brainId = String(issued.brainId || '')
  if (!brainId || !issued.hasToken) return stopped(MOVE_NO_TOKEN, brainId)

  let ready = await opts.installed()
  if (!ready) {
    await opts.openInstall()
    if (opts.poll) {
      const until = Date.now() + (opts.pollMs ?? 180_000)
      const gap = opts.intervalMs ?? 3000
      while (!ready && Date.now() < until) {
        await wait(gap)
        if (opts.abWatching()) return stopped(AB_OWNS_PLYNTR, brainId)
        ready = await opts.installed()
      }
    }
  }
  if (!ready) {
    return {
      ok: false,
      detail: MOVE_NEED_INSTALL,
      needInstall: true,
      startedSync: false,
      wroteManifest: false,
      brainId
    }
  }
  if (opts.abWatching()) return stopped(AB_OWNS_PLYNTR, brainId)

  opts.writeManifest()
  opts.remember(brainId)
  if (opts.abWatching()) {
    opts.holdSync()
    return {
      ok: false,
      detail: AB_OWNS_PLYNTR,
      needInstall: false,
      startedSync: false,
      wroteManifest: true,
      brainId
    }
  }
  opts.startSync()
  return {
    ok: true,
    detail: MOVE_DONE,
    needInstall: false,
    startedSync: true,
    wroteManifest: true,
    brainId
  }
}
