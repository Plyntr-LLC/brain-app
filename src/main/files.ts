import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

const SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.DS_Store',
  'z-backup',
  '.vite',
  'coverage'
])

export type FileNode = { name: string; path: string; dir: boolean; kids?: FileNode[] }

export function tree(root: string, depth = 6, max = 500): FileNode[] {
  if (!root || !existsSync(root)) return []
  let n = 0
  function walk(dir: string, d: number): FileNode[] {
    if (n >= max || d < 0) return []
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const out: FileNode[] = []
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (SKIP.has(name) || name.startsWith('.env')) continue
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      n += 1
      if (n >= max) break
      const node: FileNode = { name, path: p, dir: st.isDirectory() }
      if (node.dir && d > 0) node.kids = walk(p, d - 1)
      out.push(node)
    }
    return out
  }
  return walk(root, depth)
}

const FILE_RE =
  /(?:context|clients|personal|\.claude|\.agents|docs|plans|missions|todo)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+|(?:CLAUDE|AGENTS)(?:\.local)?\.md/g

export function matchExisting(cwd: string, text: string): { path: string; live?: boolean }[] {
  if (!cwd || !text) return []
  const hits: { path: string; live?: boolean }[] = []
  const seen = new Set<string>()
  const re = new RegExp(FILE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const relPath = m[0]
    const abs = relPath.startsWith('/') ? relPath : join(cwd, relPath)
    if (seen.has(abs)) continue
    if (!existsSync(abs)) continue
    seen.add(abs)
    hits.push({ path: abs, live: true })
  }
  return hits
}

export function listDir(root: string, dir: string): FileNode[] {
  if (!root || root.length < 2 || !underRoot(root, dir) || !existsSync(dir)) return []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const skip = new Set(['.git', 'node_modules', 'dist', 'out', '.DS_Store', 'coverage', 'z-backup'])
  const out: FileNode[] = []
  for (const name of names) {
    if (skip.has(name) || name === '.env' || name.startsWith('.env.')) continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    out.push({ name, path: p, dir: st.isDirectory() })
  }
  out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  return out
}

export function underRoot(root: string, abs: string): boolean {
  const base = resolve(root)
  const p = resolve(abs)
  return p === base || p.startsWith(base + sep)
}

export function readSafe(root: string, abs: string): { text: string; kind: 'md' | 'html' | 'text'; name: string } {
  if (!underRoot(root, abs) || !existsSync(abs)) throw new Error('That file is not in this brain.')
  const name = basename(abs)
  const lower = name.toLowerCase()
  const text = readFileSync(abs, 'utf8')
  const kind = lower.endsWith('.html') || lower.endsWith('.htm') ? 'html' : lower.endsWith('.md') ? 'md' : 'text'
  return { text, kind, name }
}

const EDITABLE = /\.(md|txt|json|css|html|htm)$/i

export function writeSafe(root: string, abs: string, text: string): { ok: true } {
  if (!underRoot(root, abs) || !existsSync(abs)) throw new Error('That file is not in this brain.')
  const name = basename(abs)
  if (name.startsWith('.env') || abs.split(sep).includes('.git')) throw new Error('That file stays out of the editor.')
  if (!EDITABLE.test(name)) throw new Error('This editor saves markdown and other text files.')
  writeFileSync(abs, text, 'utf8')
  return { ok: true }
}

export function browseDocs(root: string): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = []
  function walk(dir: string, depth: number) {
    if (depth < 0 || out.length > 80) return
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (SKIP.has(name) || name.startsWith('.')) continue
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p, depth - 1)
      else if (/\.(md|html|htm)$/i.test(name)) out.push({ path: p, name: relative(root, p).split(sep).join('/') })
    }
  }
  if (root && existsSync(root)) walk(root, 4)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function rel(root: string, abs: string): string {
  try {
    const r = relative(root, abs)
    return r && !r.startsWith('..') ? r.split(sep).join('/') : basename(abs)
  } catch {
    return basename(abs)
  }
}
