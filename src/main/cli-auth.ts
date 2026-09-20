import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiKind } from '../shared/contracts'
import { binEnv, resolveBin } from './ai-cli'

/** True when this CLI can authenticate. Never reads or logs credential files. */
export function cliSignedIn(kind: AiKind): boolean {
  const bin = resolveBin(kind)
  if (!bin) return false
  if (kind === 'grok') return existsSync(join(homedir(), '.grok', 'auth.json'))
  if (kind === 'claude') return probe(bin, ['auth', 'status'])
  if (kind === 'cursor') return probe(bin, ['status', '--format', 'json'])
  return probe(bin, ['login', 'status'])
}

function probe(bin: string, args: string[]): boolean {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000, env: binEnv() })
    const out = `${r.stdout || ''} ${r.stderr || ''}`
    if (/not logged|logged out|unauthenticated|login required|auth_required/i.test(out)) return false
    return r.status === 0
  } catch {
    return false
  }
}
