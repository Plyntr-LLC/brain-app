import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { realGit } from '../gates.ts'
import type { Risk, Size } from '../triage.ts'
import type { Bug } from './grade.ts'

/** Cases live in each project's own repo: `<repo>/evals/factory/{triage,review}.jsonl`. */

export type TriageCase = { id: string; sha?: string; task: string; expect: { size: Size; risk: Risk }; source: string }
export type ReviewCase = { id: string; task: string; base: string; head?: string; patch?: string; expect: { verdict: 'PASS' | 'FAIL'; bugs: Bug[] }; source: string }

export const caseFile = (repo: string, job: 'triage' | 'review') => join(repo, 'evals', 'factory', `${job}.jsonl`)

export function readCases<T>(file: string): T[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => JSON.parse(l) as T)
}

function git(repo: string, args: string[]): string {
  return execFileSync(realGit(), ['-c', 'core.quotepath=off', ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

const CRITICAL_PATH = /(^|\/)(auth|login|session|payments?|billing|stripe|checkout|migrations?|schema|secrets?|credentials?|\.env|passwords?|tokens?|permissions?|rbac)([./_-]|$)/i
const ELEVATED_PATH = /(^|\/)(api|config|settings|webhooks?|cron|queue|\.github)([./_-]|$)|(^|\/)package(-lock)?\.json$|(^|\/)(yarn\.lock|pnpm-lock\.yaml)$/i
const MIGRATION = /(^|\/)(migrations?|schema)([./_-]|\/|$)|\.sql$/i
const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/
const DEPS = /(^|\/)package\.json$/

/** deps: this package.json change touched a dependency list. Unknown counts as a dependency change. */
export type Stat = { path: string; lines: number; deps?: boolean }

/**
 * Size from what the commit changed, on brief.ts LIMIT_LINE exactly. T0: 1 file, 20 lines. T1: 3 files,
 * 150 lines, no new dependencies, no migrations. T2: 10 files, 600 lines, no lockfile, no migrations.
 * Else T3. Never reads triage.ts rules.
 */
export function sizeFromStats(rows: Stat[]): Size {
  const files = rows.length
  const lines = rows.reduce((n, r) => n + r.lines, 0)
  const migration = rows.some((r) => MIGRATION.test(r.path))
  const lockfile = rows.some((r) => LOCKFILE.test(r.path))
  const deps = lockfile || rows.some((r) => DEPS.test(r.path) && r.deps !== false)
  if (files <= 1 && lines <= 20) return 'T0'
  if (files <= 3 && lines <= 150 && !deps && !migration) return 'T1'
  if (files <= 10 && lines <= 600 && !lockfile && !migration) return 'T2'
  return 'T3'
}

export function riskFromPaths(paths: string[]): Risk {
  if (paths.some((p) => CRITICAL_PATH.test(p))) return 'critical'
  if (paths.some((p) => ELEVATED_PATH.test(p))) return 'elevated'
  return 'none'
}

const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

function depLists(repo: string, rev: string, path: string): string {
  try {
    const pkg = JSON.parse(git(repo, ['show', `${rev}:${path}`])) as Record<string, unknown>
    return JSON.stringify(DEP_KEYS.map((k) => pkg[k] || null))
  } catch {
    return ''
  }
}

export function commitStats(repo: string, sha: string): Stat[] {
  return git(repo, ['show', '--numstat', '--format=', sha])
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 3 && p[2])
    .map(([a, d, path]) => ({
      path,
      lines: (Number(a) || 0) + (Number(d) || 0),
      ...(DEPS.test(path) ? { deps: depLists(repo, `${sha}^`, path) !== depLists(repo, sha, path) } : {})
    }))
}

/** One case per non-merge commit: task = subject + body, expect = numstat size and path risk. Keeps existing ids. */
export function buildTriageCases(repo: string, o: { since?: string; max?: number } = {}): { file: string; added: number; total: number } {
  const file = caseFile(repo, 'triage')
  const have = readCases<TriageCase>(file)
  const known = new Set(have.map((c) => c.id))
  const log = git(repo, ['log', '--no-merges', `--max-count=${o.max || 200}`, ...(o.since ? [`--since=${o.since}`] : []), '--format=%H%x1f%B%x1e'])
  const added: TriageCase[] = []
  for (const rec of log.split('\x1e')) {
    const [sha, body] = rec.trim().split('\x1f')
    if (!sha || !body) continue
    const id = `commit-${sha.slice(0, 12)}`
    if (known.has(id)) continue
    const stats = commitStats(repo, sha)
    if (!stats.length) continue
    added.push({ id, sha, task: body.trim().slice(0, 4000), expect: { size: sizeFromStats(stats), risk: riskFromPaths(stats.map((s) => s.path)) }, source: 'git-log' })
  }
  if (added.length) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, [...have, ...added].map((c) => JSON.stringify(c)).join('\n') + '\n')
  }
  return { file, added: added.length, total: have.length + added.length }
}
