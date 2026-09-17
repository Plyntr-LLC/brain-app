import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { resolveBin } from './ai-cli'
import { listCodexCaps } from './codex-app'

export type SlashCmd = { name: string; kind: 'builtin' | 'skill'; description: string }

function run(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: {
        ...process.env,
        HOME: homedir(),
        PATH: `${join(homedir(), '.local/bin')}${delimiter}${join(homedir(), '.grok/bin')}${delimiter}/opt/homebrew/bin${delimiter}${process.env.PATH || ''}`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      out += String(d)
    })
    child.on('error', reject)
    child.on('close', () => resolve(out))
  })
}

function parseCursorModels(raw: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = []
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^([a-z0-9][a-z0-9._-]*)\s+-\s+(.+)$/i)
    if (m) out.push({ id: m[1], label: m[2].trim() })
  }
  return out
}

export function resolveModel(
  arg: string,
  models: { id: string; label: string }[]
): { id: string } | { error: string; suggestions: string[] } {
  const q = arg.trim().toLowerCase()
  if (!q) return { error: 'Pick a model.', suggestions: models.slice(0, 8).map((m) => m.id) }
  const exact = models.find((m) => m.id.toLowerCase() === q || m.label.toLowerCase() === q)
  if (exact) return { id: exact.id }
  const hits = models.filter(
    (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)
  )
  if (hits.length === 1) return { id: hits[0].id }
  if (hits.length > 1) {
    return {
      error: `Several models match "${arg}". Pick one:`,
      suggestions: hits.slice(0, 12).map((m) => `${m.id}  (${m.label})`)
    }
  }
  return {
    error: `"${arg}" isn't a model for this CLI.`,
    suggestions: models.slice(0, 10).map((m) => `${m.id}  (${m.label})`)
  }
}

