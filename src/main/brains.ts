import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { app } from 'electron'
import { readTeamIdentity, readWatching } from './agency-brain'
import { mergeBrainRows, pickActivePath, type BrainRow } from './brains-pick'
import { getAccount } from './session-token'

export type { BrainRow } from './brains-pick'
export { mergeBrainRows, pickActivePath } from './brains-pick'

type BrainsFile = { active?: string; rows?: BrainRow[] }

function filePath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'brains.json')
}

function loadFile(): BrainsFile {
  try {
    return JSON.parse(readFileSync(filePath(), 'utf8')) as BrainsFile
  } catch {
    return {}
  }
}

function saveFile(next: BrainsFile): void {
  const p = filePath()
  writeFileSync(p, JSON.stringify(next, null, 2))
  try {
    chmodSync(p, 0o600)
  } catch {
    /* windows */
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return resolve(a) === resolve(b)
  } catch {
    return a === b
  }
}

export function brainRowForPath(path: string): BrainRow | null {
  const want = String(path || '').trim()
  if (!want) return null
  const rows = loadFile().rows || []
  return rows.find((r) => r.path === want || samePath(r.path, want)) || null
}

export function publicBrainRow(row: BrainRow): BrainRow {
  const next = { ...row }
  delete next.seatToken
  return next
}

function agencyBrains(): BrainRow[] {
  const home = homedir()
  const cfg =
    process.platform === 'win32'
      ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Agency Brain', 'config.json')
      : join(home, 'Library/Application Support/Agency Brain/config.json')
  if (!existsSync(cfg)) return []
  try {
    const raw = JSON.parse(readFileSync(cfg, 'utf8')) as {
      brains?: {
        brainPath?: string
        brandName?: string
        teamSlug?: string
        memberRole?: string
      }[]
    }
    return (Array.isArray(raw.brains) ? raw.brains : []).map((b) => ({
      path: String(b.brainPath || '').trim(),
      name: String(b.brandName || b.teamSlug || '').trim(),
      slug: String(b.teamSlug || '').trim(),
      role: String(b.memberRole || '').trim() || undefined
    }))
  } catch {
    return []
  }
}

function rowFromFolder(path: string, watching?: boolean): BrainRow | null {
  if (!path || !existsSync(path)) return null
  const ident = readTeamIdentity(path)
  return {
    path,
    name: ident?.name || basename(path),
    slug: ident?.slug || '',
    watching: Boolean(watching)
  }
}

export function currentBrainFolder(): string {
  const watching = readWatching()
  const acct = getAccount()
  const saved = String(loadFile().active || '').trim()
  return pickActivePath({
    saved,
    watching: watching.brainPath,
    account: acct?.folder
  })
}

export function listBrains(): BrainRow[] {
  const watching = readWatching()
  const acct = getAccount()
  const file = loadFile()
  const current = pickActivePath({
    saved: file.active,
    watching: watching.brainPath,
    account: acct?.folder
  })
  const rows = mergeBrainRows(
    [
      ...(file.rows || []),
      ...agencyBrains(),
      rowFromFolder(watching.brainPath || '', true),
      rowFromFolder(acct?.folder || ''),
      rowFromFolder(current)
    ].filter(Boolean) as BrainRow[]
  )
  return rows.map((r) => publicBrainRow({ ...r, current: r.path === current }))
}

export function rememberBrain(row: {
  path?: string
  name?: string
  slug?: string
  role?: string
  syncMode?: 'plyntr' | 'agency-brain'
  brainId?: string
  seatToken?: string
}): BrainRow[] {
  const file = loadFile()
  const next = mergeBrainRows([
    ...(file.rows || []),
    {
      path: String(row.path || '').trim(),
      name: String(row.name || '').trim(),
      slug: String(row.slug || '').trim(),
      role: String(row.role || '').trim() || undefined,
      syncMode: row.syncMode,
      brainId: row.brainId,
      seatToken: row.seatToken
    }
  ])
  saveFile({ ...file, rows: next.filter((r) => r.path) })
  return listBrains()
}

export function folderForSlug(slug: string): string | null {
  const want = String(slug || '').trim().toLowerCase()
  if (!want) return null
  for (const row of listBrains()) {
    if (row.slug.toLowerCase() === want && existsSync(row.path)) return row.path
  }
  const guesses = [
    join(homedir(), 'Projects', `${want}-brain`),
    join(homedir(), `${want}-brain`),
    join(homedir(), 'Projects', want)
  ]
  for (const p of guesses) {
    if (existsSync(p) && readTeamIdentity(p)?.slug.toLowerCase() === want) return p
  }
  return null
}

export function switchBrain(folder: string): { path: string; name: string; slug: string } {
  const path = String(folder || '').trim()
  if (!path || !existsSync(path)) throw new Error('That brain folder is not on this computer.')
  const ident = readTeamIdentity(path)
  const name = ident?.name || basename(path)
  const slug = ident?.slug || ''
  const file = loadFile()
  const rows = mergeBrainRows([...(file.rows || []), { path, name, slug }])
  saveFile({ active: path, rows })
  return { path, name, slug }
}
