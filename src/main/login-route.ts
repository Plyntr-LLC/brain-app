import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asSeat } from '../shared/contracts'
import { readTeamMember, readWatching } from './agency-brain'
import { localProjectEmail } from './hq-sync'

export type LoginVia = 'ads2ai' | 'hq-sync'

function readSeatsFile(brainPath: string | null): {
  email: string
  kind: string
  status: string
}[] {
  if (!brainPath) return []
  const p = join(brainPath, '.team-config', 'seats.json')
  if (!existsSync(p)) return []
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as {
      seats?: { email?: string; kind?: string; status?: string }[]
    }
    return (Array.isArray(j.seats) ? j.seats : [])
      .map((s) => ({
        email: String(s.email || '').trim().toLowerCase(),
        kind: String(s.kind || '').trim().toLowerCase(),
        status: String(s.status || 'active').trim().toLowerCase()
      }))
      .filter((s) => s.email.includes('@'))
  } catch {
    return []
  }
}

/** Owner, scout, and agency team use Agency Brain codes. Project only uses this app's codes. */
export async function classifyLogin(emailRaw: string): Promise<LoginVia | 'unknown'> {
  const email = String(emailRaw || '').trim().toLowerCase()
  if (!email.includes('@')) return 'unknown'
  const folder = readWatching().brainPath
  const onHq = readTeamMember(folder, email)
  if (onHq && asSeat(onHq.role) !== 'project') return 'ads2ai'
  const seats = readSeatsFile(folder)
  const project = seats.find((s) => s.email === email && s.kind !== 'owner' && s.status !== 'revoked')
  if (project) return 'hq-sync'
  if (onHq && asSeat(onHq.role) === 'project') return 'hq-sync'
  if (await localProjectEmail(email)) return 'hq-sync'
  return 'unknown'
}
