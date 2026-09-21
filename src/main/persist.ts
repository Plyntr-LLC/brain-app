import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { sameCwd } from '../shared/paths'

export type SavedMsg = { who: 'me' | 'brain' | 'think' | 'sys'; text: string }
export type SavedTab = {
  id: string
  type: 'chat' | 'file' | 'term'
  title: string
  kind?: string
  mode?: 'chat' | 'term'
  model?: string
  effort?: string
  agentMode?: string
  cliSessionId?: string
  path?: string
}
export type SavedChats = {
  cwd: string
  active: string
  tabs: SavedTab[]
  messages: Record<string, SavedMsg[]>
}

function chatsFile(): string {
  return join(app.getPath('userData'), 'chats.json')
}

type Store = { byCwd?: Record<string, SavedChats> } & Partial<SavedChats>

function readStore(): Store {
  try {
    return JSON.parse(readFileSync(chatsFile(), 'utf8')) as Store
  } catch {
    return {}
  }
}

function normCwd(p: string): string {
  return String(p || '').replace(/\\/g, '/').replace(/\/$/, '')
}

function fromLegacy(raw: Store): SavedChats | null {
  if (!Array.isArray(raw.tabs) || !raw.cwd) return null
  return { cwd: raw.cwd, active: raw.active || '', tabs: raw.tabs, messages: raw.messages || {} }
}

export function loadChats(cwd?: string): SavedChats | null {
  try {
    const raw = readStore()
    const want = normCwd(cwd || '')
    if (want && raw.byCwd) {
      if (raw.byCwd[cwd || '']) return raw.byCwd[cwd || '']
      const key = Object.keys(raw.byCwd).find((k) => normCwd(k) === want)
      if (key) return raw.byCwd[key]
    }
    if (want && normCwd(raw.cwd || '') === want) return fromLegacy(raw)
    if (!cwd) return fromLegacy(raw)
    return null
  } catch {
    return null
  }
}

function hasChatTabs(row: SavedChats | null): boolean {
  return Boolean(row?.tabs?.some((t) => t.type === 'chat' || !t.type))
}

export function loadAnyChats(cwd?: string): SavedChats | null {
  const exact = loadChats(cwd)
  if (exact) return exact
  try {
    const raw = readStore()
    const rows = Object.values(raw.byCwd || {}) as SavedChats[]
    const chats = rows.filter(hasChatTabs)
    const want = normCwd(cwd || '')
    const base = want.split('/').filter(Boolean).pop()
    if (!exact && base) {
      const named = chats.filter((r) => normCwd(r.cwd).split('/').filter(Boolean).pop() === base)
      if (named.length === 1) return named[0]
    }
    const legacy = fromLegacy(raw)
    if (hasChatTabs(legacy) && (!want || sameCwd(legacy!.cwd, want))) return legacy
    return null
  } catch {
    return exact
  }
}

export function saveChats(state: SavedChats): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const messages: Record<string, SavedMsg[]> = {}
  for (const [id, list] of Object.entries(state.messages || {})) {
    messages[id] = (list || [])
      .filter((m) => m.who === 'me' || m.who === 'brain' || m.who === 'sys')
      .slice(-200)
      .map((m) => ({ who: m.who, text: m.text }))
  }
  const tabs = state.tabs.map((t) => ({
    id: t.id,
    type: t.type,
    title: t.title,
    kind: t.kind,
    mode: t.mode,
    model: t.model,
    effort: t.effort,
    agentMode: t.agentMode,
    cliSessionId: t.cliSessionId,
    path: t.path
  }))
  const key = normCwd(state.cwd)
  const entry: SavedChats = { cwd: key, active: state.active, tabs, messages }
  const prev = readStore()
  const byCwd = { ...(prev.byCwd || {}) }
  if (prev.cwd && prev.tabs && !byCwd[prev.cwd]) {
    byCwd[prev.cwd] = { cwd: prev.cwd, active: prev.active || '', tabs: prev.tabs, messages: prev.messages || {} }
  }
  for (const k of Object.keys(byCwd)) {
    if (k !== key && sameCwd(k, key)) delete byCwd[k]
  }
  byCwd[key] = entry
  const dest = chatsFile()
  const tmp = dest + '.tmp'
  writeFileSync(tmp, JSON.stringify({ byCwd }))
  renameSync(tmp, dest)
}

export function chatsPathExists(): boolean {
  return existsSync(chatsFile())
}
