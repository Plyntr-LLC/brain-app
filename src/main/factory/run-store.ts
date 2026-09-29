import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { realish, underPath } from './paths.ts'
import { joinCode, readCode, repoStoreDir, splitCode, writeCode } from './repo-store.ts'

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

/** Scratch files (voice copy); deleted after use. */
export function factoryTmpDir(): string {
  return join(factoryDir(), 'tmp')
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

/** Which repo holds each run's code store (the run's current work repo). */
const repoOf = new Map<string, string>()
const wrote = new Map<string, string>()

/** Metadata to userData; the code fields to the work repo's own store. The caller keeps the whole run. */
export function saveRun(run: RunRecord): RunRecord {
  assertStoreOutside(run.brainPath, run.workRepo)
  mkdirSync(runsDir(), { recursive: true })
  const next = { ...run, updatedAt: Date.now() }
  const { meta, code } = splitCode(next)
  const dir = repoStoreDir(next.workRepo, safeId(next.id))
  if (dir) {
    repoOf.set(next.id, next.workRepo)
    const body = JSON.stringify(code)
    if (wrote.get(dir) !== body) {
      writeCode(dir, code)
      wrote.set(dir, body)
    }
  }
  atomicWrite(join(runsDir(), `${safeId(run.id)}.json`), JSON.stringify(meta, null, 2))
  return next
}

/** Plan text and the last strict FAIL text sit beside the run's code, in the work repo's store. */
export type RunTextKind = 'plan' | 'review' | 'verify' | 'voice'

const TEXT_KINDS: RunTextKind[] = ['plan', 'review', 'verify']

function textName(kind: RunTextKind): string {
  return `${kind}.${kind === 'verify' ? 'txt' : 'md'}`
}

/** Where Brain.app kept these before 0.1.107. Read only to move them out. */
function legacyTextPath(id: string, kind: RunTextKind): string {
  return join(runsDir(), `${safeId(id)}.${textName(kind)}`)
}

/** plan and review are .md; the T3 verify artifact is .txt. In the work repo's store, never userData. */
export function runTextPath(id: string, kind: RunTextKind): string {
  const repo = repoOf.get(id)
  const dir = repo ? repoStoreDir(repo, safeId(id)) : null
  if (!dir) throw new Error('This run has no work repo to keep its text in.')
  return join(dir, textName(kind))
}

export function saveRunText(id: string, kind: RunTextKind, text: string): string {
  const dest = runTextPath(id, kind)
  mkdirSync(dirname(dest), { recursive: true })
  atomicWrite(dest, String(text || ''))
  return dest
}

/**
 * Before 0.1.107 userData held code (diff, review, plan, tails) and text files beside the record.
 * Copy them into the repo store; delete the userData copies only once the copies are in place. With no
 * repo left there is nowhere to keep them, so they go. A failed copy throws and leaves userData as it was.
 */
function migrate(raw: RunRecord): RunRecord {
  const { meta, code } = splitCode(raw)
  const legacy = TEXT_KINDS.filter((k) => existsSync(legacyTextPath(raw.id, k)))
  if (!Object.keys(code).length && !legacy.length) return raw
  const dir = repoStoreDir(raw.workRepo, safeId(raw.id))
  if (dir) {
    mkdirSync(dir, { recursive: true })
    writeCode(dir, { ...(readCode(dir) || {}), ...code })
    for (const k of legacy) copyFileSync(legacyTextPath(raw.id, k), join(dir, textName(k)))
    const stored = readCode(dir)
    const missing = Object.keys(code).some((k) => !stored || !(k in stored)) || legacy.some((k) => !existsSync(join(dir, textName(k))))
    if (missing) throw new Error('Repo store copy is incomplete.')
  }
  atomicWrite(join(runsDir(), `${safeId(raw.id)}.json`), JSON.stringify(meta, null, 2))
  for (const k of legacy) rmSync(legacyTextPath(raw.id, k), { force: true })
  return meta
}

export function loadRun(id: string): RunRecord | null {
  let raw: RunRecord
  try {
    raw = JSON.parse(readFileSync(join(runsDir(), `${safeId(id)}.json`), 'utf8')) as RunRecord
  } catch {
    return null
  }
  let meta = raw
  try {
    meta = migrate(raw)
  } catch {
    // Nothing is lost: userData keeps the old record and files, and the next load tries again.
    return raw
  }
  const dir = repoStoreDir(meta.workRepo, safeId(meta.id))
  if (dir) repoOf.set(meta.id, meta.workRepo)
  const { live: _live, ...run } = joinCode(meta, readCode(dir))
  return run
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
