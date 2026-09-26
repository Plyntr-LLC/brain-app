import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FIRST_CHAT_MARKER, firstChatWelcome, shouldOfferFirstChat } from '../shared/first-chat'

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

function agentsText(root: string): string {
  try {
    return readFileSync(join(root, 'AGENTS.md'), 'utf8')
  } catch {
    return ''
  }
}

function writeMarker(root: string): void {
  const file = join(root, FIRST_CHAT_MARKER)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${new Date().toISOString()}\n`)
}

/** Returns the welcome once per brain, and only when context is still the blank template. */
export function takeFirstWelcome(folder: string, place: string, role?: string): { show: boolean; text: string } {
  const dir = String(folder || '').trim()
  if (!dir) return { show: false, text: '' }
  const offer = shouldOfferFirstChat({
    relPaths: contextNames(dir),
    agentsMd: agentsText(dir),
    markerPresent: existsSync(join(dir, FIRST_CHAT_MARKER)),
    role
  })
  if (!offer) return { show: false, text: '' }
  try {
    writeMarker(dir)
  } catch {
    /* folder may be read-only; still show once on this Mac */
  }
  return { show: true, text: firstChatWelcome(place) }
}
