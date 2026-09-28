import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MEDIA_CONFIG_FILE = 'media.json'

export type MediaConfig = {
  version: 1
  mediaBrainId: string
}

export function isProjectMiniFolder(folder: string): boolean {
  const root = String(folder || '').trim()
  if (!root || !existsSync(root)) return false
  return !existsSync(join(root, '.git')) && existsSync(join(root, 'CLAUDE.local.md'))
}

export function mediaConfigPath(folder: string): string {
  return join(String(folder || ''), '.team-config', MEDIA_CONFIG_FILE)
}

export function readMediaConfig(folder: string): MediaConfig | null {
  const path = mediaConfigPath(folder)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as MediaConfig
    if (!raw || raw.version !== 1) return null
    const id = String(raw.mediaBrainId || '')
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return null
    return { version: 1, mediaBrainId: id }
  } catch {
    return null
  }
}

export function shouldWriteMediaConfig(folder: string, role?: string): boolean {
  if (String(role || '') === 'project') return false
  if (isProjectMiniFolder(folder)) return false
  return Boolean(String(folder || '').trim())
}

export function writeMediaConfig(folder: string, mediaBrainId: string, role?: string): boolean {
  if (!shouldWriteMediaConfig(folder, role)) return false
  const id = String(mediaBrainId || '')
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return false
  const dir = join(String(folder || ''), '.team-config')
  mkdirSync(dir, { recursive: true })
  const body: MediaConfig = { version: 1, mediaBrainId: id }
  writeFileSync(mediaConfigPath(folder), `${JSON.stringify(body)}\n`)
  return true
}
