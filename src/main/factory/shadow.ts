import { randomUUID } from 'node:crypto'
import { REVIEW_MAX, type JudgmentAction, type RunRecord, type Shadow, type ShadowGate } from '../../shared/factory.ts'
import { realish } from './paths.ts'

/**
 * Shadow ledger: what the loop would have done at each finishReview (the gate), and what Joe did about
 * it (one judgment per gate, clicks only). Agreement over judgments is what earns Ship in advance.
 */

const empty = (): Shadow => ({ judgments: [], auto: 0 })

export function gateFor(run: RunRecord, o: { needed: boolean; ourFail: boolean; model?: string }): ShadowGate {
  const hold = run.voice?.status === 'fail' || o.ourFail
  const s = run.strict?.status
  const strict: ShadowGate['strict'] =
    s === 'pass' ? 'pass' : s === 'fail' && (run.reviewCycles || 0) >= REVIEW_MAX ? 'held' : s === 'missing' ? 'missing' : 'none'
  const wouldShip = !hold && (strict === 'pass' || (strict === 'none' && !o.needed))
  return { id: randomUUID(), wouldShip, strict, model: o.model || '', at: Date.now() }
}

export function withGate(shadow: Shadow | undefined, gate: ShadowGate): Shadow {
  return { ...(shadow || empty()), gate }
}

/** An automatic ship on this gate. Counted once per gate, never a judgment. */
export function withAuto(shadow: Shadow | undefined): Shadow {
  const s = shadow || empty()
  const id = s.gate?.id
  if (!id || s.autoGates?.includes(id)) return s
  return { ...s, auto: s.auto + 1, autoGates: [...(s.autoGates || []), id].slice(-20) }
}

const judged = (s: Shadow, id: string): boolean => s.judgments.some((j) => j.gate === id)

export function agrees(wouldShip: boolean, action: JudgmentAction): boolean {
  return wouldShip ? action === 'commit' || action === 'push' : action === 'guide' || action === 'abandon'
}

/** Joe's click on the current gate. No gate, or a gate he already judged, adds nothing. */
export function withJudgment(shadow: Shadow | undefined, action: JudgmentAction): Shadow {
  const s = shadow || empty()
  const g = s.gate
  if (!g) return action === 'abandon' ? { ...s, noGate: true } : s
  if (judged(s, g.id)) return s
  return { ...s, judgments: [...s.judgments, { gate: g.id, wouldShip: g.wouldShip, action, agree: agrees(g.wouldShip, action), at: Date.now() }] }
}

export function gateOpen(shadow: Shadow | undefined): boolean {
  return !!shadow?.gate && !judged(shadow, shadow.gate.id)
}

export type Agreement = { repo: string; agree: number; judged: number; streak: number; auto: number; noGate: number }

export function agreement(runs: RunRecord[]): Agreement[] {
  const by = new Map<string, RunRecord[]>()
  for (const r of runs) {
    const key = realish(r.workRepo)
    by.set(key, [...(by.get(key) || []), r])
  }
  return [...by.entries()].map(([repo, list]) => {
    const all = list.flatMap((r) => r.shadow?.judgments || []).sort((a, b) => a.at - b.at)
    let streak = 0
    for (let i = all.length - 1; i >= 0 && all[i].agree; i--) streak++
    return {
      repo,
      agree: all.filter((j) => j.agree).length,
      judged: all.length,
      streak,
      auto: list.reduce((n, r) => n + (r.shadow?.auto || 0), 0),
      noGate: list.filter((r) => r.shadow?.noGate && !(r.shadow?.judgments.length)).length
    }
  })
}

export function agreementLine(a: Agreement): string {
  return `agree ${a.agree}/${a.judged}, streak ${a.streak}, auto ${a.auto}, noGate ${a.noGate}`
}
