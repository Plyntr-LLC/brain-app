import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import {
  activateProfile,
  alreadyActive,
  findProfile,
  type AgencyConfig,
  type AgencyProfile
} from './agency-config'
import { getPendingJoin } from './join-pending'
import { setupTrace } from './setup-trace'

const execFileP = promisify(execFile)

function appCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    return [
      join(local, 'Programs', 'Agency Brain', 'Agency Brain.exe'),
      join(local, 'Agency Brain', 'Agency Brain.exe'),
      join(pf, 'Agency Brain', 'Agency Brain.exe')
    ]
  }
  return ['/Applications/Agency Brain.app']
}

function configPath(): string {
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(roaming, 'Agency Brain', 'config.json')
  }
  return join(homedir(), 'Library/Application Support/Agency Brain/config.json')
}

function statePath(): string {
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(roaming, 'Agency Brain', 'state.json')
  }
  return join(homedir(), 'Library/Application Support/Agency Brain/state.json')
}

type SafeConfig = {
  installed: boolean
  brainPath: string | null
  name: string | null
  email: string | null
  watching: boolean
  teamSlug: string | null
  teamName: string | null
}

export type TeamMember = { email: string; name: string; role: string; slug?: string; brains?: string[] }

export function readTeamRoster(brainPath: string | null): {
  slug: string
  name: string
  members: TeamMember[]
} | null {
  if (!brainPath) return null
  const p = join(brainPath, '.team-config', 'roles.json')
  if (!existsSync(p)) return null
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as {
      team_slug?: string
      team_name?: string
      members?: { email?: string; name?: string; role?: string; slug?: string; brains?: unknown }[]
    }
    const slug = String(j.team_slug || '').trim().toLowerCase()
    const name = String(j.team_name || j.team_slug || '').trim()
    const members = (Array.isArray(j.members) ? j.members : [])
      .map((m) => ({
        email: String(m.email || '').trim().toLowerCase(),
        name: String(m.name || '').trim(),
        role: String(m.role || 'team').trim().toLowerCase(),
        slug: String(m.slug || '').trim(),
        brains: Array.isArray(m.brains)
          ? m.brains.map((b) => String(b || '').trim()).filter(Boolean)
          : []
      }))
      .filter((m) => m.email.includes('@'))
    if (!slug && !name && !members.length) return null
    return { slug: slug || name.toLowerCase(), name: name || slug, members }
  } catch {
    return null
  }
}

export function readTeamMember(brainPath: string | null, email: string): TeamMember | null {
  const roster = readTeamRoster(brainPath)
  const want = String(email || '').trim().toLowerCase()
  if (!roster || !want) return null
  return roster.members.find((m) => m.email === want) || null
}

export function readTeamIdentity(brainPath: string | null): { slug: string; name: string } | null {
  const roster = readTeamRoster(brainPath)
  if (!roster) return null
  return { slug: roster.slug, name: roster.name }
}

export function listProjectFolders(brainPath: string | null): { id: string; name: string }[] {
  if (!brainPath) return []
  const dir = join(brainPath, 'projects')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ id: e.name, name: e.name.replace(/-/g, ' ') }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function upsertTeamMember(
  brainPath: string | null,
  member: TeamMember
): { ok: boolean; detail: string } {
  if (!brainPath) return { ok: false, detail: 'No brain folder.' }
  const p = join(brainPath, '.team-config', 'roles.json')
  if (!existsSync(p)) return { ok: false, detail: 'This folder has no .team-config/roles.json.' }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as {
      team_slug?: string
      team_name?: string
      members?: TeamMember[]
    }
    const members = Array.isArray(j.members) ? j.members.slice() : []
    const email = member.email.toLowerCase()
    const row = {
      email,
      name: member.name,
      role: member.role,
      slug: member.slug || email.split('@')[0],
      brains: member.brains || []
    }
    const i = members.findIndex((m) => String(m.email || '').toLowerCase() === email)
    if (i >= 0) members[i] = { ...members[i], ...row }
    else members.push(row)
    writeFileSync(p, JSON.stringify({ ...j, members }, null, 2) + '\n')
    return { ok: true, detail: `Saved ${email} on the shared team list.` }
  } catch (e) {
    return { ok: false, detail: String((e as Error).message || e) }
  }
}

export function detectApp(): { installed: boolean; path: string } {
  const hits = appCandidates().filter((p) => existsSync(p))
  return { installed: hits.length > 0, path: hits[0] || appCandidates()[0] }
}

