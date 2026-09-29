import { basename } from 'node:path'
import { reviewAccept, splitOutside } from '../opus.ts'
import { RANK, type Risk, type Size } from '../triage.ts'

export const UNDER_WEIGHT = 3
export const OVER_WEIGHT = 1

/** Under-sizing skips safety checks, so each step under costs 3. Each step over costs 1 (extra phases). */
export function triageError(expected: Size, got: Size): number {
  const d = RANK[got] - RANK[expected]
  return d < 0 ? -d * UNDER_WEIGHT : d * OVER_WEIGHT
}

export type TriageGrade = { sizeOk: boolean; riskOk: boolean; error: number }

export function gradeTriage(expect: { size: Size; risk: Risk }, got: { size: Size; risk: Risk }): TriageGrade {
  return { sizeOk: expect.size === got.size, riskOk: expect.risk === got.risk, error: triageError(expect.size, got.size) }
}

export type Bug = { file: string; line?: number; symbol?: string; severity: 'critical' | 'elevated' | 'none' }

export const LINE_WINDOW = 5

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The review names the file, and either the symbol or a line within LINE_WINDOW of the bug. */
export function bugNamed(review: string, bug: Bug): boolean {
  const text = String(review || '')
  const base = basename(bug.file)
  if (!text.includes(bug.file) && !text.includes(base)) return false
  if (bug.symbol && text.includes(bug.symbol)) return true
  if (bug.line == null) return !bug.symbol
  const re = new RegExp(`${esc(base)}(?::|\\s+line\\s+)(\\d+)`, 'gi')
  for (const m of text.matchAll(re)) if (Math.abs(Number(m[1]) - bug.line) <= LINE_WINDOW) return true
  return false
}

export type ReviewGrade = {
  verdict: 'PASS' | 'FAIL'
  verdictOk: boolean
  named: number
  bugs: number
  /** A critical bug the review missed or passed. */
  missedCritical: boolean
  falseReject: boolean
}

/** parsed false (cut, over-cap, plain stdout) grades as FAIL, the same as the Factory reads it. */
export function gradeReview(expect: { verdict: 'PASS' | 'FAIL'; bugs: Bug[] }, text: string, parsed: boolean): ReviewGrade {
  const review = splitOutside(text).review
  const verdict = parsed && reviewAccept(review).status === 'pass' ? 'PASS' : 'FAIL'
  const named = expect.bugs.filter((b) => bugNamed(review, b)).length
  const missedCritical = expect.bugs.some((b) => b.severity === 'critical' && (verdict === 'PASS' || !bugNamed(review, b)))
  return { verdict, verdictOk: verdict === expect.verdict, named, bugs: expect.bugs.length, missedCritical, falseReject: expect.verdict === 'PASS' && verdict === 'FAIL' }
}
