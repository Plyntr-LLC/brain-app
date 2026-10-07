import { execFileSync, spawn } from 'node:child_process'
import { deployWatchLine, type DeployWatch } from '../../shared/factory.ts'
import { noShimPath, realGit } from './gates.ts'

/**
 * After a push Brain watches GitHub for that commit's deploy with the person's own gh login (the real gh,
 * never the Factory shim): deployments for the sha with each one's newest status, the commit's statuses,
 * and its check runs. nextWatch turns each poll into the next DeployWatch.
 */

export const WATCH_POLL_MS = 10_000
export const WATCH_NONE_MS = 3 * 60_000
export const WATCH_STUCK_MS = 20 * 60_000
const GH_TIMEOUT_MS = 20_000

export const STUCK_WHY = 'still building after 20 minutes, check the host.'

export type GhRepo = { owner: string; repo: string }

const OWNER = '([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)'
const NAME = '([A-Za-z0-9._-]+?)'
const GITHUB_REMOTES = [
  new RegExp(`^(?:https?|git|ssh)://(?:[^@/\\s]+@)?(?:www\\.)?github\\.com(?::\\d+)?/${OWNER}/${NAME}(?:\\.git)?/?$`, 'i'),
  new RegExp(`^(?:[^@/\\s]+@)?github\\.com:${OWNER}/${NAME}(?:\\.git)?/?$`, 'i')
]

/** owner and repo of a github.com remote (https, git@, ssh://). Null for any other host, a local path, or an SSH alias. */
export function githubRepo(url: string): GhRepo | null {
  const u = String(url || '').trim()
  for (const re of GITHUB_REMOTES) {
    const m = re.exec(u)
    if (m && m[2] !== '.' && m[2] !== '..') return { owner: m[1], repo: m[2] }
  }
  return null
}

type DeployStatus = { state?: string; environment_url?: string; target_url?: string }
export type GhDeployment = { id?: number; sha?: string; environment?: string; creator?: { login?: string }; status?: DeployStatus }
export type GhStatus = { context?: string; state?: string; target_url?: string }
export type GhCheck = { name?: string; status?: string; conclusion?: string | null; details_url?: string; app?: { slug?: string; name?: string } }
/** One poll of the three GitHub reads. Each deployment carries its newest status. */
export type GhPoll = { deployments: GhDeployment[]; statuses: GhStatus[]; checks: GhCheck[] }

type Phase = 'building' | 'live' | 'failed'
type Signal = { phase: Phase; host: string; env?: string; url?: string }

const HOSTS: [RegExp, string][] = [
  [/vercel/i, 'Vercel'],
  [/netlify/i, 'Netlify'],
  [/railway/i, 'Railway'],
  [/\brender\b/i, 'Render'],
  [/cloudflare/i, 'Cloudflare'],
  [/\bfly(?:\.io|ctl)?\b/i, 'Fly']
]

function hostIn(...texts: (string | undefined)[]): string {
  for (const t of texts) for (const [re, name] of HOSTS) if (t && re.test(t)) return name
  return ''
}

const DEPLOY_PHASE: Record<string, Phase> = { success: 'live', error: 'failed', failure: 'failed', in_progress: 'building', queued: 'building', pending: 'building' }
const STATUS_PHASE: Record<string, Phase> = { success: 'live', failure: 'failed', error: 'failed', pending: 'building' }
const CHECK_PHASE: Record<string, Phase> = { success: 'live', failure: 'failed', timed_out: 'failed', action_required: 'failed', startup_failure: 'failed' }

/**
 * This commit's deploy signals. Deployments for this sha count whoever made them; a push to main or
 * master never counts a preview one. With none, a status or check that names a host.
 */
function signals(poll: GhPoll, sha: string, prod: boolean): Signal[] {
  const deployments = poll.deployments.filter((d) => d.sha === sha && d.status?.state !== 'inactive' && !(prod && /preview/i.test(String(d.environment || ''))))
  if (deployments.length) {
    return deployments.map((d) => {
      const url = d.status?.environment_url || d.status?.target_url || undefined
      const login = String(d.creator?.login || '').replace(/\[bot\]$/, '')
      return { phase: DEPLOY_PHASE[String(d.status?.state)] || 'building', host: hostIn(login, d.environment, url) || login || 'The host', env: d.environment || undefined, url }
    })
  }
  const out: Signal[] = []
  for (const s of poll.statuses) {
    const host = hostIn(s.context)
    const phase = STATUS_PHASE[String(s.state)]
    if (host && phase) out.push({ phase, host, url: s.target_url || undefined })
  }
  for (const c of poll.checks) {
    const host = hostIn(c.app?.slug, c.app?.name, c.name)
    const phase = c.status !== 'completed' ? 'building' : CHECK_PHASE[String(c.conclusion)]
    if (host && phase) out.push({ phase, host, url: c.details_url || undefined })
  }
  return out
}

const ORDER: Phase[] = ['building', 'failed', 'live']

/**
 * The next watch state from one poll (null when the poll failed; error says why). Anything still building
 * keeps it building; a failure beats a success. No signal for noneMs after the push is none (unknown when
 * no poll got through); building for stuckMs is unknown.
 */
