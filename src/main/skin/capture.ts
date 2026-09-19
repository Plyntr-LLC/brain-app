import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { catalogIdForEvent } from '../../shared/skin/from-events'
import { SKIN_COMPONENTS, type SkinComponentId } from '../../shared/skin/catalog'
import type { SkinInEvent } from '../../shared/skin/spec'
import type { AiKind } from '../../shared/contracts'

export type SkinCapture = {
  id: string
  at: string
  cli: AiKind | string
  transport: 'acp' | 'stream-json' | 'app-server' | 'pty'
  sessionId: string
  eventKind: string
  fingerprint: string
  catalogId: SkinComponentId | null
  matched: boolean
  grid: string
  propsHint: Record<string, unknown>
  label: string | null
}

type CaptureFile = { capture?: boolean }

const seen = new Map<string, Set<string>>()
let labelCache: Record<string, string> | null = null

function labeledFingerprints(): Record<string, string> {
  if (labelCache) return labelCache
  const out: Record<string, string> = {}
  for (const c of listCaptures(500)) {
    if (c.label) out[c.fingerprint] = c.label
  }
  labelCache = out
  return out
}

function propsHintOf(ev: SkinInEvent): Record<string, unknown> {
  const propsHint: Record<string, unknown> = {}
  if (ev.title) propsHint.title = redact(String(ev.title))
  if (ev.path) propsHint.path = redact(String(ev.path))
  if (ev.tool) propsHint.tool = String(ev.tool)
  if (ev.options) propsHint.options = ev.options.map((o) => o.label)
  return propsHint
}

export function skinHint(opts: { cli: string; ev: SkinInEvent }): {
  fingerprint: string
  label: string | null
  catalogId: SkinComponentId | null
} {
  const kind = String(opts.ev.kind || '')
  const catalogId = catalogIdForEvent(opts.ev)
  const fingerprint = fingerprintOf({ cli: opts.cli, kind, propsHint: propsHintOf(opts.ev), catalogId })
  return { fingerprint, label: labeledFingerprints()[fingerprint] || null, catalogId }
}

function dir(): string {
  const p = join(app.getPath('userData'), 'skin-captures')
  mkdirSync(p, { recursive: true })
  return p
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'skin.json')
}

export function captureOn(): boolean {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as CaptureFile
    return Boolean(raw.capture)
  } catch {
    return false
  }
}

export function setCaptureOn(on: boolean): boolean {
  writeFileSync(settingsPath(), JSON.stringify({ capture: Boolean(on) }, null, 2))
  return Boolean(on)
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const KEYISH = /\b(sk-[A-Za-z0-9]{8,}|Bearer\s+\S+|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/gi
const HEX = /\b[a-f0-9]{32,}\b/gi
const ENVVAL = /(?:^|[^\w])([A-Z][A-Z0-9_]{2,}=)[^\s]+/g

export function redact(text: string): string {
  let out = String(text || '')
  out = out.replace(KEYISH, '[redacted-key]')
  out = out.replace(EMAIL, '[redacted-email]')
  out = out.replace(HEX, '[redacted-hex]')
  out = out.replace(ENVVAL, '$1[redacted]')
  return out.slice(0, 4000)
}

export function fingerprintOf(shape: unknown): string {
  const json = JSON.stringify(shape)
  return createHash('sha256').update(json).digest('hex').slice(0, 16)
}

function dayFile(): string {
  const d = new Date()
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`
  return join(dir(), name)
}

function skipKind(kind: string): boolean {
  return (
    kind === 'text' ||
    kind === 'thought' ||
    kind === 'agent_message_chunk' ||
    kind === 'agent_thought_chunk' ||
    kind === 'user_message_chunk' ||
    kind === 'done'
  )
}

export function captureEvent(opts: {
  cli: string
  transport?: SkinCapture['transport']
  sessionId?: string
  ev: SkinInEvent
  grid?: string
}): SkinCapture | null {
  if (!captureOn()) return null
  const kind = String(opts.ev.kind || '')
  if (!kind || skipKind(kind)) return null
  const hint = skinHint({ cli: opts.cli, ev: opts.ev })
  const fp = hint.fingerprint
  const catalogId = hint.catalogId
  const propsHint = propsHintOf(opts.ev)
  const sessionId = opts.sessionId || ''
  const key = sessionId || 'none'
  let bag = seen.get(key)
  if (!bag) {
    bag = new Set()
    seen.set(key, bag)
  }
  if (bag.has(fp)) return null
  bag.add(fp)
  const row: SkinCapture = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    cli: opts.cli,
    transport: opts.transport || 'acp',
    sessionId,
    eventKind: kind,
    fingerprint: fp,
    catalogId,
    matched: Boolean(catalogId),
    grid: redact(opts.grid || ''),
    propsHint,
    label: hint.label
  }
  try {
    appendFileSync(dayFile(), JSON.stringify(row) + '\n')
  } catch {
    return null
  }
  return row
}

export function listCaptures(limit = 80): SkinCapture[] {
  const folder = dir()
  if (!existsSync(folder)) return []
  const names = readdirSync(folder)
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .reverse()
  const out: SkinCapture[] = []
  for (const name of names) {
    let text = ''
    try {
      text = readFileSync(join(folder, name), 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        out.push(JSON.parse(lines[i]) as SkinCapture)
      } catch {
        /* */
      }
      if (out.length >= limit) return out
    }
  }
  return out
}

export function labelCapture(fingerprint: string, label: string): boolean {
  const ok =
    label === 'raw' ||
    label === 'ignore' ||
    (SKIN_COMPONENTS as readonly string[]).includes(label)
  if (!ok) return false
  const folder = dir()
  if (!existsSync(folder)) return false
  let hit = false
  for (const name of readdirSync(folder).filter((n) => n.endsWith('.jsonl'))) {
    const path = join(folder, name)
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    let changed = false
    const next = lines.map((line) => {
      if (!line.trim()) return line
      try {
        const row = JSON.parse(line) as SkinCapture
        if (row.fingerprint === fingerprint) {
          row.label = label
          hit = true
          changed = true
          return JSON.stringify(row)
        }
      } catch {
        return line
      }
      return line
    })
    if (changed) writeFileSync(path, next.join('\n'))
  }
  if (hit) {
    labeledFingerprints()[fingerprint] = label
  }
  return hit
}
