import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export type TeamPerson = {
  name: string
  email: string
  role: 'owner' | 'scout' | 'team'
  brain: string
  /** Company slug this person belongs to. Empty on older rows. */
  client?: string
}

export type ClientBrain = {
  company: string
  slug: string
  hqName: string
  hqAddress: string
  projects: { id: string; name: string; people: string; address: string }[]
  setupLink: string
}

type SettingsFile = { superAdmin?: boolean }
type TeamFile = { people?: TeamPerson[] }
type ClientsFile = { clients?: ClientBrain[] }

function dir(): string {
  const p = app.getPath('userData')
  mkdirSync(p, { recursive: true })
  return p
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dir(), name), 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, data: unknown): void {
  writeFileSync(join(dir(), name), JSON.stringify(data, null, 2))
}

export function getSettings(): SettingsFile {
  return readJson<SettingsFile>('settings.json', {})
}

export function setSuperAdmin(on: boolean): SettingsFile {
  const cur = getSettings()
  const next = { ...cur, superAdmin: on }
  writeJson('settings.json', next)
  return next
}

export function loadTeam(): TeamPerson[] {
  return readJson<TeamFile>('team.json', {}).people || []
}

export function saveTeam(people: TeamPerson[]): TeamPerson[] {
  const clean: TeamPerson[] = (people || []).map((p) => ({
    name: String(p.name || '').trim(),
    email: String(p.email || '').trim().toLowerCase(),
    role: p.role === 'scout' || p.role === 'team' ? p.role : ('owner' as const),
    brain: String(p.brain || 'hq'),
    client: String(p.client || '').trim()
  }))
  writeJson('team.json', { people: clean })
  return clean
}

export function loadClients(): ClientBrain[] {
  const file = readJson<ClientsFile>('clients.json', {})
  if (file.clients?.length) return file.clients
  try {
    const bridge = JSON.parse(readFileSync(join(dir(), 'bridge.json'), 'utf8')) as ClientBrain
    if (bridge?.company) return [bridge]
  } catch {
    /* */
  }
  return []
}

export function saveClients(clients: ClientBrain[]): ClientBrain[] {
  const clean: ClientBrain[] = (clients || []).map((c) => ({
    company: String(c.company || '').trim(),
    slug: String(c.slug || '').trim(),
    hqName: String(c.hqName || '').trim(),
    hqAddress: String(c.hqAddress || '').trim(),
    setupLink: String(c.setupLink || '').trim(),
    projects: Array.isArray(c.projects)
      ? c.projects
          .filter((p) => p && typeof p === 'object')
          .map((p) => ({
            id: String(p.id || 'project'),
            name: String(p.name || ''),
            people: String(p.people || ''),
            address: String(p.address || '')
          }))
      : []
  }))
  writeJson('clients.json', { clients: clean })
  return clean
}

export function settingsFileExists(name: string): boolean {
  return existsSync(join(dir(), name))
}
