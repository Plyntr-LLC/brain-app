let projectBound = false

export type PlyntrBindActor = {
  role?: string
  bootstrap?: boolean
  sessionKind?: string
}

/** Same gate as POST /v1/brains/:id/bind and live /owner/bind. */
export function plyntrBindAllowed(actor: PlyntrBindActor | null): { ok: true } | { ok: false; detail: string } {
  if (actor && actor.role === 'owner') return { ok: true }
  if (actor && actor.role === 'scout' && actor.bootstrap) return { ok: true }
  if (!actor?.role || actor.sessionKind === 'platform') {
    return { ok: false, detail: 'company login only' }
  }
  return { ok: false, detail: 'Only the bootstrap scout or the client owner can connect this brain.' }
}

/** A platform login stays the platform login. Connect must not replace it. */
export function storeBrainOwnerSession(sessionKind: string | undefined): boolean {
  return sessionKind !== 'platform'
}

export function dryRunOwnerBind(
  hqRepo: string,
  sessionKind?: string
): {
  ok: boolean
  hq_repo: string
  projects: string[]
  detail: string
} {
  const repo = String(hqRepo || '').trim()
  if (!sessionKind) {
    return { ok: false, hq_repo: repo, projects: [], detail: 'Sign in for project sync first.' }
  }
  if (sessionKind !== 'owner') {
    return { ok: false, hq_repo: repo, projects: [], detail: 'company login only' }
  }
  projectBound = true
  return { ok: true, hq_repo: repo, projects: [], detail: 'Connected.' }
}

export function dryRunPlyntrBind(
  hqRepo: string,
  actor: PlyntrBindActor | null
): {
  ok: boolean
  hq_repo: string
  projects: string[]
  detail: string
} {
  const repo = String(hqRepo || '').trim()
  const gate = plyntrBindAllowed(actor)
  if (!gate.ok) return { ok: false, hq_repo: repo, projects: [], detail: gate.detail }
  projectBound = true
  return { ok: true, hq_repo: repo, projects: [], detail: 'Connected.' }
}

export function dryRunInstalledBody(repo: string): {
  installed: true
  repositorySelection: 'selected'
  repo: string
  projectSeatCount: number
} {
  return {
    installed: true,
    repositorySelection: 'selected',
    repo,
    projectSeatCount: projectBound ? 1 : 0
  }
}

export function dryRunProjectInvite(roots: unknown):
  | { ok: false; detail: string }
  | {
      ok: true
      inviteId: string
      code: string
      expiresAt: string
      needsBridge: boolean
      projectSeatCount: number
    } {
  if (!Array.isArray(roots) || roots.length === 0) {
    return { ok: false, detail: 'Tick at least one project.' }
  }
  return {
    ok: true,
    inviteId: 'dry-project',
    code: 'PR0J3CT12X',
    expiresAt: '2099-01-01T00:00:00.000Z',
    needsBridge: !projectBound,
    projectSeatCount: 1
  }
}
