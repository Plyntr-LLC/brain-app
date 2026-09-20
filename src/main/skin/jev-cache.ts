import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { JevProposal } from './jev-propose'

export type StoredProposal = JevProposal & { at: string }

type CacheFile = Record<string, StoredProposal>

let mem: CacheFile | null = null

function cachePath(): string {
  return join(app.getPath('userData'), 'skin-jev.json')
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
  const data = load()
  writeFileSync(cachePath(), JSON.stringify(data, null, 2))
}

export function getProposal(fingerprint: string): StoredProposal | null {
  const row = load()[fingerprint]
  return row || null
}

export function setProposal(fingerprint: string, proposal: JevProposal): StoredProposal {
  const data = load()
  const row: StoredProposal = { ...proposal, at: new Date().toISOString() }
  data[fingerprint] = row
  save()
  return row
}

export function allProposals(): CacheFile {
  return { ...load() }
}