export async function listSlash(
  cwd: string,
  kind = 'grok'
): Promise<{ commands: SlashCmd[]; models: { id: string; label: string }[] }> {
  const builtins: SlashCmd[] = [
    { name: 'new', kind: 'builtin', description: 'New chat tab' },
    { name: 'clear', kind: 'builtin', description: 'Clear this chat' },
    { name: 'resume', kind: 'builtin', description: 'List recent Grok sessions' },
    { name: 'dashboard', kind: 'builtin', description: 'Open Grok agent dashboard' },
    { name: 'compact', kind: 'builtin', description: 'Trim this chat' },
    { name: 'context', kind: 'builtin', description: 'Context window / what is loaded' },
    { name: 'session-info', kind: 'builtin', description: 'Session details' },
    { name: 'fork', kind: 'builtin', description: 'New tab from this chat' },
    { name: 'rewind', kind: 'builtin', description: 'Undo last turn' },
    { name: 'copy', kind: 'builtin', description: 'Copy last answer' },
    { name: 'export', kind: 'builtin', description: 'Export this chat to a file' },
    { name: 'quit', kind: 'builtin', description: 'Quit the app' },
    { name: 'home', kind: 'builtin', description: 'Back to the welcome line' },
    { name: 'delete', kind: 'builtin', description: 'Delete this chat' },
    { name: 'rename', kind: 'builtin', description: 'Rename this tab' },
    { name: 'model', kind: 'builtin', description: 'Pick the model' },
    { name: 'effort', kind: 'builtin', description: 'low / medium / high / xhigh' },
    { name: 'always-approve', kind: 'builtin', description: 'Skip tool prompts' },
    { name: 'auto', kind: 'builtin', description: 'Auto-approve safe tools' },
    { name: 'multiline', kind: 'builtin', description: 'Enter inserts a newline' },
    { name: 'history', kind: 'builtin', description: 'This chat’s prompts' },
    { name: 'plan', kind: 'builtin', description: 'Enter plan mode' },
    { name: 'view-plan', kind: 'builtin', description: 'Show the current plan' },
    { name: 'memory', kind: 'builtin', description: 'Browse Grok memory' },
    { name: 'flush', kind: 'builtin', description: 'Flush session into memory' },
    { name: 'dream', kind: 'builtin', description: 'Consolidate memory' },
    { name: 'remember', kind: 'builtin', description: 'Save a note to memory' },
    { name: 'hooks', kind: 'builtin', description: 'Loaded hooks' },
    { name: 'plugins', kind: 'builtin', description: 'Installed plugins' },
    { name: 'marketplace', kind: 'builtin', description: 'Plugin marketplace' },
    { name: 'skills', kind: 'builtin', description: 'Installed skills' },
    { name: 'imagine', kind: 'builtin', description: 'Generate an image' },
    { name: 'imagine-video', kind: 'builtin', description: 'Generate a video' },
    { name: 'loop', kind: 'builtin', description: 'Recurring prompt' },
    { name: 'goal', kind: 'builtin', description: 'Set or manage a goal' },
    { name: 'deep-research', kind: 'builtin', description: 'Background research' },
    { name: 'workflow', kind: 'builtin', description: 'Run a workflow' },
    { name: 'workflows', kind: 'builtin', description: 'List saved workflows' },
    { name: 'theme', kind: 'builtin', description: 'Chat theme stays this app’s' },
    { name: 'feedback', kind: 'builtin', description: 'Send feedback' },
    { name: 'btw', kind: 'builtin', description: 'Side question, same chat' },
    { name: 'mcps', kind: 'builtin', description: 'MCP servers' },
    { name: 'doctor', kind: 'builtin', description: 'Grok doctor' },
    { name: 'release-notes', kind: 'builtin', description: 'Grok changelog' },
    { name: 'docs', kind: 'builtin', description: 'Grok user-guide docs' },
    { name: 'tutorial', kind: 'builtin', description: 'How this chat works' },
    { name: 'login', kind: 'builtin', description: 'Grok login' },
    { name: 'logout', kind: 'builtin', description: 'Grok logout' },
    { name: 'usage', kind: 'builtin', description: 'Account usage' },
    { name: 'privacy', kind: 'builtin', description: 'Privacy / coding data' },
    { name: 'settings', kind: 'builtin', description: 'This chat’s settings' },
    { name: 'timestamps', kind: 'builtin', description: 'Toggle timestamps' },
    { name: 'vim-mode', kind: 'builtin', description: 'Vim keys (terminal-only)' },
    { name: 'minimal', kind: 'builtin', description: 'Compact layout' },
    { name: 'fullscreen', kind: 'builtin', description: 'Roomy layout' },
    { name: 'help', kind: 'builtin', description: 'List commands' }
  ]
  const grok = resolveBin('grok')
  let skills: SlashCmd[] = []
  let models: { id: string; label: string }[] = [
    { id: 'grok-4.6', label: 'Grok 4.6' },
    { id: 'grok-4.5', label: 'Grok 4.5' }
  ]
  if (kind === 'cursor') {
    const cursor = resolveBin('cursor')
    if (cursor) {
      try {
        const raw = await run(cursor, ['--list-models'], cwd)
        const parsed = parseCursorModels(raw)
        if (parsed.length) models = parsed
      } catch {
        /* */
      }
    }
    skills = []
    return { commands: builtins, models }
  }
  if (kind === 'gpt') {
    try {
      const caps = await listCodexCaps(cwd)
      if (caps.models?.length) models = caps.models
      else models = []
    } catch {
      models = []
    }
    skills = []
    return { commands: builtins, models }
  }
  if (grok) {
    try {
      const raw = await run(grok, ['inspect', '--json'], cwd)
      const jsonStart = raw.indexOf('{')
      const o = JSON.parse(raw.slice(jsonStart)) as { skills?: { name: string; description?: string }[] }
      skills = (o.skills || []).map((s) => ({
        name: s.name,
        kind: 'skill' as const,
        description: String(s.description || '').split('.')[0]
      }))
    } catch {
      /* */
    }
    try {
      const m = await run(grok, ['models'], cwd)
      const found = [...m.matchAll(/^\s*[* -]+\s*(grok-[\w.]+)/gm)].map((x) => x[1])
      if (found.length) models = [...new Set(found)].map((id) => ({ id, label: id }))
    } catch {
      /* */
    }
  }
  const seen = new Set(builtins.map((b) => b.name))
  const extra = skills.filter((s) => !seen.has(s.name))
  return { commands: [...builtins, ...extra], models }
}

