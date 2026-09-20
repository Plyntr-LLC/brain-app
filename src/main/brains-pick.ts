import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

export type BrainRow = {
  path: string
  name: string
  slug: string
  role?: string
  watching?: boolean
  current?: boolean
}

function samePath(a: string, b: string): boolean {
  try {
    return resolve(a) === resolve(b)
  } catch {
    return a === b
  }
}

export function pickActivePath(opts: {
  saved?: string | null
  watching?: string | null
  account?: string | null
}): string {
  for (const raw of [opts.saved, opts.watching, opts.account]) {
    const p = String(raw || '').trim()
    if (p && existsSync(p)) return p
  }
  return ''
}

export function mergeBrainRows(rows: BrainRow[]): BrainRow[] {
  const out: BrainRow[] = []
  for (const row of rows) {
    const path = String(row.path || '').trim()
    if (!path || !existsSync(path)) continue
    const i = out.findIndex((x) => samePath(x.path, path))
    const next: BrainRow = {
      path,
      name: String(row.name || '').trim() || basename(path),
      slug: String(row.slug || '').trim(),
      role: String(row.role || '').trim() || undefined,
      watching: Boolean(row.watching)
    }
    if (i < 0) out.push(next)
    else {
      out[i] = {
        ...out[i],
        name: next.name || out[i].name,
        slug: next.slug || out[i].slug,
        role: next.role || out[i].role,
        watching: out[i].watching || next.watching
      }
    }
  }
  out.sort((a, b) => {
    if (a.slug === 'plyntr' && b.slug !== 'plyntr') return -1
    if (b.slug === 'plyntr' && a.slug !== 'plyntr') return 1
    return a.name.localeCompare(b.name)
  })
  return out
}
