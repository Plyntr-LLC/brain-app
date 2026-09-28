import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { gitTop as realGitTop, isGitRepo as realIsGitRepo } from './git-audit.ts'
import { realish } from './paths.ts'
import { factoryDir } from './run-store.ts'

/**
 * Factory picks the work repo from the task, never a folder picker: a path in the task, then a
 * ~/Projects/<name> folder named in the task (exact, then one of its names), then the last Factory
 * work repo. Never the brain.
 */

export const NAME_THE_REPO = 'Name the code repo in the task (a path or the Projects folder name). Factory does not edit the brain.'
export const BRAIN_IS_WORK = 'That repo is the brain itself. Factory does not edit the brain. Name the code repo in the task.'

export type RepoFrom = 'given' | 'path' | 'project' | 'name' | 'last'
export type ResolvedRepo = { ok: true; workRepo: string; from: RepoFrom } | { ok: false; error: string }

export type ResolveInput = {
  task: string
  brainPath: string
  /** An explicit repo still wins (older callers, checks). */
  workRepo?: string
  lastRepo?: string
  /** Default ~/Projects. Tests inject a tmp folder. */
  projectsDir?: string
  home?: string
  isGitRepo?: (p: string) => boolean
  gitTop?: (p: string) => string
}

const PATH_RE = /(?:^|[\s"'`(<[=:,])((?:~|\/)[^\s"'`<>()[\]{},;]+)/g

/** Absolute or ~ paths named in the task, trailing punctuation dropped. */
export function taskPaths(task: string, home = homedir()): string[] {
  const out: string[] = []
  const text = String(task || '')
  for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
    let p = m[1].replace(/[.,:;!?]+$/, '')
    if (p === '~' || p.startsWith('~/')) p = join(home, p.slice(1))
    else if (p.startsWith('~')) continue
    if (p.length > 1) out.push(p)
  }
  PATH_RE.lastIndex = 0
  return [...new Set(out)]
}

/** Lowercase words of the task, split on anything but letters, digits, dot, dash, underscore. */
function taskTokens(task: string): string[] {
  return String(task || '')
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .map((t) => t.replace(/^[.\-_]+|[.\-_]+$/g, ''))
    .filter(Boolean)
}

/** Letters and digits only: `brain app`, `brainapp`, and `brain-app` fold the same. */
function fold(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * One task word (length 4+) against Projects folder names: folded exact, then unique prefix, then
 * unique contains. Two or more hits at a step: no pick for this word. ok(name) filters git repos
 * that are not the brain, and only runs on name hits.
 */
function nameHit(tok: string, names: string[], ok: (name: string) => boolean): string {
  const ft = fold(tok)
  if (!ft) return ''
  const steps: ((n: string, fn: string) => boolean)[] = [
    (_n, fn) => fn === ft,
    (n, fn) => n.startsWith(tok) || fn.startsWith(ft),
    (n, fn) => n.includes(tok) || fn.includes(ft)
  ]
  for (const step of steps) {
    const hits = names.filter((n) => step(n.toLowerCase(), fold(n))).filter(ok)
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return ''
  }
  return ''
}

/** The nearest folder that exists: the path itself, its folder if it is a file, or its closest parent. */
function nearestDir(p: string): string {
  let cur = p
  for (;;) {
    try {
      if (existsSync(cur)) return statSync(cur).isDirectory() ? cur : dirname(cur)
    } catch {
      /* keep climbing */
    }
    const up = dirname(cur)
    if (up === cur) return ''
    cur = up
  }
}

export function resolveWorkRepo(o: ResolveInput): ResolvedRepo {
  const isGit = o.isGitRepo || realIsGitRepo
  const top = o.gitTop || realGitTop
  const brain = realish(String(o.brainPath || ''))
  let sawBrain = false
  const repoAt = (dir: string, quiet = false): string => {
    if (!dir || !isGit(dir)) return ''
    const t = top(dir)
    if (!t) return ''
    if (realish(t) === brain) {
      if (!quiet) sawBrain = true
      return ''
    }
    return t
  }

  const given = String(o.workRepo || '').trim()
  if (given) return { ok: true, workRepo: given, from: 'given' }

  for (const p of taskPaths(o.task, o.home)) {
    const hit = repoAt(nearestDir(p))
    if (hit) return { ok: true, workRepo: hit, from: 'path' }
  }
  // The task named a path in the brain and nothing else: refuse rather than fall back to another repo.
  const namedBrain = sawBrain

  const projects = o.projectsDir || join(o.home || homedir(), 'Projects')
  let names: string[] = []
  try {
    names = readdirSync(projects, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    names = []
  }
  const byName = new Map(names.map((n) => [n.toLowerCase(), n]))
  for (const tok of taskTokens(o.task)) {
    const name = byName.get(tok)
    if (!name || name.length < 3) continue
    const hit = repoAt(join(projects, name))
    if (hit) return { ok: true, workRepo: hit, from: 'project' }
  }
  // One of its names: words from the task with paths taken out (paths already had their turn).
  let bare = String(o.task || '')
  for (const p of bare.match(PATH_RE) || []) bare = bare.replace(p, ' ')
  PATH_RE.lastIndex = 0
  for (const tok of taskTokens(bare)) {
    if (tok.length < 4) continue
    const name = nameHit(tok, names, (n) => !!repoAt(join(projects, n), true))
    if (!name) continue
    const hit = repoAt(join(projects, name), true)
    if (hit) return { ok: true, workRepo: hit, from: 'name' }
  }

  if (namedBrain) return { ok: false, error: BRAIN_IS_WORK }
  const last = String(o.lastRepo || '').trim()
  if (last && existsSync(last)) {
    const hit = repoAt(last)
    if (hit) return { ok: true, workRepo: hit, from: 'last' }
  }

  return { ok: false, error: sawBrain ? BRAIN_IS_WORK : NAME_THE_REPO }
}

function prefsFile(): string {
  return join(factoryDir(), 'prefs.json')
}

/** The last work repo a Factory run started in (userData prefs). */
export function lastRepo(): string {
  try {
    return String((JSON.parse(readFileSync(prefsFile(), 'utf8')) as { lastRepo?: string }).lastRepo || '')
  } catch {
    return ''
  }
}

export function rememberRepo(path: string): void {
  try {
    mkdirSync(factoryDir(), { recursive: true })
    writeFileSync(prefsFile(), JSON.stringify({ lastRepo: path }))
  } catch {
    /* best effort */
  }
}
