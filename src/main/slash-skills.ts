import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP_SLASH, TUI_ONLY_SLASH } from '../shared/slash-lanes'

export type DiskSkill = { name: string; path: string; description: string }

const TOKEN = '[a-zA-Z][a-zA-Z0-9_-]{0,63}'
const NAME = new RegExp(`^${TOKEN}(?::${TOKEN})?$`)
const PART = new RegExp(`^${TOKEN}$`)
const BODY_CAP = 80_000
const PLUGIN_DEPTH = 6
const PLUGIN_DIRS = 4000

/**
 * How a root lays out its files. `dir`: `<name>/SKILL.md`. `flat`: `<name>.md`, plus `<ns>/<name>.md`
 * as `ns:name` when `nested`. `synced`: `<id>/<name>/SKILL.md`. `plugins`: any `skills/<name>/SKILL.md`
 * under the root, walked to a bounded depth without following symlinks.
 */
type Root = { dir: string; kind: 'dir' | 'flat' | 'synced' | 'plugins'; nested?: boolean }

/**
 * Skill and command roots in lookup order. First hit wins. Every folder in the cwd beats every
 * folder in home. Sources: Grok's skills guide (`.grok`, `.agents`, `.claude`, `.cursor` skills and
 * commands at cwd and home), Claude Code (`.claude/skills`, `.claude/skills/synced`, nested
 * `.claude/commands`, `~/.claude/plugins`), Cursor (`.cursor/skills`, `.cursor/commands`), Codex
 * (repo `.codex/skills`, `$CODEX_HOME/skills`, `$CODEX_HOME/prompts`).
 */
