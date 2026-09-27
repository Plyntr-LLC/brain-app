import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RepoProfile } from '../../shared/factory.ts'
import { assertStoreOutside, factoryDir, lockKey } from './run-store.ts'

/** Per work repo settings (scripts, voice, publish remote). userData only, never in a repo. */

export function profilesDir(): string {
  return join(factoryDir(), 'profiles')
}

function profilePath(repo: string): string {
  return join(profilesDir(), `${lockKey(repo)}.json`)
}

function scriptsOf(repo: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return pkg.scripts || {}
  } catch {
    return {}
  }
}

export function detectProfile(repo: string): RepoProfile {
  const s = scriptsOf(repo)
  const scripts: RepoProfile['scripts'] = {}
  if (s.typecheck) scripts.typecheck = 'typecheck'
  if (s.test) scripts.test = 'test'
  if (s.e2e) scripts.e2e = 'e2e'
  else if (s['test:e2e']) scripts.e2e = 'test:e2e'
  return { repo, scripts, voice: { on: false }, publish: { remote: 'origin' }, updatedAt: 0 }
}

/** Detection, with saved values winning. */
export function readProfile(repo: string): RepoProfile {
  const found = detectProfile(repo)
  let saved: Partial<RepoProfile> = {}
  try {
    saved = JSON.parse(readFileSync(profilePath(repo), 'utf8')) as Partial<RepoProfile>
  } catch {
    return found
  }
  return {
    repo,
    scripts: { ...found.scripts, ...(saved.scripts || {}) },
    voice: { ...found.voice, ...(saved.voice || {}), on: saved.voice?.on === true },
    publish: { remote: String(saved.publish?.remote || found.publish.remote) },
    updatedAt: Number(saved.updatedAt || 0)
  }
}

export type ProfilePatch = { scripts?: RepoProfile['scripts']; voice?: Partial<RepoProfile['voice']>; publish?: Partial<RepoProfile['publish']> }

export function saveProfile(repo: string, patch: ProfilePatch): RepoProfile {
  if (!String(repo || '').trim() || !existsSync(repo)) throw new Error('Choose a work repo folder.')
  assertStoreOutside(repo)
  const cur = readProfile(repo)
  const next: RepoProfile = {
    repo,
    scripts: { ...cur.scripts, ...(patch.scripts || {}) },
    voice: { ...cur.voice, ...(patch.voice || {}), on: patch.voice?.on ?? cur.voice.on },
    publish: { remote: String(patch.publish?.remote || cur.publish.remote || 'origin') },
    updatedAt: Date.now()
  }
  mkdirSync(profilesDir(), { recursive: true })
  const dest = profilePath(repo)
  const tmp = `${dest}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2))
  renameSync(tmp, dest)
  return next
}

/** "This repo: typecheck · test · test:e2e" for intake. */
export function profileLine(p: RepoProfile): string {
  const names = [p.scripts.typecheck, p.scripts.test, p.scripts.e2e].filter(Boolean)
  return names.length ? `This repo: ${names.join(' · ')}` : 'This repo: no scripts found'
}
