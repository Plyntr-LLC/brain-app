/**
 * T3 slices. The plan ends with one JSON line {"slices":[{"title":"...","files":["rel/path.ts"]}]}.
 * Builders run in waves of at most 3 whose file sets do not overlap; overlapping slices wait.
 */

import type { Slice } from '../../shared/factory.ts'

export type { Slice }

export const MAX_PARALLEL = 3
const MAX_SLICES = 12
const MAX_FILES = 40

export const WHOLE_TASK: Slice = { title: 'whole task', files: [] }

/** The balanced {...} starting at i, or null. Skips braces inside strings. */
function objectAt(text: string, i: number): string | null {
  let depth = 0
  let inStr = false
  let esc = false
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(i, j + 1)
    }
  }
  return null
}

/** Repo-relative, no leading ./, never absolute or climbing out. Empty when unusable. */
function relPath(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const p = raw.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').includes('..')) return ''
  return p
}

function cleanSlices(v: unknown): Slice[] | null {
  const list = (v as { slices?: unknown })?.slices
  if (!Array.isArray(list)) return null
  const out: Slice[] = []
  for (const item of list.slice(0, MAX_SLICES)) {
    const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const files = [...new Set((Array.isArray(r.files) ? r.files : []).map(relPath).filter(Boolean))].slice(0, MAX_FILES)
    if (!files.length) continue
    const title = String(r.title || '').trim().slice(0, 120) || files[0]
    out.push({ title, files })
  }
  return out
}

/** The last valid slices object in the plan text. Empty or invalid gives one whole-task slice. */
export function parseSlices(text: string): Slice[] {
  const body = String(text || '')
  const starts: number[] = []
  const re = /\{\s*"slices"\s*:/g
  for (let m = re.exec(body); m; m = re.exec(body)) starts.push(m.index)
  for (const i of starts.reverse()) {
    const raw = objectAt(body, i)
    if (!raw) continue
    try {
      const slices = cleanSlices(JSON.parse(raw))
      if (slices?.length) return slices
    } catch {
      /* not JSON */
    }
  }
  return [{ ...WHOLE_TASK }]
}

function key(p: string): string {
  return p.toLowerCase()
}

function touches(a: string[], b: string[]): boolean {
  // A whole-task slice (no files) overlaps everything.
  if (!a.length || !b.length) return true
  for (const x of a.map(key)) {
    for (const y of b.map(key)) {
      if (x === y || y.startsWith(x + '/') || x.startsWith(y + '/')) return true
    }
  }
  return false
}

/** Waves of at most MAX_PARALLEL pairwise disjoint slices. A slice runs after every earlier slice it overlaps. */
export function scheduleSlices(slices: Slice[]): Slice[][] {
  const waves: Slice[][] = []
  const placed: { slice: Slice; wave: number }[] = []
  for (const slice of slices) {
    let wave = 0
    for (const p of placed) if (touches(p.slice.files, slice.files)) wave = Math.max(wave, p.wave + 1)
    while (waves[wave] && waves[wave].length >= MAX_PARALLEL) wave++
    ;(waves[wave] ||= []).push(slice)
    placed.push({ slice, wave })
  }
  return waves.filter((w) => w && w.length)
}
