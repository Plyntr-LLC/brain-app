import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { gitTop as realGitTop, isGitRepo as realIsGitRepo } from './git-audit.ts'
import { realish } from './paths.ts'
import { factoryDir } from './run-store.ts'

/**
 * Factory picks the work repo from the task, never a folder picker: a path in the task, then a
 * ~/Projects/<name> folder named in the task (exact, then one of its names), then what a folder's
 * README or package.json calls it, then the last Factory work repo (only when the task names no
 * topic of its own). Never the brain.
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
  /** Repo basenames a word only mentions, not chooses (the current and last work repo on a Guide note). */
  ignore?: string[]
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

/** Task words that also try another word: `email` finds `mail-desk`. */
const SYNONYMS: Record<string, string[]> = { email: ['mail'], emails: ['mail'] }

function variants(tok: string): string[] {
  return [tok, ...(SYNONYMS[tok] || [])]
}

/** Words that name no repo. A task left with only these (or words under 4 letters) may use lastRepo. */
const STOPWORDS = new Set(
  (
    'the that this with from for and want work working doing system just like fix typo update change please need ' +
    'page footer label stuff also make add were into some there their them then than what when where which about ' +
    'should would could have been being our your its get'
  ).split(' ')
)

const topic = (tok: string): boolean => tok.length >= 4 && !STOPWORDS.has(tok)

/** `not`, `never`, `isn't` (tail `t`): the next word is what the repo is not. */
const NEGATORS = new Set(['not', 'never', 'nor', 'isnt', 't'])
const FILLER = new Set(['the', 'a', 'an', 'in', 'on', 'this', 'that', 'it', 'is', 'our', 'your'])