/** Reads Agency Brain config. Never returns tokens. */
export function readWatching(): SafeConfig {
  const installed = detectApp().installed
  const config = configPath()
  if (!existsSync(config)) {
    return { installed, brainPath: null, name: null, email: null, watching: false, teamSlug: null, teamName: null }
  }
  try {
    const raw = JSON.parse(readFileSync(config, 'utf8')) as {
      brainPath?: string
      memberEmail?: string
      memberName?: string
      brandName?: string
      kind?: string
      state?: string
    }
    let watching = false
    try {
      const st = JSON.parse(readFileSync(statePath(), 'utf8')) as { state?: string }
      watching = st.state === 'running' || st.state === 'pulling' || st.state === 'pushing'
    } catch {
      watching = Boolean(raw.brainPath && existsSync(raw.brainPath))
    }
    const brainPath = raw.brainPath && existsSync(raw.brainPath) ? raw.brainPath : null
    const ident = readTeamIdentity(brainPath)
    return {
      installed,
      brainPath,
      name: ident?.name || raw.brandName || raw.memberName || null,
      email: raw.memberEmail || null,
      watching,
      teamSlug: ident?.slug || null,
      teamName: ident?.name || null
    }
  } catch {
    return { installed, brainPath: null, name: null, email: null, watching: false, teamSlug: null, teamName: null }
  }
}

export function watchingHealth(): {
  present: boolean
  label: string
  lastSync: string
  offline: boolean
  error: string
} {
  const w = readWatching()
  if (!w.brainPath) return { present: false, label: '', lastSync: '', offline: false, error: '' }
  let lastSync = ''
  try {
    const st = JSON.parse(readFileSync(statePath(), 'utf8')) as { updatedAt?: string }
    lastSync = String(st.updatedAt || '')
  } catch {
    /* */
  }
  return {
    present: true,
    label: String(w.teamName || w.name || '').trim() || basename(w.brainPath),
    lastSync,
    offline: !w.watching,
    error: ''
  }
}

export function writesAllowed(): boolean {
  return process.env.BRAIN_APP_ALLOW_CREATE === '1'
}

function backupPath(): string {
  return configPath().replace(/config\.json$/, 'config.backup.json')
}

function loadFullConfig(): AgencyConfig | null {
  const p = configPath()
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as AgencyConfig
  } catch {
    return null
  }
}

/** Plyntr owner from Agency Brain profiles. Never returns tokens. */
export function plyntrOwnerProfile(): { email: string; name: string } | null {
  const cfg = loadFullConfig()
  if (!cfg) return null
  const rows = [...(Array.isArray(cfg.brains) ? cfg.brains : []), cfg]
  for (const b of rows) {
    if (String(b.teamSlug || '').trim().toLowerCase() !== 'plyntr') continue
    const email = String(b.memberEmail || '').trim().toLowerCase()
    if (!email.includes('@')) continue
    return { email, name: String(b.memberName || '').trim() }
  }
  return null
}

export function plyntrOwnerEmail(): string | null {
  return plyntrOwnerProfile()?.email ?? null
}

/** Drop Agency Brain profiles whose folder is not on this computer. */
export function forgetMissingBrainFolders(): void {
  const cfg = loadFullConfig()
  if (!cfg || !Array.isArray(cfg.brains)) return
  const brains = cfg.brains.filter((b) => {
    const folder = String(b.brainPath || '').trim()
    return Boolean(folder) && existsSync(folder)
  })
  if (brains.length === cfg.brains.length) return
  writeConfigAtomic({ ...cfg, brains })
}

function writeConfigAtomic(cfg: AgencyConfig): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  const json = JSON.stringify(cfg, null, 2)
  const tmp = p + '.tmp'
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, json)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, p)
  try {
    writeFileSync(backupPath(), json)
  } catch {
    /* best effort */
  }
}

/** Token for this team from Agency Brain config or the in-flight join. Never log it. */
export function memberTokenForTeam(slug: string): string | null {
  const want = String(slug || '').trim().toLowerCase()
  if (!want) return null
  const pending = getPendingJoin()
  if (pending && pending.teamSlug.toLowerCase() === want && pending.memberToken) return pending.memberToken
  const cfg = loadFullConfig()
  if (!cfg) return null
  if (String(cfg.teamSlug || '').trim().toLowerCase() === want && cfg.memberToken) {
    return String(cfg.memberToken)
  }
  for (const b of cfg.brains || []) {
    if (String(b.teamSlug || '').trim().toLowerCase() === want && b.memberToken) {
      return String(b.memberToken)
    }
  }
  return null
}

