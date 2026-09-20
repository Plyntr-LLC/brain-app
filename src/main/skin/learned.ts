import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { isSkinComponent, type SkinComponentId } from '../../shared/skin/catalog'

export type LearnedRow = {
  cli: string
  eventKind: string
  component: SkinComponentId
  confidence: number
  fingerprint: string
  at: string
}

type CacheFile = Record<string, LearnedRow>

let mem: CacheFile | null = null

export function learnedKey(cli: string, eventKind: string): string {
  return `${String(cli || '')}:${String(eventKind || '')}`
}

function cachePath(): string {
  return join(app.getPath('userData'), 'skin-learned.json')
}

function load(): CacheFile {
  if (mem) return mem
  try {
    mem = JSON.parse(readFileSync(cachePath(), 'utf8')) as CacheFile
  } catch {
    mem = {}
  }
  return mem
}

function save(): void {
  writeFileSync(cachePath(), JSON.stringify(load(), null, 2))
}

export function getLearned(cli: string, eventKind: string): LearnedRow | null {
  return load()[learnedKey(cli, eventKind)] || null
}

export function setLearned(row: {
  cli: string
  eventKind: string
  component: string
  confidence: number
  fingerprint: string
}): LearnedRow | null {
  if (!isSkinComponent(row.component) || row.component === 'RawFallback') return null
  const data = load()
  const stored: LearnedRow = {
    cli: String(row.cli || ''),
    eventKind: String(row.eventKind || ''),
    component: row.component,
    confidence: row.confidence,
    fingerprint: String(row.fingerprint || ''),
    at: new Date().toISOString()
  }
  data[learnedKey(stored.cli, stored.eventKind)] = stored
  save()
  return stored
}

export function listLearned(): LearnedRow[] {
  return Object.values(load()).sort((a, b) => (a.at < b.at ? 1 : -1))
}
