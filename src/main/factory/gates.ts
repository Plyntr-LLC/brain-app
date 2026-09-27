import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { currentBranch, hasRemote, headSha } from './git-audit.ts'
import { realish, underPath } from './paths.ts'

/** Publish verbs the model never runs (Push is a person's click, done by Brain). Matched against a permission ask's title and raw input. */
export const DENY_CMD_RE =
  /\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+\s+|-\S+\s+)*push\b|(?:^|[\s;&|(`'"])gh\s|\bwrangler\s+(?:[\w:-]+\s+)*deploy\b|\b(?:npm|yarn|pnpm|bun)\s+publish\b|\bvercel(?=[\s\"'`;&|]|$)|\bfly(?:ctl)?\s+deploy\b|\bnetlify\s+deploy\b|\bfirebase\s+deploy\b|\bgcloud\s+\S+\s+deploy\b|\bheroku\s+(?:git:)?push\b/i

export const PUSH_REFUSAL = 'Factory runs do not push. Brain commits on the work repo after review; pushing stays a person\'s call.'
export const GH_REFUSAL = 'Factory runs do not use gh. Pull requests and releases stay a person\'s call.'
export const BRAIN_WRITE_REFUSAL =
  'Factory edits land in the work repo only. This path is in the brain folder, and the brain syncs, so Brain refused it.'

type Msg = { params?: unknown }

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** Paths a permission ask names (edit targets, locations). */
export function askPaths(msg: Msg): string[] {
  const p = rec(msg.params)
  const tool = rec(p.toolCall)
  const raw = rec(tool.rawInput)
  const out: string[] = []
  for (const v of [raw.target_file, raw.path, raw.file_path, raw.filePath, raw.file, tool.path]) {
    if (typeof v === 'string' && v) out.push(v)
  }
  for (const loc of Array.isArray(tool.locations) ? tool.locations : []) {
    const path = rec(loc).path
    if (typeof path === 'string' && path) out.push(path)
  }
  return out
}

/** Empty when this write may go ahead. A sentence when it lands in the brain while the work repo is elsewhere. */
export function factoryWriteBlock(abs: string, brainPath: string, workRepo: string): string | null {
  if (!brainPath || !abs || !isAbsolute(abs)) return null
  const brain = realish(brainPath)
  const work = workRepo ? realish(workRepo) : ''
  const target = realish(abs)
  if (!underPath(brain, target)) return null
  // A work repo inside the brain may be edited; the rest of the brain may not.
  if (work && underPath(brain, work) && underPath(work, target)) return null
  return BRAIN_WRITE_REFUSAL
}

/** 'reject' for publish verbs and brain edits, 'ask' for everything else (the card decides). */
export function filterFactoryPermission(msg: Msg, ctx: { brainPath: string; workRepo: string }): 'reject' | 'ask' {
  const p = rec(msg.params)
  const tool = rec(p.toolCall)
  const blob = [p.title, tool.title, tool.kind, JSON.stringify(tool.rawInput ?? ''), JSON.stringify(tool.content ?? '')]
    .map((x) => String(x ?? ''))
    .join(' ')
  if (DENY_CMD_RE.test(blob)) return 'reject'
  for (const raw of askPaths(msg)) {
    // Grok's cwd is the brain, so a relative path lands in the brain.
    const path = isAbsolute(raw) ? raw : ctx.brainPath ? resolve(ctx.brainPath, raw) : ''
    if (path && factoryWriteBlock(path, ctx.brainPath, ctx.workRepo)) {
      const kind = String(tool.kind || '').toLowerCase()
      // Reads of the brain are fine (rules, skills); edits are not.
      if (kind !== 'read' && kind !== 'search' && kind !== 'fetch' && kind !== 'think') return 'reject'
    }
  }
  return 'ask'
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

/** Branches the Push click never pushes. */
export const PROTECTED_BRANCHES = new Set(['main', 'master', 'staging', 'prod', 'production'])

export type PublishTarget = { remote: string; branch: string; sha: string }

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

/** Null when Push may run. Otherwise the one sentence the disabled Push shows. */
export function publishBlock(o: { repo: string } & Partial<PublishTarget>): string | null {
  const branch = String(o.branch || '')
  const remote = String(o.remote || '')
  if (!branch) return 'This commit is on a detached HEAD. Push it from Terminal.'
  if (PROTECTED_BRANCHES.has(branch)) return `Brain does not push to ${branch}. Push it from Terminal after review.`
  const now = currentBranch(o.repo)
  if (!now) return 'This repo is on a detached HEAD. Push it from Terminal.'
  if (now !== branch || headSha(o.repo) !== o.sha) return 'This branch moved since Factory committed. Push from Terminal.'
  if (!remote || !hasRemote(o.repo, remote)) return `This repo has no remote named ${remote || 'origin'}.`
  if (o.sha && remoteRef(o.repo, remote, branch) === o.sha) return `Already pushed to ${remote}/${branch}.`
  return null
}

/** PATH without the Factory shim dir: person clicks (Push, Deploy) use the real tools. */
export function noShimPath(path: string | undefined): string {
  return String(path || '')
    .split(delimiter)
    .filter((d) => d && !/[\\/]factory[\\/]bin$/.test(d))
    .join(delimiter)
}

/** The Push click: real git, never the shim dir, no prompts, 90 s. Refuses anything publishBlock names. */
export function publish(workRepo: string, t: PublishTarget, timeoutMs = 90_000): Promise<{ ok: boolean; out: string }> {
  const block = publishBlock({ repo: workRepo, ...t })
  if (block) return Promise.resolve({ ok: false, out: block })
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: noShimPath(process.env.PATH), GIT_TERMINAL_PROMPT: '0' }
  return new Promise((done) => {
    const child = spawn(realGit(), ['push', t.remote, t.branch], { cwd: workRepo, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
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
