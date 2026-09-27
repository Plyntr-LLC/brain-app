/**
 * The per-turn Factory brief. Role, tier, and phase ride in every prompt so a resumed Grok
 * session does not depend on session/new rules. Hard cap 1,200 characters: the task (and note)
 * are cut, the rules lines (including plan and reviewer paths) never are.
 */

import type { Tier } from '../../shared/factory.ts'

export const BRIEF_MAX = 1200

export type BriefPhase = 'plan' | 'build' | 'review' | 'trim' | 'fix'

export type BriefInput = {
  role: 'builder' | 'self-check' | 'planner'
  tier: Tier
  phase: BriefPhase
  workRepo: string
  brainPath: string
  task: string
  note?: string
  /** Approved plan beside the run record. */
  planPath?: string
  /** Previous plan, for a fix-plan turn after a reject. */
  previousPlanPath?: string
  /** Last strict reviewer FAIL text beside the run record. */
  reviewPath?: string
}

const LIMIT_LINE: Record<Tier, string> = {
  T0: 'Limit T0: 1 file, 20 changed lines.',
  T1: 'Limit T1: up to 3 files, 150 changed lines, no new dependencies, no migrations.',
  T2: 'Limit T2: up to 10 files, 600 changed lines, no lockfile changes, no migrations.'
}

const PHASE_LINE: Record<BriefPhase, string> = {
  plan: 'Write a short plan: files, steps, tests. Do not edit files.',
  build: 'Make the change now.',
  review: 'Re-read your diff against the task. Fix only real mistakes, then stop.',
  trim: 'Your change is over the limit. Cut it down to fit, then stop.',
  fix: 'Fix what the reviewer names, then stop.'
}

function cut(text: string, max: number): string {
  const t = String(text || '').trim()
  if (max <= 0) return ''
  if (t.length <= max) return t
  if (max <= 3) return t.slice(0, max)
  return t.slice(0, max - 3).trimEnd() + '...'
}

export function buildBrief(input: BriefInput): string {
  const lines = [
    `Factory run. Role: ${input.role}. Tier: ${input.tier}. Phase: ${input.phase}.`,
    `Work repo: ${input.workRepo}`,
    'Edit only under the work repo, with absolute paths. Do not edit the brain folder you are running in.',
    'No git push, no gh, no deploy, no publish. Do not commit. Brain commits after review.',
    LIMIT_LINE[input.tier],
    PHASE_LINE[input.phase]
  ]
  if (input.planPath) lines.push(`Approved plan: ${input.planPath}. Read it first.`)
  if (input.previousPlanPath) lines.push(`Previous plan: ${input.previousPlanPath}`)
  if (input.reviewPath) lines.push(`Reviewer notes: ${input.reviewPath}. Fix what it names.`)
  const rules = lines.join('\n')
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