/** Words with the one after a negator dropped: "this is not gutter iq" never picks gutter-iq. */
function named(toks: string[]): string[] {
  const out: string[] = []
  let neg = false
  for (const tok of toks) {
    if (NEGATORS.has(tok)) {
      neg = true
      continue
    }
    if (neg && FILLER.has(tok)) continue
    if (neg) {
      neg = false
      continue
    }
    out.push(tok)
  }
  return out
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

const ALIAS_CAP = 80
const ALIAS_BYTES = 8 * 1024
const ALIAS_TTL_MS = 30_000
let aliasCache: { dir: string; at: number; map: Map<string, string[]> } | null = null

function smallText(file: string): string {
  try {
    if (!existsSync(file) || statSync(file).size > ALIAS_BYTES) return ''
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** README first heading + first 80 words, package.json name + description: the names Chat would know. */
function aliasWords(dir: string): string[] {
  const out: string[] = []
  let pkg = smallText(join(dir, 'package.json'))
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { name?: unknown; description?: unknown }
      pkg = `${typeof j.name === 'string' ? j.name : ''} ${typeof j.description === 'string' ? j.description : ''}`
    } catch {
      pkg = ''
    }
    out.push(...taskTokens(pkg))
  }
  const readme = smallText(join(dir, 'README.md')) || smallText(join(dir, 'README'))
  if (readme) {
    const heading = readme.split('\n').find((l) => /^\s*#/.test(l)) || ''
    const words = readme.split(/\s+/).filter(Boolean).slice(0, 80).join(' ')
    out.push(...taskTokens(`${heading} ${words}`))
  }
  return [...new Set(out)]
}

/**
 * Folder -> alias words, cached per projectsDir and brain for 30s: intake resolves on every keystroke.
 * Reads at most 80 git folders that are not the brain, words or not.
 */
function aliasMap(projects: string, names: string[], brain: string): Map<string, string[]> {
  const now = Date.now()
  const key = `${projects}\n${brain}`
  if (aliasCache && aliasCache.dir === key && now - aliasCache.at < ALIAS_TTL_MS) return aliasCache.map
  const map = new Map<string, string[]>()
  let read = 0
  for (const name of names) {
    if (read >= ALIAS_CAP) break
    const dir = join(projects, name)
    // A git folder that is not the brain (checked again, with gitTop, at match time).
    if (!existsSync(join(dir, '.git')) || realish(dir) === brain) continue
    read++
    const words = aliasWords(dir)
    if (words.length) map.set(name, words)
  }
  aliasCache = { dir: key, at: now, map }
  return map
}

/** One task word against folder aliases: fold exact, then unique prefix, then unique contains. */
function aliasHit(tok: string, aliases: Map<string, string[]>, ok: (name: string) => boolean): string {
  const ft = fold(tok)
  if (!ft) return ''
  const steps: ((fw: string) => boolean)[] = [(fw) => fw === ft, (fw) => fw.startsWith(ft), (fw) => fw.includes(ft)]
  for (const step of steps) {
    const hits = [...aliases].filter(([, words]) => words.some((w) => step(fold(w)))).map(([n]) => n).filter(ok)
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

  // "why is the work repo mykennel" complains about mykennel; it does not pick it. No step returns an
  // ignored repo, by path, whole word, hyphen pair, partial name, or alias.
  const ignored = new Set((o.ignore || []).map((p) => fold(basename(String(p || '')))).filter(Boolean))
  const ignoredAt = new Set((o.ignore || []).filter(Boolean).map((p) => realish(String(p))))
  const skip = (hit: string) => ignoredAt.has(realish(hit)) || ignored.has(fold(basename(hit)))

  for (const p of taskPaths(o.task, o.home)) {
    const hit = repoAt(nearestDir(p))
    if (hit && !skip(hit)) return { ok: true, workRepo: hit, from: 'path' }
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
  const keep = (tok: string) => !ignored.has(fold(tok))
  const toks = named(taskTokens(o.task)).filter(keep)
  // Two words joined by a hyphen: `mail desk` finds the mail-desk folder before `desk` or `mail` alone.
  for (let i = 0; i + 1 < toks.length; i++) {
    for (const v of variants(toks[i])) {
      const name = byName.get(`${v}-${toks[i + 1]}`)
      if (!name || !keep(name)) continue
      const hit = repoAt(join(projects, name))
      if (hit && !skip(hit)) return { ok: true, workRepo: hit, from: 'project' }
    }
  }
  for (const tok of toks) {
    if (STOPWORDS.has(tok)) continue
    for (const v of variants(tok)) {
      const name = byName.get(v)
      if (!name || name.length < 3) continue
      const hit = repoAt(join(projects, name))
      if (hit && !skip(hit)) return { ok: true, workRepo: hit, from: 'project' }
    }
  }
  // One of its names: words from the task with paths taken out (paths already had their turn).
  let bare = String(o.task || '')
  for (const p of bare.match(PATH_RE) || []) bare = bare.replace(p, ' ')
  PATH_RE.lastIndex = 0
  const words = named(taskTokens(bare)).filter(keep)
  const okName = (n: string) => !!repoAt(join(projects, n), true)
  // Stopwords never pick here either: `work` must not find lotline-network before `email` finds mail-desk.
  for (const tok of words) {
    if (!topic(tok)) continue
    for (const v of variants(tok)) {
      const name = nameHit(v, names, okName)
      if (!name) continue
      const hit = repoAt(join(projects, name), true)
      if (hit && !skip(hit)) return { ok: true, workRepo: hit, from: 'name' }
    }
  }
  // What the folder calls itself (README, package.json). Stopwords never pick a repo here.
  const aliases = aliasMap(projects, names, brain)
  for (const tok of words) {
    if (!topic(tok)) continue
    for (const v of variants(tok)) {
      const name = aliasHit(v, aliases, okName)
      if (!name) continue
      const hit = repoAt(join(projects, name), true)
      if (hit && !skip(hit)) return { ok: true, workRepo: hit, from: 'name' }
    }
  }

  if (namedBrain) return { ok: false, error: BRAIN_IS_WORK }
  // lastRepo never steals a task about something else: any topic word left over means name the repo.
  if (words.some(topic)) return { ok: false, error: sawBrain ? BRAIN_IS_WORK : NAME_THE_REPO }
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
