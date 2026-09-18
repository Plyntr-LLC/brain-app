import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

export function writesAllowed(): boolean {
  return process.env.BRAIN_APP_ALLOW_CREATE === '1'
}
