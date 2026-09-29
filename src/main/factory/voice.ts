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
    if (!line.startsWith('+') || line.startsWith('+++') || !COPY_RE.test(file)) continue
    const text = HTML_RE.test(file) ? visibleText(line.slice(1)) : line.slice(1)
    if (text || !HTML_RE.test(file)) out.push(text)
  }
  return out.join('\n').trim()
}

const HTML_RE = /\.html?$/i

/** The words a person sees on an HTML line: tags and attributes out, common entities decoded. */
export function visibleText(line: string): string {
  return String(line || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** What each voice-check reason asks for, in plain words, for the builder's fix turn. */
export const VOICE_HINTS: [RegExp, string][] = [
  [/contrast framing/i, "contrast framing: state the positive claim; drop 'not X but Y' / 'no X, just Y' / 'instead of X'."],
  [/staccato negation|No X\. No Y/i, 'staccato negation: drop runs of short negations; say what it is.'],
  [/performing sincerity/i, "performing sincerity: cut 'honestly', 'to be clear', 'I want to be transparent'."],
  [/commenting on the writing/i, "commenting on the writing: cut lines about the text itself ('here's the thing')."],
  [/trailing participle/i, "trailing participle: end on the point, not an '-ing' tail (', making it easier')."],
  [/AI as the mechanism/i, 'AI as the mechanism: say what the person gets, not that AI does it.'],
  [/fear selling/i, 'fear selling: remove urgency or fear; state the benefit plainly.'],
  [/unearned absolute/i, "unearned absolute: drop 'always', 'never', 'guaranteed' unless literally true."],
  [/punch-line/i, 'punch-line commentary: remove jokes or verdicts about people.'],
  [/opening/i, 'opening: lead with the point in the first line.'],
  [/register match/i, 'register match: plain, direct, short sentences; sound like Joe for this kind of copy.'],
  [/rhythm|read-aloud/i, 'rhythm / read-aloud: read it aloud; vary sentence length; cut filler.'],
  [/Gate 2: length/i, 'length: cut padding; say it in fewer words.'],
  [/would not ship unchanged/i, 'would not ship unchanged: rewrite until each line would ship as is.'],
  [/em dash/i, 'em dash: use a period or a comma instead.'],
  [/banned word/i, 'banned word: replace the word it names with a plain one.'],
  [/clich/i, 'cliché: replace it with a plain statement.'],
  [/over 400 characters/i, 'too long for a text: keep it under 400 characters.']
]

export const VOICE_RULES = '/Users/joewine/Projects/agency-brain/context/business/voice/anti-patterns.md'

/** The notes file a voice fix turn reads: the copy that was checked, every reason, and what each asks. */
export function voiceNotes(o: { copy: string; out: string; attempt: number; max: number }): string {
  const reasons = String(o.out || '')
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\.\s*/, '').trim())
    .filter((l) => /^Gate \d/i.test(l))
  const hints = [...new Set(reasons.flatMap((r) => VOICE_HINTS.filter(([re]) => re.test(r)).map(([, h]) => h)))]
  return [
    `# Voice check said REJECT (attempt ${o.attempt} of ${o.max})`,
    '',
    '## Copy that was checked',
    '',
    o.copy || '(no copy)',
    '',
    '## Reasons',
    '',
    ...(reasons.length ? reasons.map((r) => `- ${r}`) : [`- ${String(o.out || '').trim().split('\n').slice(-6).join(' ')}`]),
    '',
    '## What to change',
    '',
    ...(hints.length ? hints.map((h) => `- ${h}`) : ['- Rewrite the copy plainly and directly.']),
    '',
    `House rules: ${VOICE_RULES}`
  ].join('\n')
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
