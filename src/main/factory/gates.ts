import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { askFacts, askPaths, fastAllow, type AskFacts } from './approver.ts'
import { currentBranch, hasRemote, headSha } from './git-audit.ts'
import { realish, underPath } from './paths.ts'
import type { Approver } from '../../shared/factory.ts'

export const PUSH_REFUSAL = 'Factory runs do not push. Brain commits on the work repo after review; pushing stays a person\'s call.'
export const GH_REFUSAL = 'Factory runs do not use gh. Pull requests and releases stay a person\'s call.'
export const PUBLISH_REFUSAL = 'Factory runs do not deploy or publish. Deploy stays a person\'s click.'
export const BRAIN_WRITE_REFUSAL =
  'Factory edits land in the work repo only. This path is in the brain folder, and the brain syncs, so Brain refused it.'

/** Publish verbs the model never runs (Push is a person's click, done by Brain), with the sentence each refusal gives. Matched against a permission ask's title and raw input. */
const DENY_CMDS: [RegExp, string][] = [
  [/\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+\s+|-\S+\s+)*push\b/i, PUSH_REFUSAL],
  [/(?:^|[\s;&|(`'"])gh\s/i, GH_REFUSAL],
  [
    /\bwrangler\s+(?:[\w:-]+\s+)*deploy\b|\b(?:npm|yarn|pnpm|bun)\s+publish\b|\bvercel(?=[\s"'`;&|]|$)|\bfly(?:ctl)?\s+deploy\b|\bnetlify\s+deploy\b|\bfirebase\s+deploy\b|\bgcloud\s+\S+\s+deploy\b|\bheroku\s+(?:git:)?push\b/i,
    PUBLISH_REFUSAL
  ]
]

type Msg = { params?: unknown }

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export const OTHER_REPO_WRITE_REFUSAL = 'Factory edits land in the work repo only. This path is in another repo, so Brain refused it.'
export const WATCH_WRITE_REFUSAL = 'This session only watches the run. It does not edit files.'