export function nextWatch(prev: DeployWatch, poll: GhPoll | null, o: { sha: string; prod: boolean; now: number; noneMs: number; stuckMs: number; error?: string }): DeployWatch {
  const all = poll ? signals(poll, o.sha, o.prod) : []
  const sig = ORDER.map((p) => all.find((s) => s.phase === p)).find(Boolean)
  const where = (s: Signal | Extract<DeployWatch, { state: 'building' }>) => ({ host: s.host, ...(s.env ? { env: s.env } : {}), ...(s.url ? { url: s.url } : {}) })
  if (sig && sig.phase !== 'building') return { state: sig.phase, ...where(sig), at: o.now }
  if (sig || prev.state === 'building') {
    const since = prev.state === 'building' ? prev.since : o.now
    if (o.now - since >= o.stuckMs) return { state: 'unknown', why: STUCK_WHY, at: o.now }
    return { state: 'building', ...where(sig || (prev as Extract<DeployWatch, { state: 'building' }>)), since }
  }
  if (prev.state === 'watching' && o.now - prev.since >= o.noneMs) {
    return poll ? { state: 'none', at: o.now } : { state: 'unknown', why: `GitHub did not answer: ${o.error || 'no reply'}`.slice(0, 300), at: o.now }
  }
  return prev
}

const DONE = new Set<DeployWatch['state']>(['live', 'failed', 'none', 'unknown'])

type GhOut = { ok: boolean; missing: boolean; code: number; out: string; err: string }

function gh(args: string[], env: NodeJS.ProcessEnv): Promise<GhOut> {
  return new Promise((done) => {
    let out = ''
    let err = ''
    const child = spawn('gh', args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const timer = setTimeout(() => child.kill('SIGKILL'), GH_TIMEOUT_MS)
    child.stdout?.on('data', (d: Buffer) => (out += String(d)))
    child.stderr?.on('data', (d: Buffer) => (err = (err + String(d)).slice(-2000)))
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ ok: false, missing: (e as NodeJS.ErrnoException).code === 'ENOENT', code: 127, out: '', err: String(e.message || e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ ok: code === 0, missing: false, code: code ?? 1, out, err })
    })
  })
}

async function api(path: string, env: NodeJS.ProcessEnv): Promise<{ json: unknown; why: string }> {
  const r = await gh(['api', path], env)
  if (!r.ok) return { json: null, why: (r.err.trim().split('\n')[0] || `gh api exited ${r.code}`).slice(0, 200) }
  try {
    return { json: JSON.parse(r.out), why: '' }
  } catch {
    return { json: null, why: 'gh api did not answer with JSON.' }
  }
}

async function poll(repo: GhRepo, sha: string, env: NodeJS.ProcessEnv): Promise<{ poll: GhPoll | null; why: string }> {
  const base = `repos/${repo.owner}/${repo.repo}`
  const [deps, status, checks] = await Promise.all([api(`${base}/deployments?sha=${sha}&per_page=20`, env), api(`${base}/commits/${sha}/status`, env), api(`${base}/commits/${sha}/check-runs`, env)])
  const why = deps.why || status.why || checks.why
  if (why) return { poll: null, why }
  const list = (Array.isArray(deps.json) ? deps.json : []).slice(0, 10) as GhDeployment[]
  const deployments = await Promise.all(
    list.map(async (d) => {
      const s = await api(`${base}/deployments/${Number(d.id)}/statuses?per_page=1`, env)
      return { ...d, status: Array.isArray(s.json) ? (s.json[0] as DeployStatus | undefined) : undefined }
    })
  )
  const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
  const statuses = rec(status.json).statuses
  const runs = rec(checks.json).check_runs
  return { poll: { deployments, statuses: Array.isArray(statuses) ? statuses : [], checks: Array.isArray(runs) ? runs : [] }, why: '' }
}

function remoteUrl(repo: string, remote: string): string {
  try {
    return execFileSync(realGit(), ['remote', 'get-url', remote], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
  } catch {
    return ''
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        done()
      },
      { once: true }
    )
  })

/** How a watch ended. cannot: Brain could not watch at all (no gh, gh signed out, not a github.com remote). */
export type WatchEnd = { watch: DeployWatch; cannot: boolean }

/**
 * One watch of the pushed commit, polled until live, failed, none or unknown. onState gets every new
 * state after the first. Null when the signal aborts it (abandon, a new push, an app quit).
 */
export async function watchDeploy(o: {
  repo: string
  remote: string
  branch: string
  sha: string
  since: number
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  onState: (w: DeployWatch) => void
  pollMs?: number
  noneMs?: number
  stuckMs?: number
}): Promise<WatchEnd | null> {
  const cannot = (why: string): WatchEnd => {
    const watch: DeployWatch = { state: 'unknown', why, at: Date.now() }
    o.onState(watch)
    return { watch, cannot: true }
  }
  const repo = githubRepo(remoteUrl(o.repo, o.remote))
  if (!repo) return cannot(`${o.remote} is not a github.com remote.`)
  const env: NodeJS.ProcessEnv = { ...o.env, PATH: noShimPath(o.env.PATH), GH_PROMPT_DISABLED: '1' }
  const auth = await gh(['auth', 'status', '--hostname', 'github.com'], env)
  if (o.signal.aborted) return null
  if (auth.missing) return cannot('the GitHub CLI (gh) is not installed.')
  if (!auth.ok) return cannot('the GitHub CLI is not signed in (gh auth login).')
  const prod = o.branch === 'main' || o.branch === 'master'
  let w: DeployWatch = { state: 'watching', since: o.since }
  for (;;) {
    const got = await poll(repo, o.sha, env)
    if (o.signal.aborted) return null
    const next = nextWatch(w, got.poll, { sha: o.sha, prod, now: Date.now(), noneMs: o.noneMs ?? WATCH_NONE_MS, stuckMs: o.stuckMs ?? WATCH_STUCK_MS, error: got.why })
    if (next.state !== w.state || deployWatchLine(next) !== deployWatchLine(w)) o.onState(next)
    w = next
    if (DONE.has(w.state)) return { watch: w, cannot: false }
    await sleep(o.pollMs ?? WATCH_POLL_MS, o.signal)
    if (o.signal.aborted) return null
  }
}
