import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { realish, underPath } from './paths.ts'

/** Publish verbs Factory never runs in Slice 1. Matched against a permission ask's title and raw input. */
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

/** Child env for every Factory process: shims first on PATH, no ANTHROPIC_API_KEY. */
export function factoryEnv(base: NodeJS.ProcessEnv, shimDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PATH: `${shimDir}${delimiter}${base.PATH || ''}` }
  delete env.ANTHROPIC_API_KEY
  return env
}
