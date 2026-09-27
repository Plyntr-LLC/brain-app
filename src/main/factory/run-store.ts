import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realish, underPath } from './paths.ts'

/**
 * Factory run records and work-repo locks. They live only under the app's userData, never in the
 * brain or the work repo, so nothing Factory keeps shows in either repo's git status.
 */

import type { RunPhase, RunRecord } from '../../shared/factory.ts'

export type { RunPhase, RunRecord, VerifyRow } from '../../shared/factory.ts'

export const TERMINAL_PHASES: RunPhase[] = ['done', 'abandoned']

let userDataFn: (() => string) | null = null

/** Main wires app.getPath('userData'); tests point it at a tmp folder. */
export function setUserDataDir(fn: () => string): void {
  userDataFn = fn
}

export function factoryDir(): string {
  if (!userDataFn) throw new Error('Factory store has no userData folder yet.')
  return join(userDataFn(), 'factory')
}

export function factoryShimDir(): string {
  return join(factoryDir(), 'bin')
}

/** Throws when the store would land inside a repo it watches. */
export function assertStoreOutside(...repos: (string | undefined)[]): void {
  const dir = realish(factoryDir())
  for (const repo of repos) {
    if (!repo) continue
    if (underPath(realish(repo), dir)) {
      throw new Error('The Factory store would sit inside a repo. Brain keeps run records in its own app folder only.')
    }
  }
}

function runsDir(): string {
  return join(factoryDir(), 'runs')
}

function locksDir(): string {
  return join(factoryDir(), 'locks')
}

function atomicWrite(dest: string, body: string): void {
  const tmp = `${dest}.${process.pid}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, dest)
}

function safeId(id: string): string {
  const s = String(id || '')
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(s)) throw new Error('Bad run id.')
  return s
}

export function saveRun(run: RunRecord): RunRecord {
  assertStoreOutside(run.brainPath, run.workRepo)
  mkdirSync(runsDir(), { recursive: true })
  const next = { ...run, updatedAt: Date.now() }
  atomicWrite(join(runsDir(), `${safeId(run.id)}.json`), JSON.stringify(next, null, 2))
  return next
}

export function loadRun(id: string): RunRecord | null {
  try {
    return JSON.parse(readFileSync(join(runsDir(), `${safeId(id)}.json`), 'utf8')) as RunRecord
  } catch {
    return null
  }
}

export function listRuns(): RunRecord[] {
  if (!existsSync(runsDir())) return []
  const out: RunRecord[] = []
  for (const name of readdirSync(runsDir())) {
    if (!name.endsWith('.json')) continue
    const run = loadRun(name.slice(0, -5))
    if (run) out.push(run)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function lockKey(repo: string): string {
  return createHash('sha1').update(realish(repo)).digest('hex')
}

function lockPath(repo: string): string {
  return join(locksDir(), `${lockKey(repo)}.json`)
}

type LockRow = { runId: string; title: string; repo: string; at: number }

function readLock(repo: string): LockRow | null {
  try {
    return JSON.parse(readFileSync(lockPath(repo), 'utf8')) as LockRow
  } catch {
    return null
  }
}

/** The run holding this repo's lock, if that run is still live. */
export function activeRunFor(repo: string): LockRow | null {
  const row = readLock(repo)
  if (!row) return null
  const run = loadRun(row.runId)
  if (!run || TERMINAL_PHASES.includes(run.phase)) return null
  return row
}

export type LockResult = { ok: true } | { ok: false; runId: string; title: string }

/** One live run per work repo, keyed by realpath. A lock left by a finished or missing run is taken over. */
export function acquireLock(repo: string, run: { runId: string; title: string }): LockResult {
  assertStoreOutside(repo)
  mkdirSync(locksDir(), { recursive: true })
  const path = lockPath(repo)
  const row: LockRow = { runId: run.runId, title: run.title, repo: realish(repo), at: Date.now() }
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx')
      writeFileSync(fd, JSON.stringify(row))
      closeSync(fd)
      return { ok: true }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const held = readLock(repo)
      if (held && held.runId === run.runId) return { ok: true }
      if (held && activeRunFor(repo)) return { ok: false, runId: held.runId, title: held.title }
      try {
        unlinkSync(path)
      } catch {
        /* raced */
      }
    }
  }
  const held = readLock(repo)
  return held ? { ok: false, runId: held.runId, title: held.title } : { ok: false, runId: '', title: '' }
}

export function releaseLock(repo: string, runId: string): void {
  const held = readLock(repo)
  if (held && held.runId !== runId) return
  try {
    unlinkSync(lockPath(repo))
  } catch {
    /* gone */
  }
}

export function holdsLock(repo: string, runId: string): boolean {
  return readLock(repo)?.runId === runId
}
