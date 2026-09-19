import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

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

export function loadChats(cwd?: string): SavedChats | null {
  try {
    const raw = readStore()
    if (cwd && raw.byCwd && raw.byCwd[cwd]) return raw.byCwd[cwd]
    if (cwd && raw.cwd === cwd && Array.isArray(raw.tabs)) {
      return { cwd: raw.cwd, active: raw.active || '', tabs: raw.tabs, messages: raw.messages || {} }
    }
    if (!cwd && Array.isArray(raw.tabs) && raw.cwd) {
      return { cwd: raw.cwd, active: raw.active || '', tabs: raw.tabs, messages: raw.messages || {} }
    }
    return null
  } catch {
    return null
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
  const entry: SavedChats = { cwd: state.cwd, active: state.active, tabs, messages }
  const prev = readStore()
  const byCwd = { ...(prev.byCwd || {}) }
  if (prev.cwd && prev.tabs && !byCwd[prev.cwd]) {
    byCwd[prev.cwd] = { cwd: prev.cwd, active: prev.active || '', tabs: prev.tabs, messages: prev.messages || {} }
  }
  byCwd[state.cwd] = entry
  const dest = chatsFile()
  const tmp = dest + '.tmp'
  writeFileSync(tmp, JSON.stringify({ byCwd }))
  renameSync(tmp, dest)
}

export function chatsPathExists(): boolean {
  return existsSync(chatsFile())
}
