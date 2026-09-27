// Claude plan mode control answers. `claudePlanMode` waits 4s for the `set_permission_mode`
// control_response; after that the request is remembered as a late wait, so a slow answer still
// updates the plan-mode set and the chat instead of being dropped.

export type PlanControls = {
  /** Waiting callers, by request_id. */
  pending: Map<string, (ok: boolean) => void>
  /** Timed-out plan switches whose answer may still come, by request_id. */
  late: Map<string, { tabId: string; on: boolean }>
}

export type ControlOutcome =
  | { kind: 'pending' }
  | { kind: 'late'; tabId: string; on: boolean; ok: boolean }
  | { kind: 'none' }

export function newPlanControls(): PlanControls {
  return { pending: new Map(), late: new Map() }
}

/** The 4s wait ran out. Returns true when the request was still pending (now a late wait). */
export function controlTimedOut(c: PlanControls, requestId: string, wait: { tabId: string; on: boolean }): boolean {
  if (!c.pending.delete(requestId)) return false
  c.late.set(requestId, wait)
  return true
}

/**
 * A control_response arrived. Pending: resolve the waiting caller. Late: a success turns plan mode
 * on or off in `planTabs`; a failure leaves `planTabs` as it was.
 */
export function controlAnswered(c: PlanControls, requestId: string, ok: boolean, planTabs: Set<string>): ControlOutcome {
  const done = c.pending.get(requestId)
  if (done) {
    c.pending.delete(requestId)
    done(ok)
    return { kind: 'pending' }
  }
  const wait = c.late.get(requestId)
  if (!wait) return { kind: 'none' }
  c.late.delete(requestId)
  if (ok) {
    if (wait.on) planTabs.add(wait.tabId)
    else planTabs.delete(wait.tabId)
  }
  return { kind: 'late', tabId: wait.tabId, on: wait.on, ok }
}
