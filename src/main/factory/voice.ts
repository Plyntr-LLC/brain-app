import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { RepoProfile, VerifyRow } from '../../shared/factory.ts'
import { factoryTmpDir } from './run-store.ts'

/**
 * Optional voice check (Jev, via the TypeSafe voice-check script under Doppler). Only the added
 * lines of copy files go in. Exit 0 APPROVE, 2 REJECT (hold), anything else skipped with why.
 */

export const VOICE_CHECK = '/Users/joewine/Projects/agency-brain/code/typesafe/voice-check/check.cjs'
export const VOICE_TIMEOUT_MS = 3 * 60_000
export const COPY_RE = /\.(md|mdx|txt|html?)$/i

export type SpawnFn = (bin: string, args: string[], opts: SpawnOptions) => ChildProcess

/** Added lines of copy files in a unified diff (and diffText's "new file" blocks). */
export function copyAdds(diff: string): string {
  const out: string[] = []
  let file = ''
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = ''
      continue
    }
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '').trim()
      continue
    }
    if (line.startsWith('new file ') && !line.startsWith('new file mode')) {
      file = line.slice('new file '.length).trim()
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++') && COPY_RE.test(file)) out.push(line.slice(1))
  }
  return out.join('\n').trim()
}

export function voiceArgs(file: string, register: string, audience: string): string[] {
  return ['run', '-p', 'team-brain', '-c', 'dev', '--', 'node', VOICE_CHECK, `--file=${file}`, `--register=${register}`, `--audience=${audience}`]
}

function tail(text: string, n = 12): string {
  return String(text || '').trimEnd().split('\n').slice(-n).join('\n')
}

export async function runVoice(o: {
  runId: string
  diff: string
  profile: RepoProfile
  env?: NodeJS.ProcessEnv
  spawnFn?: SpawnFn
  /** Test hook: the voice-check script path to look for. */
  checkPath?: string
  timeoutMs?: number
}): Promise<VerifyRow> {
  const script = 'voice'
  if (!existsSync(o.checkPath ?? VOICE_CHECK)) return { script, status: 'skipped', tail: 'Voice check script not found.' }
  const copy = copyAdds(o.diff)
  if (!copy) return { script, status: 'skipped', tail: 'No copy files in this change.' }
  mkdirSync(factoryTmpDir(), { recursive: true })
  const file = join(factoryTmpDir(), `${o.runId}-voice.txt`)
  writeFileSync(file, copy + '\n')
  const base = o.env || process.env
  const env: NodeJS.ProcessEnv = { ...base, PATH: ['/opt/homebrew/bin', '/usr/local/bin', base.PATH || ''].filter(Boolean).join(delimiter) }
  const args = voiceArgs(file, o.profile.voice.register || 'email', o.profile.voice.audience || 'client')
  try {
    return await new Promise<VerifyRow>((resolve) => {
      let out = ''
      let settled = false
      const finish = (row: VerifyRow) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(row)
      }
      let child: ChildProcess
      try {
        child = (o.spawnFn || spawn)('doppler', args, { cwd: factoryTmpDir(), env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      } catch (e) {
        resolve({ script, status: 'skipped', tail: `Could not start doppler: ${String((e as Error).message || e)}` })
        return
      }
      const add = (d: Buffer) => {
        out = (out + String(d)).slice(-20_000)
      }
      child.stdout?.on('data', add)
      child.stderr?.on('data', add)
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* gone */
        }
        finish({ script, status: 'skipped', tail: 'Voice check timed out.' })
      }, o.timeoutMs ?? VOICE_TIMEOUT_MS)
      child.on('error', (e) => {
        const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
        finish({ script, status: 'skipped', tail: missing ? 'doppler not found.' : String(e.message || e) })
      })
      child.on('close', (code) => {
        if (code === 0) finish({ script, status: 'pass', tail: tail(out) })
        else if (code === 2) finish({ script, status: 'fail', tail: tail(out) })
        else finish({ script, status: 'skipped', tail: `Voice check exited ${code}.${out ? `\n${tail(out, 6)}` : ''}` })
      })
    })
  } finally {
    try {
      unlinkSync(file)
    } catch {
      /* gone */
    }
  }
}