function profileFromJoin(folder: string): AgencyProfile | null {
  const join = getPendingJoin()
  if (!join?.memberToken || !join.teamSlug) return null
  return {
    brainPath: folder,
    mode: 'agency',
    teamSlug: join.teamSlug,
    memberEmail: join.memberEmail,
    memberName: join.memberName,
    memberRole: join.memberRole || 'owner',
    memberToken: join.memberToken,
    scoutSeats: join.scoutSeats,
    packageTier: join.packageTier,
    kind: join.kind || 'agency',
    brandName: join.brandName || join.teamName || join.teamSlug
  }
}

async function bounceAgencyBrain(): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await execFileP('osascript', [
        '-e',
        'if application "Agency Brain" is running then tell application "Agency Brain" to quit'
      ])
    } catch {
      /* not running */
    }
    await new Promise((r) => setTimeout(r, 800))
    spawn('open', ['-a', 'Agency Brain'], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  if (process.platform === 'win32') {
    const exe = detectApp().path
    try {
      await execFileP('taskkill', ['/IM', 'Agency Brain.exe', '/F'])
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 800))
    if (exe && existsSync(exe)) spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
  }
}

/** Point Agency Brain at this folder (archive the last brain, bounce the watcher). */
export function accountFieldsForFolder(folder: string): {
  email: string
  name: string
  role: string
  token: string
} | null {
  const cfg = loadFullConfig()
  if (!cfg) return null
  const path = String(folder || '').trim()
  const row =
    String(cfg.brainPath || '').trim() === path && cfg.memberToken
      ? cfg
      : findProfile(cfg, path, readTeamIdentity(path)?.slug)
  if (!row?.memberToken) return null
  return {
    email: String(row.memberEmail || '').trim().toLowerCase(),
    name: String(row.memberName || ''),
    role: String(row.memberRole || ''),
    token: String(row.memberToken)
  }
}

export async function activateWatching(folder: string): Promise<{ ok: boolean; detail: string }> {
  const path = String(folder || '').trim()
  if (!path || !existsSync(path)) return { ok: false, detail: 'That brain folder is not on this computer.' }
  setupTrace({ event: 'watcher', fn: 'activateWatching', folder: path })
  if (process.env.BRAIN_APP_SETUP_DRIVE === '1') {
    return { ok: true, detail: 'Setup drive leaves Agency Brain’s setup file alone.' }
  }
  const ident = readTeamIdentity(path)
  const incoming = profileFromJoin(path)
  let cfg = loadFullConfig()
  if (!cfg) {
    if (!detectApp().installed) return { ok: false, detail: 'Agency Brain is not installed on this computer.' }
    if (!incoming?.memberToken) {
      return { ok: false, detail: 'Add this brain with the code from Ads2AI first so Agency Brain can watch it.' }
    }
    const target: AgencyProfile = {
      ...incoming,
      brainPath: path,
      brandName: incoming.brandName || ident?.name || incoming.teamSlug
    }
    writeConfigAtomic(activateProfile({ brainPath: '', brains: [] }, target))
    await bounceAgencyBrain()
    return { ok: true, detail: 'Agency Brain is watching this brain.' }
  }
  const slug = incoming?.teamSlug || ident?.slug || ''
  const found = findProfile(cfg, path, slug)
  const target: AgencyProfile | null = incoming
    ? {
        ...(found || {}),
        ...incoming,
        brainPath: path,
        brandName: incoming.brandName || ident?.name || incoming.teamSlug
      }
    : found
      ? { ...found, brainPath: path, brandName: found.brandName || ident?.name || found.teamSlug }
      : null
  if (!target?.memberToken) {
    return {
      ok: false,
      detail: 'Add this brain with the code from Ads2AI first so Agency Brain can watch it.'
    }
  }
  if (alreadyActive(cfg, path, target.teamSlug) && String(cfg.memberToken || '') === target.memberToken) {
    return { ok: true, detail: 'Agency Brain is already watching this brain.' }
  }
  writeConfigAtomic(activateProfile(cfg, target))
  await bounceAgencyBrain()
  return { ok: true, detail: 'Agency Brain is watching this brain.' }
}
