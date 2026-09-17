import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { binEnv, resolveBin } from './ai-cli'
import { listCodexCaps } from './codex-app'

export type SlashCmd = { name: string; kind: 'builtin' | 'skill'; description: string }

function run(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: binEnv(),
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
  const builtins: SlashCmd[] = appBuiltins(kind)
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

function appBuiltins(kind: string): SlashCmd[] {
  const common: SlashCmd[] = [
    { name: 'new', kind: 'builtin', description: 'New chat tab' },
    { name: 'clear', kind: 'builtin', description: 'New session in this tab' },
    { name: 'compact', kind: 'builtin', description: 'Compact the live session' },
    { name: 'context', kind: 'builtin', description: 'Live context window' },
    { name: 'session-info', kind: 'builtin', description: 'Live session details' },
    { name: 'fork', kind: 'builtin', description: 'Fork the live session into a new tab' },
    { name: 'rewind', kind: 'builtin', description: 'Undo last turn on the live session' },
    { name: 'copy', kind: 'builtin', description: 'Copy last answer' },
    { name: 'export', kind: 'builtin', description: 'Save this chat to a file' },
    { name: 'quit', kind: 'builtin', description: 'Quit the app' },
    { name: 'delete', kind: 'builtin', description: 'Close this tab' },
    { name: 'rename', kind: 'builtin', description: 'Rename this tab' },
    { name: 'model', kind: 'builtin', description: 'Pick the model' },
    { name: 'effort', kind: 'builtin', description: 'Reasoning effort' },
    { name: 'history', kind: 'builtin', description: 'This chat’s prompts' },
    { name: 'help', kind: 'builtin', description: 'List commands' },
    { name: 'usage', kind: 'builtin', description: 'Account usage' }
  ]
  if (kind === 'grok') {
    common.splice(2, 0, { name: 'resume', kind: 'builtin', description: 'Load a saved Grok session' })
    common.push(
      { name: 'login', kind: 'builtin', description: 'Grok login' },
      { name: 'logout', kind: 'builtin', description: 'Grok logout' },
      { name: 'doctor', kind: 'builtin', description: 'Grok doctor' }
    )
  }
  return common
}

function encodeSessionDir(cwd: string): string {
  return encodeURIComponent(cwd)
}

export type GrokSessionRow = { id: string; title: string; updated: string }

export function listGrokSessions(cwd: string): GrokSessionRow[] {
  const dir = join(homedir(), '.grok', 'sessions', encodeSessionDir(cwd))
  try {
    const ids = readdirSync(dir).filter((n) => /^[0-9a-f-]{20,}$/i.test(n))
    ids.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
    return ids.slice(0, 24).map((id) => {
      let title = id.slice(0, 8)
      let updated = ''
      try {
        const sum = JSON.parse(readFileSync(join(dir, id, 'summary.json'), 'utf8')) as {
          generated_title?: string
          session_summary?: string
          last_active_at?: string
          updated_at?: string
        }
        title = String(sum.generated_title || sum.session_summary || title).slice(0, 80)
        updated = String(sum.last_active_at || sum.updated_at || '')
      } catch {
        /* */
      }
      if (!updated) {
        try {
          updated = new Date(statSync(join(dir, id)).mtimeMs).toISOString()
        } catch {
          /* */
        }
      }
      return { id, title, updated }
    })
  } catch {
    return []
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text?: string }).text || '') : ''))
      .join('\n')
  }
  return ''
}

export function grokTranscript(cwd: string, id: string): { who: 'me' | 'brain'; text: string }[] {
  const file = join(homedir(), '.grok', 'sessions', encodeSessionDir(cwd), id, 'chat_history.jsonl')
  if (!existsSync(file)) return []
  let raw = ''
  try {
    const st = statSync(file)
    const size = Math.min(st.size, 700_000)
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(size)
    readSync(fd, buf, 0, size, Math.max(0, st.size - size))
    closeSync(fd)
    raw = buf.toString('utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n')
  if (lines.length) lines[0] = lines[0].startsWith('{') ? lines[0] : ''
  const out: { who: 'me' | 'brain'; text: string }[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as { type?: string; content?: unknown }
      if (o.type === 'user') {
        const blob = textFromContent(o.content)
        const m = blob.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
        const text = (m ? m[1] : blob).trim().slice(0, 4000)
        if (text) out.push({ who: 'me', text })
      } else if (o.type === 'assistant') {
        const text = textFromContent(o.content).trim().slice(0, 8000)
        if (text) out.push({ who: 'brain', text })
      }
    } catch {
      /* skip a broken line */
    }
  }
  return out.slice(-40)
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