/** Git top of the nearest folder that exists at or above p. Empty when none (tmp). */
function repoTopOf(p: string): string {
  let cur = p
  while (!existsSync(cur)) {
    const up = dirname(cur)
    if (up === cur) return ''
    cur = up
  }
  try {
    if (!statSync(cur).isDirectory()) cur = dirname(cur)
    const top = execFileSync(realGit(), ['rev-parse', '--show-toplevel'], {
      cwd: cur,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return top ? realish(top) : ''
  } catch {
    return ''
  }
}

/**
 * Empty when this write may go ahead. A sentence when it lands in the brain while the work repo is
 * elsewhere, or in another git repo than the work repo. Paths in no git repo (tmp) may be written.
 */
export function factoryWriteBlock(abs: string, brainPath: string, workRepo: string): string | null {
  if (!brainPath || !abs || !isAbsolute(abs)) return null
  const brain = realish(brainPath)
  const work = workRepo ? realish(workRepo) : ''
  const target = realish(abs)
  if (underPath(brain, target)) {
    // A work repo inside the brain may be edited; the rest of the brain may not.
    if (work && underPath(brain, work) && underPath(work, target)) return null
    return BRAIN_WRITE_REFUSAL
  }
  if (!work || underPath(work, target)) return null
  const top = repoTopOf(target)
  return top && top !== work ? OTHER_REPO_WRITE_REFUSAL : null
}

/** The orchestrator tab watches the run. It does not get the builder's edit rules. */
export const WATCH_RULES =
  'You watch this factory run. Answer in sentences. Do not edit files. Do not push, commit, or deploy. To change the work, end with one line FACTORY_TELL: and the instruction.'

/** Empty means this tab is a builder and keeps the builder rules. */
export function factorySessionRules(tabId: string): string {
  return tabId.endsWith('-orch') ? WATCH_RULES : ''
}

const READ_KINDS = new Set(['read', 'search', 'fetch', 'think'])

export type AskRoute = 'reject' | 'allow' | 'judge' | 'card'

/**
 * Where a Factory permission ask goes. Watch-only rejects every non-read tool. The filter's reject always
 * stands. With no approver (off, or a run from before 0.1.124): Approve in advance allows, else the card.
 * With an approver: fast asks are allowed, the rest go to the model.
 */
export function askRoute(o: { watchOnly: boolean; kind: string; filtered: 'reject' | 'ask'; runThrough: boolean; approver?: Approver; fast: boolean }): AskRoute {
  if (o.watchOnly && !READ_KINDS.has(o.kind)) return 'reject'
  if (o.filtered === 'reject') return 'reject'
  if (o.watchOnly) return 'allow'
  if (!o.approver || o.approver === 'off') return o.runThrough ? 'allow' : 'card'
  return o.fast ? 'allow' : 'judge'
}

/** The sentence an ask is refused with: a publish verb, or an edit outside the work repo (brain or another repo). Null: the card or the approver decides. */
export function factoryRefusal(msg: Msg, ctx: { brainPath: string; workRepo: string }): string | null {
  const p = rec(msg.params)
  const tool = rec(p.toolCall)
  const blob = [p.title, tool.title, tool.kind, JSON.stringify(tool.rawInput ?? ''), JSON.stringify(tool.content ?? '')]
    .map((x) => String(x ?? ''))
    .join(' ')
  const verb = DENY_CMDS.find(([re]) => re.test(blob))
  if (verb) return verb[1]
  // Reads are fine (brain rules, skills, other repos); edits are not.
  if (READ_KINDS.has(String(tool.kind || '').toLowerCase())) return null
  for (const raw of askPaths(msg)) {
    // Grok's cwd is the brain, so a relative path lands in the brain.
    const path = isAbsolute(raw) ? raw : ctx.brainPath ? resolve(ctx.brainPath, raw) : ''
    const block = path ? factoryWriteBlock(path, ctx.brainPath, ctx.workRepo) : null
    if (block) return block
  }
  return null
}

/** 'reject' for publish verbs and edits outside the work repo (brain or another repo), 'ask' for everything else (the card decides). */
export function filterFactoryPermission(msg: Msg, ctx: { brainPath: string; workRepo: string }): 'reject' | 'ask' {
  return factoryRefusal(msg, ctx) ? 'reject' : 'ask'
}

export type AskCtx = { brainPath: string; workRepo: string; runThrough?: boolean; watchOnly?: boolean; approver?: Approver }

/**
 * One route for every Factory builder ask, Grok's ACP asks and the Opus builder's tool asks alike: the
 * hard filter, then the fast path, then askRoute. why: the sentence a reject gives the builder.
 */
export function routeFactoryAsk(msg: Msg, ctx: AskCtx): { route: AskRoute; facts: AskFacts; why: string } {
  const facts = askFacts(msg)
  const refusal = factoryRefusal(msg, ctx)
  const route = askRoute({
    watchOnly: !!ctx.watchOnly,
    kind: facts.kind,
    filtered: refusal ? 'reject' : 'ask',
    runThrough: !!ctx.runThrough,
    approver: ctx.approver,
    fast: fastAllow(facts, ctx)
  })
  return { route, facts, why: route === 'reject' ? refusal || WATCH_WRITE_REFUSAL : '' }
}

/** The real git binary, never a shim. */
export function realGit(): string {
  for (const p of ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']) if (existsSync(p)) return p
  return 'git'
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Writes git and gh wrappers into dir. git refuses push and execs the real git otherwise; gh always refuses. */
export function ensureShims(dir: string, gitBin = realGit()): string {
  mkdirSync(dir, { recursive: true })
  const git = `#!/bin/sh
# Brain Factory shim: refuses git push, passes everything else to the real git.
sub=""
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env) skip=1 ;;
    -*) ;;
    *) sub="$a"; break ;;
  esac
done
if [ "$sub" = "push" ] || [ "$sub" = "send-pack" ]; then
  echo ${shq(PUSH_REFUSAL)} >&2
  exit 1
fi
exec ${shq(gitBin)} "$@"
`
  const gh = `#!/bin/sh
# Brain Factory shim: gh is off in Factory runs.
echo ${shq(GH_REFUSAL)} >&2
exit 1
`
  for (const [name, body] of [
    ['git', git],
    ['gh', gh]
  ] as const) {
    const p = join(dir, name)
    writeFileSync(p, body)
    chmodSync(p, 0o755)
  }
  return dir
}

/** Child env for every Factory process: shims first on PATH, no Anthropic API keys. */
export function factoryEnv(base: NodeJS.ProcessEnv, shimDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PATH: `${shimDir}${delimiter}${base.PATH || ''}` }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_TRANSLATOR_API_KEY
  return env
}

/** Branches Brain never pushes unless Joe clicks Push anyway (Joe 2026-09-29: main and master push normally). */
export const PROTECTED_BRANCHES = new Set(['staging', 'prod', 'production'])

/** Kennel's main, master, and staging go through its Opus 5.5 CLI gate (Joe's standing rule). */
export const KENNEL_GATED = new Set(['main', 'master', 'staging'])
export const KENNEL_PUSH_REFUSAL = 'Brain does not push Kennel main or staging. That goes through the Opus 5.5 Claude CLI gate.'

export type PushOverride = { allowProtected?: boolean; kennelApproved?: boolean }

/** preview: push this sha to a new remote branch (factory/<run id>) without touching the local branch. */
export type PublishTarget = { remote: string; branch: string; sha: string; preview?: boolean }

export type HostDeploy = { host: 'Vercel' | 'Netlify' | 'Railway'; prod: boolean }

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * A host that deploys this repo on a push, read from the link file its CLI writes (no host API).
 * prod: the branch is main or master, which these hosts deploy to production by default.
 * vercel.json, an empty .vercel folder, or a vercel script is not a link.
 */
export function hostDeploy(repo: string, branch: string): HostDeploy | null {
  const prod = branch === 'main' || branch === 'master'
  try {
    const link = JSON.parse(readFileSync(join(repo, '.vercel', 'project.json'), 'utf8')) as { projectId?: unknown }
    if (typeof link.projectId === 'string' && link.projectId) return { host: 'Vercel', prod }
  } catch {
    /* not linked to Vercel */
  }
  if (isFile(join(repo, '.netlify', 'state.json')) || isFile(join(repo, 'netlify.toml'))) return { host: 'Netlify', prod }
  if (isFile(join(repo, 'railway.json')) || isFile(join(repo, 'railway.toml'))) return { host: 'Railway', prod }
  return null
}

/** What a push of this branch sets off on its host, in one sentence. */
export function deployLine(hd: HostDeploy, remote: string, branch: string): string {
  return hd.prod ? `Pushing ${branch} to ${remote} deploys production on ${hd.host}.` : `${hd.host} builds a preview of this branch.`
}

function remoteRef(repo: string, remote: string, branch: string): string {
  try {
    return execFileSync(realGit(), ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}`], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

/**
 * Null when Push may run. Otherwise the one sentence the disabled Push shows. The git guards always run;
 * the override skips only the protected check (allowProtected) and the Kennel check (kennelApproved).
 */
export function publishBlock(o: { repo: string } & Partial<PublishTarget>, over: PushOverride = {}): string | null {
  const branch = String(o.branch || '')
  const remote = String(o.remote || '')
  if (!branch) return 'This commit is on a detached HEAD. Push it from Terminal.'
  // A preview pushes the run's own commit to factory/<id>: the local branch may have moved on.
  if (!o.preview) {
    const now = currentBranch(o.repo)
    if (!now) return 'This repo is on a detached HEAD. Push it from Terminal.'
    if (now !== branch || headSha(o.repo) !== o.sha) return 'This branch moved since Factory committed. Push from Terminal.'
  }
  if (!remote || !hasRemote(o.repo, remote)) return `This repo has no remote named ${remote || 'origin'}.`
  if (o.sha && remoteRef(o.repo, remote, branch) === o.sha) return `Already pushed to ${remote}/${branch}.`
  if (!over.kennelApproved && isKennelGated(o.repo, branch)) return KENNEL_PUSH_REFUSAL
  if (!over.allowProtected && PROTECTED_BRANCHES.has(branch)) return `Brain does not push to ${branch}. Push it from Terminal after review.`
  return null
}

export function isKennelGated(repo: string, branch: string): boolean {
  return KENNEL_RE.test(String(repo || '')) && KENNEL_GATED.has(branch)
}

/**
 * What Start can already tell about Push: no remote at all, or Ship in advance on a branch Brain never
 * pushes. Null when neither. The Push click still runs publishBlock; this only says it early.
 */
export function pushWarn(o: { repo: string; remote: string; shipThrough?: boolean }): string | undefined {
  const remote = String(o.remote || 'origin')
  if (!hasRemote(o.repo, remote)) return `No remote named ${remote}. Factory commits here but cannot push.`
  const branch = currentBranch(o.repo)
  if (branch && isKennelGated(o.repo, branch)) return `On Kennel ${branch}. Brain pushes it only through the Kennel gate, on your Push anyway click.`
  if (o.shipThrough && branch && PROTECTED_BRANCHES.has(branch)) {
    return `On ${branch}. Ship in advance commits but Brain never pushes ${branch} on its own.`
  }
  const hd = o.shipThrough && branch ? hostDeploy(o.repo, branch) : null
  if (hd?.prod) return `Ship in advance will stop before pushing ${branch}: ${hd.host} deploys ${branch} to production.`
  return undefined
}

/** PATH without the Factory shim dir: person clicks (Push, Deploy) use the real tools. */
export function noShimPath(path: string | undefined): string {
  return String(path || '')
    .split(delimiter)
    .filter((d) => d && !/[\\/]factory[\\/]bin$/.test(d))
    .join(delimiter)
}

/** The Push click: real git, never the shim dir, no prompts, 90 s. Refuses anything publishBlock names. */
export function publish(workRepo: string, t: PublishTarget, timeoutMs = 90_000, over: PushOverride = {}): Promise<{ ok: boolean; out: string }> {
  const block = publishBlock({ repo: workRepo, ...t }, over)
  if (block) return Promise.resolve({ ok: false, out: block })
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: noShimPath(process.env.PATH), GIT_TERMINAL_PROMPT: '0' }
  return new Promise((done) => {
    const ref = t.preview ? `${t.sha}:refs/heads/${t.branch}` : t.branch
    const child = spawn(realGit(), ['push', t.remote, ref], { cwd: workRepo, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let out = ''
    const add = (d: Buffer) => {
      out = (out + String(d)).slice(-4000)
    }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ ok: false, out: String(e.message || e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ ok: code === 0, out: out.trim() || (code === 0 ? '' : `git push exited ${code}`) })
    })
  })
}

/** Kennel ships through its own Opus 5.5 CLI gate, never a Factory click. */
export const KENNEL_RE = /mykennel/i
export const KENNEL_DEPLOY_REFUSAL = 'Brain never deploys Kennel. Its staging and main go through the Opus 5.5 Claude CLI gate.'
export const NO_DEPLOY_CMD = 'No deploy command on this repo.'

/** Null when Deploy may run. Otherwise the one sentence the disabled Deploy shows. */
export function deployBlock(o: { repo: string; cmd?: string }): string | null {
  if (KENNEL_RE.test(String(o.repo || ''))) return KENNEL_DEPLOY_REFUSAL
  if (!String(o.cmd || '').trim()) return NO_DEPLOY_CMD
  return null
}

export type DeploySpawn = (bin: string, args: string[], opts: SpawnOptions) => ChildProcess

/**
 * The Deploy click: the profile's cmd through /bin/sh in the work repo, no shims on PATH, no git
 * prompts, 10 min. The cmd itself is never logged or copied onto the run.
 */
export function deploy(
  workRepo: string,
  cmd: string,
  o: { spawnFn?: DeploySpawn; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ ok: boolean; out: string }> {
  const block = deployBlock({ repo: workRepo, cmd })
  if (block) return Promise.resolve({ ok: false, out: block })
  const base = o.env || process.env
  const env: NodeJS.ProcessEnv = { ...base, PATH: noShimPath(base.PATH), GIT_TERMINAL_PROMPT: '0' }
  return new Promise((done) => {
    let child: ChildProcess
    try {
      // Own process group so a timeout kills what the cmd started, not only /bin/sh.
      child = (o.spawnFn || spawn)('/bin/sh', ['-c', cmd], { cwd: workRepo, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true })
    } catch (e) {
      done({ ok: false, out: String((e as Error).message || e) })
      return
    }
    let out = ''
    const add = (d: Buffer) => {
      out = (out + String(d)).slice(-4000)
    }
    child.stdout?.on('data', add)
    child.stderr?.on('data', add)
    const timer = setTimeout(() => {
      try {
        if (!child.pid) throw new Error('no pid')
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, o.timeoutMs ?? 10 * 60_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ ok: false, out: String(e.message || e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ ok: code === 0, out: out.trim() || (code === 0 ? '' : `Deploy exited ${code}`) })
    })
  })
}
