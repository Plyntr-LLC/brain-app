import { openSync, readSync, readdirSync, statSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Window = { used_percent?: number; window_minutes?: number; resets_at?: number } | null
export type CodexLimits = { plan?: string | null; primary?: Window; secondary?: Window; at?: string }

const TAIL = 256_000
const MAX_FILES = 12

function kids(dir: string, re: RegExp): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => re.test(n))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** Newest Codex rollout files under ~/.codex/sessions/YYYY/MM/DD, newest first, capped. */
function newestRollouts(home: string): string[] {
  const root = join(home, '.codex', 'sessions')
  const out: string[] = []
  for (const y of kids(root, /^\d{4}$/)) {
    for (const m of kids(join(root, y), /^\d{2}$/)) {
      for (const d of kids(join(root, y, m), /^\d{2}$/)) {
        const dir = join(root, y, m, d)
        const files = kids(dir, /^rollout-.*\.jsonl$/)
          .map((f) => join(dir, f))
          .sort((a, b) => mtime(b) - mtime(a))
        for (const f of files) {
          out.push(f)
          if (out.length >= MAX_FILES) return out
        }
      }
    }
  }
  return out
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

function tail(p: string): string {
  let fd = -1
  try {
    const size = statSync(p).size
    const len = Math.min(size, TAIL)
    const buf = Buffer.alloc(len)
    fd = openSync(p, 'r')
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/** Last Codex plan meter this Mac saw (rate_limits on a token_count event). Never reads auth.json. */
export function readCodexLimits(home = homedir()): CodexLimits | null {
  for (const file of newestRollouts(home)) {
    const lines = tail(file).split('\n').reverse()
    for (const line of lines) {
      if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue
      try {
        const o = JSON.parse(line) as { timestamp?: string; payload?: { type?: string; rate_limits?: CodexLimits & { plan_type?: string | null } } }
        const r = o.payload?.type === 'token_count' ? o.payload.rate_limits : undefined
        if (!r || (!r.primary && !r.secondary)) continue
        return { plan: r.plan_type ?? null, primary: r.primary ?? null, secondary: r.secondary ?? null, at: o.timestamp }
      } catch {
        /* partial first line of the tail */
      }
    }
  }
  return null
}

function span(min?: number): string {
  if (!min || min <= 0) return 'window'
  if (min % 1440 === 0) return `${min / 1440}-day window`
  if (min % 60 === 0) return `${min / 60}-hour window`
  return `${min}-minute window`
}

function when(sec?: number): string {
  if (!sec) return ''
  const d = new Date(sec * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function row(w: Window, now: number): string {
  if (!w || typeof w.used_percent !== 'number') return ''
  const reset = when(w.resets_at)
  if (w.resets_at && w.resets_at * 1000 <= now) return `${span(w.window_minutes)}: reset ${reset}, no newer reading yet`
  return `${span(w.window_minutes)}: ${Math.round(w.used_percent)}% used${reset ? `, resets ${reset}` : ''}`
}

export function formatCodexLimits(l: CodexLimits | null, now = Date.now()): string {
  if (!l) return ''
  const rows = [row(l.primary ?? null, now), row(l.secondary ?? null, now)].filter(Boolean)
  if (!rows.length) return ''
  const seen = l.at ? when(Date.parse(l.at) / 1000) : ''
  return [
    `This Mac’s Codex meter${l.plan ? ` (plan: ${l.plan})` : ''}`,
    ...rows,
    seen ? `Last seen in a Codex session ${seen}.` : ''
  ]
    .filter(Boolean)
    .join('\n')
}