function roots(cwd: string, home: string): Root[] {
  const codexHome = process.env.CODEX_HOME || join(home, '.codex')
  const tier = (base: string, extra: Root[]): Root[] => [
    { dir: join(base, '.claude', 'skills'), kind: 'dir' },
    { dir: join(base, '.claude', 'skills', 'synced'), kind: 'synced' },
    { dir: join(base, '.agents', 'skills'), kind: 'dir' },
    { dir: join(base, '.grok', 'skills'), kind: 'dir' },
    { dir: join(base, '.cursor', 'skills'), kind: 'dir' },
    ...extra,
    { dir: join(base, '.claude', 'commands'), kind: 'flat', nested: true },
    { dir: join(base, '.agents', 'commands'), kind: 'flat' },
    { dir: join(base, '.grok', 'commands'), kind: 'flat' },
    { dir: join(base, '.cursor', 'commands'), kind: 'flat' }
  ]
  return [
    ...tier(cwd, [{ dir: join(cwd, '.codex', 'skills'), kind: 'dir' }]),
    ...tier(home, [{ dir: join(codexHome, 'skills'), kind: 'dir' }]),
    { dir: join(codexHome, 'prompts'), kind: 'flat' },
    { dir: join(home, '.claude', 'plugins'), kind: 'plugins' }
  ]
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Every `skills` folder under the plugins root. Skips symlinks and dot folders, bounded in depth and count. */
function pluginSkillDirs(root: string): string[] {
  const out: string[] = []
  let budget = PLUGIN_DIRS
  const walk = (dir: string, depth: number) => {
    for (const entry of list(dir)) {
      if (budget <= 0) return
      if (entry.startsWith('.') || entry === 'node_modules') continue
      const p = join(dir, entry)
      if (!isRealDir(p)) continue
      budget -= 1
      if (entry === 'skills') out.push(p)
      else if (depth < PLUGIN_DEPTH) walk(p, depth + 1)
    }
  }
  if (isRealDir(root)) walk(root, 1)
  return out
}

/** Name and file for every candidate in one root, in order. Names are checked against the tight token. */
function entries(root: Root): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = []
  const skillDirs = (dir: string, realOnly = false) => {
    for (const entry of list(dir)) {
      if (!PART.test(entry) || (realOnly && !isRealDir(join(dir, entry)))) continue
      out.push({ name: entry, path: join(dir, entry, 'SKILL.md') })
    }
  }
  if (root.kind === 'dir') skillDirs(root.dir)
  if (root.kind === 'synced') {
    for (const id of list(root.dir)) {
      if (!id.startsWith('.') && isRealDir(join(root.dir, id))) skillDirs(join(root.dir, id))
    }
  }
  if (root.kind === 'plugins') {
    for (const dir of pluginSkillDirs(root.dir)) skillDirs(dir, true)
  }
  if (root.kind === 'flat') {
    for (const entry of list(root.dir)) {
      const name = entry.replace(/\.md$/i, '')
      if (name !== entry && PART.test(name)) out.push({ name, path: join(root.dir, entry) })
    }
    if (root.nested) {
      for (const ns of list(root.dir)) {
        if (!PART.test(ns) || !isRealDir(join(root.dir, ns))) continue
        for (const entry of list(join(root.dir, ns))) {
          const name = entry.replace(/\.md$/i, '')
          if (name !== entry && PART.test(name)) out.push({ name: `${ns}:${name}`, path: join(root.dir, ns, entry) })
        }
      }
    }
  }
  return out
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export function skillDescription(body: string): string {
  const text = String(body || '').replace(/^﻿/, '')
  let rest = text
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (fm) {
    rest = text.slice(fm[0].length)
    const line = fm[1].split(/\r?\n/).find((l) => /^description\s*:/i.test(l))
    const val = line
      ? line
          .replace(/^description\s*:\s*/i, '')
          .trim()
          .replace(/^(['"])([\s\S]*)\1$/, '$2')
          .trim()
      : ''
    if (val && val !== '|' && val !== '>') return clip(val)
  }
  const first = rest
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  return clip(first || '')
}

function clip(s: string): string {
  return s.length > 120 ? `${s.slice(0, 117)}...` : s
}

function readHead(p: string): string {
  try {
    return readFileSync(p, 'utf8').slice(0, 4000)
  } catch {
    return ''
  }
}

/** Every skill file across all roots, first hit per name, without reading any file. */
function* candidates(cwd: string, home: string): Generator<{ name: string; path: string }> {
  const seen = new Set<string>()
  for (const root of roots(cwd, home)) {
    if (!existsSync(root.dir)) continue
    for (const hit of entries(root)) {
      const key = hit.name.toLowerCase()
      if (!NAME.test(hit.name) || seen.has(key) || !isFile(hit.path)) continue
      seen.add(key)
      yield hit
    }
  }
}

export function findDiskSkill(cwd: string, name: string, home = homedir()): DiskSkill | null {
  if (!NAME.test(name)) return null
  const want = name.toLowerCase()
  for (const hit of candidates(cwd, home)) {
    if (hit.name.toLowerCase() === want) return { name, path: hit.path, description: skillDescription(readHead(hit.path)) }
  }
  return null
}

export function listDiskSkills(cwd: string, home = homedir()): DiskSkill[] {
  return [...candidates(cwd, home)].map(({ name, path }) => ({ name, path, description: skillDescription(readHead(path)) }))
}

/**
 * `/name args` for a disk skill becomes an invoked-skill turn. The thread shows `display`;
 * the warm session gets `prompt`. App commands, `/compact`, TUI chrome and unknown names return null.
 */
export function expandSlash(
  cwd: string,
  raw: string,
  home = homedir()
): { display: string; prompt: string } | null {
  const t = String(raw || '').trim()
  if (!t.startsWith('/')) return null
  const [cmd = '', ...rest] = t.slice(1).split(/\s+/)
  if (!NAME.test(cmd)) return null
  const low = cmd.toLowerCase()
  if (APP_SLASH.has(low) || TUI_ONLY_SLASH.has(low)) return null
  const skill = findDiskSkill(cwd, cmd, home)
  if (!skill) return null
  let body = ''
  try {
    body = readFileSync(skill.path, 'utf8')
  } catch {
    return null
  }
  const cut = body.length > BODY_CAP
  if (cut) body = body.slice(0, BODY_CAP)
  const args = rest.join(' ').trim()
  const display = args ? `/${cmd} ${args}` : `/${cmd}`
  const prompt = [
    `The user invoked the named skill "${cmd}" by typing ${display}. This is a user-invoked skill, not a question about it.`,
    'Run it now in this folder. Follow the skill file below step by step, including every confirm or ask step: when it says to ask or confirm, stop and ask, then wait for the answer. Do not summarize, describe, or explain the skill instead of running it.',
    args ? `Arguments: ${args}` : 'Arguments: none',
    `Skill file: ${skill.path}`,
    cut
      ? `Note: the skill file was truncated at ${BODY_CAP} characters. Read the rest from ${skill.path} if a step needs it.`
      : '',
    `<skill name="${cmd}">`,
    body,
    '</skill>'
  ]
    .filter(Boolean)
    .join('\n\n')
  return { display, prompt }
}
