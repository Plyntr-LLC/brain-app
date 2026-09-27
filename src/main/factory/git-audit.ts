import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { realGit } from './gates.ts'
import { realish, underPath } from './paths.ts'
import type { NumstatRow } from './tripwire.ts'

/** Empty tree: the base for a work repo with no commits yet. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function git(repo: string, args: string[], input?: string): string {
  return execFileSync(realGit(), ['-c', 'core.quotepath=off', ...args], {
    cwd: repo,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

export function isGitRepo(repo: string): boolean {
  if (!repo || !existsSync(repo)) return false
  try {
    return git(repo, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
  } catch {
    return false
  }
}

export function gitTop(repo: string): string {
  return git(repo, ['rev-parse', '--show-toplevel']).trim()
}

export function headSha(repo: string): string {
  try {
    return git(repo, ['rev-parse', '--verify', 'HEAD']).trim()
  } catch {
    return EMPTY_TREE
  }
}

/** Short branch name, or null on a detached HEAD. */
export function currentBranch(repo: string): string | null {
  try {
    return git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).trim() || null
  } catch {
    return null
  }
}

export function hasRemote(repo: string, name: string): boolean {
  try {
    return git(repo, ['remote']).split('\n').map((r) => r.trim()).includes(name)
  } catch {
    return false
  }
}

type Entry = { xy: string; path: string }

function statusEntries(repo: string): Entry[] {
  const out = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
  const parts = out.split('\0').filter(Boolean)
  return parts.map((p) => ({ xy: p.slice(0, 2), path: p.slice(3) }))
}

function fileMark(repo: string, path: string): string {
  const abs = join(repo, path)
  try {
    const st = statSync(abs)
    if (!st.isFile()) return 'dir'
    return createHash('sha1').update(readFileSync(abs)).digest('hex')
  } catch {
    return 'gone'
  }
}

/** Porcelain snapshot of a repo: path to status and content hash, so a dirty file that changes again still shows. */
export type Snapshot = Record<string, string>

export function porcelain(repo: string): Snapshot {
  if (!isGitRepo(repo)) return {}
  const snap: Snapshot = {}
  for (const e of statusEntries(repo)) snap[e.path] = `${e.xy}:${fileMark(repo, e.path)}`
  return snap
}

export function isClean(repo: string): boolean {
  return isGitRepo(repo) && statusEntries(repo).length === 0
}

function countLines(abs: string): number {
  try {
    const buf = readFileSync(abs)
    if (buf.includes(0)) return 0
    const text = buf.toString('utf8')
    if (!text) return 0
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch {
    return 0
  }
}

/** Working tree vs base: tracked changes from diff --numstat plus untracked files (counted as all added). */
export function numstat(repo: string, base: string): NumstatRow[] {
  const rows: NumstatRow[] = []
  const out = git(repo, ['diff', '--numstat', '--no-renames', base || EMPTY_TREE, '--'])
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [a, d, ...rest] = line.split('\t')
    const path = rest.join('\t')
    if (!path) continue
    rows.push({ path, added: a === '-' ? 0 : Number(a) || 0, deleted: d === '-' ? 0 : Number(d) || 0 })
  }
  const seen = new Set(rows.map((r) => r.path))
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  for (const path of untracked) {
    if (seen.has(path)) continue
    rows.push({ path, added: countLines(join(repo, path)), deleted: 0 })
  }
  return rows.sort((x, y) => x.path.localeCompare(y.path))
}

export type TurnAudit = {
  /** Brain paths that changed during this turn (relative to the brain). Shown, never reverted. */
  brain: string[]
  /** Work repo changes vs the run base. */
  work: NumstatRow[]
  brainChecked: boolean
}

/** After a build turn: new brain porcelain entries vs the pre-turn snapshot, and work repo numstat vs base. */
export function auditTurn(opts: { brainPath: string; workRepo: string; brainBefore: Snapshot; base: string }): TurnAudit {
  const brainChecked = isGitRepo(opts.brainPath)
  const brain: string[] = []
  if (brainChecked) {
    const top = realish(gitTop(opts.brainPath))
    const work = realish(opts.workRepo)
    const now = porcelain(opts.brainPath)
    for (const [path, mark] of Object.entries(now)) {
      if (opts.brainBefore[path] === mark) continue
      // A work repo nested in the brain is audited on its own.
      if (underPath(work, join(top, path))) continue
      brain.push(path)
    }
    for (const path of Object.keys(opts.brainBefore)) {
      if (!(path in now)) {
        const abs = join(top, path)
        if (underPath(work, abs)) continue
        brain.push(path)
      }
    }
  }
  return { brain: [...new Set(brain)].sort(), work: numstat(opts.workRepo, opts.base), brainChecked }
}

/** Unified diff of the run so far (tracked) plus new files, capped for the UI. */
export function diffText(repo: string, base: string, max = 60_000): string {
  let text = git(repo, ['diff', '--no-renames', '--no-color', base || EMPTY_TREE, '--'])
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  for (const path of untracked) {
    let body = ''
    try {
      const buf = readFileSync(join(repo, path))
      body = buf.includes(0) ? '(binary)' : buf.toString('utf8')
    } catch {
      body = ''
    }
    text += `\nnew file ${path}\n${body
      .split('\n')
      .map((l) => '+' + l)
      .join('\n')}\n`
    if (text.length > max) break
  }
  return text.length > max ? text.slice(0, max) + '\n... (diff cut for display)' : text
}

/** Stages exactly the run's paths and commits with the real git. Never pushes. Returns the new sha. */
export function commitRun(workRepo: string, paths: string[], message: string): string {
  const clean = paths.filter((p) => p && !p.split('/').includes('..') && !p.startsWith('/'))
  if (!clean.length) throw new Error('Nothing to commit. This run changed no files in the work repo.')
  git(workRepo, ['add', '-A', '--', ...clean])
  git(workRepo, ['commit', '-q', '-F', '-', '--', ...clean], message)
  return headSha(workRepo)
}

/** Repo-relative posix path of abs, or null when outside. */
export function repoRel(repo: string, abs: string): string | null {
  const r = relative(realish(repo), realish(abs))
  if (!r || r.startsWith('..')) return null
  return r.split(sep).join('/')
}
