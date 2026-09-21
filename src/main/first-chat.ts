import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { contextNamesLookNew, firstChatWelcome } from '../shared/first-chat'

function contextNames(root: string): string[] {
  const out: string[] = []
  const top = join(root, 'context')
  if (!existsSync(top)) return out
  let entries: { name: string; isDirectory: () => boolean }[]
  try {
    entries = readdirSync(top, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    out.push(`context/${ent.name}`)
    if (!ent.isDirectory()) continue
    try {
      for (const kid of readdirSync(join(top, ent.name))) out.push(`context/${ent.name}/${kid}`)
    } catch {
      continue
    }
  }
  return out
}

/** Returns the welcome once per folder, and only when context is still the blank template. */
export function takeFirstWelcome(folder: string, place: string): { show: boolean; text: string } {
  const dir = String(folder || '').trim()
  if (!dir || !contextNamesLookNew(contextNames(dir))) return { show: false, text: '' }
  const file = join(app.getPath('userData'), 'first-chat.json')
  let seen: Record<string, boolean> = {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, boolean>
    if (raw && typeof raw === 'object') seen = raw
  } catch {
    seen = {}
  }
  if (seen[dir]) return { show: false, text: '' }
  seen[dir] = true
  writeFileSync(file, JSON.stringify(seen))
  return { show: true, text: firstChatWelcome(place) }
}