function encodeSessionDir(cwd: string): string {
  return encodeURIComponent(cwd)
}

function latestGrokSession(cwd: string): string | null {
  const dir = join(homedir(), '.grok', 'sessions', encodeSessionDir(cwd))
  try {
    const ids = readdirSync(dir).filter((n) => /^[0-9a-f-]{20,}$/i.test(n))
    if (!ids.length) return null
    ids.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
    return ids[0]
  } catch {
    return null
  }
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function grokAccount(): { email?: string; name?: string } {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.grok/auth.json'), 'utf8')) as Record<string, { email?: string; first_name?: string; last_name?: string }>
    const rec = Object.values(raw).find((v) => v && typeof v === 'object' && v.email)
    if (!rec) return {}
    const name = [rec.first_name, rec.last_name].filter(Boolean).join(' ')
    return { email: rec.email, name }
  } catch {
    return {}
  }
}

export async function usageBlurb(cwd: string, kind = 'grok'): Promise<string> {
  if (kind === 'cursor') {
    const cursor = resolveBin('cursor')
    if (!cursor) return 'Cursor CLI is not installed.'
    try {
      const raw = await run(cursor, ['about', '--format', 'json'], cwd)
      const o = JSON.parse(raw.slice(raw.indexOf('{'))) as {
        userEmail?: string
        subscriptionTier?: string
        model?: string
        cliVersion?: string
      }
      return [
        'Cursor account',
        `Email: ${o.userEmail || ''}`,
        `Plan: ${o.subscriptionTier || ''}`,
        `Default model: ${o.model || ''}`,
        `CLI: ${o.cliVersion || ''}`
      ].join('\n')
    } catch (e) {
      return `Could not read Cursor account.\n${String((e as Error).message || e)}`
    }
  }
  const acct = grokAccount()
  return [
    'Grok account (grok.com)',
    `Name: ${acct.name || ''}`,
    `Email: ${acct.email || ''}`,
    '',
    'Credits, weekly limit, and billing live on the account, not this chat.',
    'Open: https://grok.com?_s=usage',
    '',
    `This folder: ${cwd}`
  ].join('\n')
}

export async function grokCli(cwd: string, args: string[]): Promise<string> {
  const grok = resolveBin('grok')
  if (!grok) return 'Grok CLI is not installed.'
  try {
    const out = await run(grok, args, cwd)
    return out.trim().slice(0, 8000) || '(no output)'
  } catch (e) {
    return String((e as Error).message || e)
  }
}

export async function contextBlurb(cwd: string): Promise<string> {
  const grok = resolveBin('grok')
  if (!grok) return `Folder: ${cwd}`
  try {
    const raw = await run(grok, ['inspect', '--json'], cwd)
    const o = JSON.parse(raw.slice(raw.indexOf('{'))) as {
      grokVersion?: string
      cwd?: string
      skills?: unknown[]
      mcpServers?: unknown[]
    }
    return [
      `Grok ${o.grokVersion || ''}`,
      `Folder: ${o.cwd || cwd}`,
      `Skills: ${Array.isArray(o.skills) ? o.skills.length : 0}`,
      `MCP: ${Array.isArray(o.mcpServers) ? o.mcpServers.length : 0}`
    ].join('\n')
  } catch {
    return `Folder: ${cwd}`
  }
}
