/**
 * The per-turn Factory brief. Role, tier, and phase ride in every prompt so a resumed Grok
 * session does not depend on session/new rules. Hard cap 1,200 characters: the task (and note)
 * are cut, the rules lines never are.
 */

export const BRIEF_MAX = 1200

export type BriefPhase = 'build' | 'review' | 'trim'

export type BriefInput = {
  role: 'builder' | 'self-check'
  tier: 'T0' | 'T1'
  phase: BriefPhase
  workRepo: string
  brainPath: string
  task: string
  note?: string
}

const LIMIT_LINE: Record<'T0' | 'T1', string> = {
  T0: 'Limit T0: 1 file, 20 changed lines.',
  T1: 'Limit T1: up to 3 files, 150 changed lines, no new dependencies, no migrations.'
}

const PHASE_LINE: Record<BriefPhase, string> = {
  build: 'Make the change now.',
  review: 'Re-read your diff against the task. Fix only real mistakes, then stop.',
  trim: 'Your change is over the limit. Cut it down to fit, then stop.'
}

function cut(text: string, max: number): string {
  const t = String(text || '').trim()
  if (max <= 0) return ''
  if (t.length <= max) return t
  if (max <= 3) return t.slice(0, max)
  return t.slice(0, max - 3).trimEnd() + '...'
}

export function buildBrief(input: BriefInput): string {
  const rules = [
    `Factory run. Role: ${input.role}. Tier: ${input.tier}. Phase: ${input.phase}.`,
    `Work repo: ${input.workRepo}`,
    'Edit only under the work repo, with absolute paths. Do not edit the brain folder you are running in.',
    'No git push, no gh, no deploy, no publish. Do not commit. Brain commits after review.',
    LIMIT_LINE[input.tier],
    PHASE_LINE[input.phase]
  ].join('\n')
  let room = BRIEF_MAX - rules.length - '\n\nTask: '.length
  const noteRaw = String(input.note || '').trim()
  let note = ''
  if (noteRaw && room > 60) {
    note = cut(noteRaw, Math.min(360, Math.floor(room / 2)))
    room -= note.length + '\nNote: '.length
  }
  const task = cut(input.task, room)
  const out = `${rules}${note ? `\nNote: ${note}` : ''}\n\nTask: ${task}`
  return out.length > BRIEF_MAX ? out.slice(0, BRIEF_MAX) : out
}
