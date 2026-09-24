import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { binEnv, resolveBin } from './ai-cli'
import { claudeModelsFromCache } from './claude-models'
import { formatClaudeUsage } from './claude-usage'
import { listCodexCaps } from './codex-app'
import { grokLeaderSocket } from './grok-args'
import { parseGrokModels } from './grok-models'

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

async function listClaudeModels(): Promise<{ id: string; label: string }[]> {
  let cache: Record<string, unknown> | null = null
  let settingsModel = ''
  try {
    cache = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as Record<string, unknown>
  } catch {
    cache = null
  }
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as {
      model?: string
    }
    settingsModel = String(s.model || '').trim()
  } catch {
    /* */
  }
  let help = ''
  const bin = resolveBin('claude')
  if (bin) {
    try {
      help = await run(bin, ['--help'], homedir())
    } catch {
      /* */
    }
  }
  return claudeModelsFromCache(cache, { help, settingsModel })
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
  if (kind === 'cursor') {
    let models: { id: string; label: string }[] = []
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
    return { commands: builtins, models }
  }
  if (kind === 'gpt') {
    let models: { id: string; label: string }[] = []
    try {
      const caps = await listCodexCaps(cwd)
      if (caps.models?.length) models = caps.models
    } catch {
      /* */
    }
    return { commands: builtins, models }
  }
  if (kind === 'claude') {
    return { commands: builtins, models: await listClaudeModels() }
  }
  const grok = resolveBin('grok')
  let skills: SlashCmd[] = []
  let models: { id: string; label: string }[] = []
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
      const found = parseGrokModels(m)
      if (found.length) models = found
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
    { name: 'usage', kind: 'builtin', description: 'Plan spend and this session' },
    { name: 'terminal', kind: 'builtin', description: 'Open a terminal tab' }
  ]
  if (kind === 'grok') {
    common.splice(2, 0, { name: 'resume', kind: 'builtin', description: 'Load a saved Grok session' })
    common.push(
      { name: 'login', kind: 'builtin', description: 'Grok login' },
      { name: 'logout', kind: 'builtin', description: 'Grok logout' },
      { name: 'doctor', kind: 'builtin', description: 'Grok doctor' },
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
      { name: 'theme', kind: 'builtin', description: 'Theme' },
      { name: 'feedback', kind: 'builtin', description: 'Send feedback' },
      { name: 'btw', kind: 'builtin', description: 'Side question, same chat' },
      { name: 'mcps', kind: 'builtin', description: 'MCP servers' },
      { name: 'release-notes', kind: 'builtin', description: 'Grok changelog' },
      { name: 'docs', kind: 'builtin', description: 'Grok docs' },
      { name: 'tutorial', kind: 'builtin', description: 'How this chat works' },
      { name: 'import-claude', kind: 'builtin', description: 'Import Claude config' },
      { name: 'config-agents', kind: 'builtin', description: 'Agent definitions' },
      { name: 'personas', kind: 'builtin', description: 'Personas' },
      { name: 'privacy', kind: 'builtin', description: 'Privacy' },
      { name: 'settings', kind: 'builtin', description: 'Settings' },
      { name: 'timestamps', kind: 'builtin', description: 'Toggle timestamps' },
      { name: 'multiline', kind: 'builtin', description: 'Enter inserts a newline' },
      { name: 'vim-mode', kind: 'builtin', description: 'Vim keys' },
      { name: 'minimal', kind: 'builtin', description: 'Compact layout' },
      { name: 'fullscreen', kind: 'builtin', description: 'Roomy layout' },
      { name: 'dashboard', kind: 'builtin', description: 'Session dashboard' },
      { name: 'home', kind: 'builtin', description: 'Back to the welcome line' },
      { name: 'always-approve', kind: 'builtin', description: 'Skip tool prompts' },
      { name: 'edit-prompt', kind: 'builtin', description: 'Edit the last prompt' },
      { name: 'compact-mode', kind: 'builtin', description: 'Denser bubbles' }
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

function cursorStateDb(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

function runSplit(bin: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      err += String(d)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ out, err, code: code ?? 1 }))
  })
}

function unwrapSqliteText(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  if (t.startsWith('"')) {
    try {
      const v = JSON.parse(t)
      return typeof v === 'string' && v ? v : null
    } catch {
      return t
    }
  }
  return t
}

function tokLooksSafe(tok: string): boolean {
  if (tok.length < 40 || tok.includes('\n') || /error/i.test(tok)) return false
  return /^[\w.-]+$/.test(tok)
}

async function cursorAccessToken(): Promise<string | null> {
  const db = cursorStateDb()
  if (!existsSync(db)) return null
  const sql = "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1;"
  try {
    const sqlite = process.platform === 'win32' ? 'sqlite3' : '/usr/bin/sqlite3'
    const r = await runSplit(sqlite, ['-readonly', db, sql])
    const tok = unwrapSqliteText(r.out)
    if (tok && tokLooksSafe(tok)) return tok
  } catch {
    /* */
  }
  try {
    const py = process.platform === 'win32' ? 'python' : '/usr/bin/python3'
    const r = await runSplit(py, [
      '-c',
      'import sqlite3,sys\ncon=sqlite3.connect(sys.argv[1])\nrow=con.execute("SELECT value FROM ItemTable WHERE key=?",("cursorAuth/accessToken",)).fetchone()\nv="" if not row or row[0] is None else row[0]\nsys.stdout.write(v.decode() if isinstance(v,bytes) else str(v))',
      db
    ])
    const tok = unwrapSqliteText(r.out)
    return tok && tokLooksSafe(tok) ? tok : null
  } catch {
    return null
  }
}

function usdFromCents(cents: number): string {
  return `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function dayFromMs(raw: unknown): string {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return ''
  return new Date(n).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

async function cursorApiJson(path: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api2.cursor.sh${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1'
    },
    body: '{}',
    signal: AbortSignal.timeout(12_000)
  })
  if (!res.ok) throw new Error(`Cursor usage ${res.status}`)
  const o = (await res.json()) as Record<string, unknown>
  return o && typeof o === 'object' ? o : {}
}

function formatCursorPlan(period: Record<string, unknown>, plan: Record<string, unknown>, agg: Record<string, unknown>): string {
  const planInfo = (plan.planInfo || {}) as Record<string, unknown>
  const usage = (period.planUsage || {}) as Record<string, unknown>
  const start = dayFromMs(period.billingCycleStart)
  const end = dayFromMs(period.billingCycleEnd)
  const lines = ['This billing cycle']
  if (start && end) lines.push(`${start} – ${end}`)
  const name = String(planInfo.planName || '')
  const price = String(planInfo.price || '')
  if (name || price) lines.push([name, price].filter(Boolean).join(' · '))
  if (usage.limit != null) lines.push(`Included: ${usdFromCents(Number(usage.limit))}`)
  if (usage.totalSpend != null) lines.push(`Used: ${usdFromCents(Number(usage.totalSpend))}`)
  if (usage.includedSpend != null || usage.bonusSpend != null) {
    const parts = []
    if (usage.includedSpend != null) parts.push(`included ${usdFromCents(Number(usage.includedSpend))}`)
    if (usage.bonusSpend != null && Number(usage.bonusSpend) > 0) parts.push(`bonus ${usdFromCents(Number(usage.bonusSpend))}`)
    if (parts.length) lines.push(`  (${parts.join(' + ')})`)
  }
  const auto = String(period.autoModelSelectedDisplayMessage || '').trim()
  const named = String(period.namedModelSelectedDisplayMessage || '').trim()
  const msg = String(period.displayMessage || '').trim()
  if (auto) lines.push(auto)
  if (named) lines.push(named)
  if (msg) lines.push(msg)
  const rows = Array.isArray(agg.aggregations) ? (agg.aggregations as Record<string, unknown>[]) : []
  const top = rows
    .map((r) => ({
      model: String(r.modelIntent || '').trim(),
      cents: Number(r.totalCents || 0)
    }))
    .filter((r) => r.model && r.cents > 0)
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 6)
  if (top.length) {
    lines.push('', 'By model')
    for (const r of top) lines.push(`${r.model}  ${usdFromCents(r.cents)}`)
  }
  lines.push('', 'Open: https://cursor.com/dashboard?tab=usage')
  return lines.join('\n')
}

async function cursorAboutBlurb(cwd: string): Promise<string> {
  const cursor = resolveBin('cursor')
  if (!cursor) return ''
  try {
    const raw = await run(cursor, ['about', '--format', 'json'], cwd)
    const o = JSON.parse(raw.slice(raw.indexOf('{'))) as {
      userEmail?: string
      subscriptionTier?: string
      model?: string
      cliVersion?: string
    }
    return [
      'Account',
      o.userEmail ? `Email: ${o.userEmail}` : '',
      o.subscriptionTier ? `Plan: ${o.subscriptionTier}` : '',
      o.model ? `Default model: ${o.model}` : '',
      o.cliVersion ? `CLI: ${o.cliVersion}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  }
}

async function cursorPlanBlurb(): Promise<string> {
  const token = await cursorAccessToken()
  if (!token) {
    return 'Could not read Cursor usage from this Mac (sign in to the Cursor app once).'
  }
  try {
    const [period, plan, agg] = await Promise.all([
      cursorApiJson('/aiserver.v1.DashboardService/GetCurrentPeriodUsage', token),
      cursorApiJson('/aiserver.v1.DashboardService/GetPlanInfo', token),
      cursorApiJson('/aiserver.v1.DashboardService/GetAggregatedUsageEvents', token)
    ])
    return formatCursorPlan(period, plan, agg)
  } catch (e) {
    return `Could not read Cursor plan spend.\n${String((e as Error).message || e)}`
  }
}

async function claudeUsageBlurb(cwd: string): Promise<string> {
  const bin = resolveBin('claude')
  if (!bin) return 'Claude is not installed on this computer.'
  try {
    const raw = await run(bin, ['auth', 'status', '--json'], cwd)
    const start = raw.indexOf('{')
    if (start < 0) return 'Could not read Claude usage.'
    const o = JSON.parse(raw.slice(start)) as Record<string, unknown>
    return formatClaudeUsage(o, cwd)
  } catch (e) {
    return `Could not read Claude usage.\n${String((e as Error).message || e)}`
  }
}

function gptUsageBlurb(cwd: string): string {
  return [
    'ChatGPT (Codex) account',
    '',
    'Plan spend lives on the OpenAI account, not this chat.',
    'Open: https://chatgpt.com',
    '',
    `This folder: ${cwd}`
  ].join('\n')
}

export async function usageBlurb(cwd: string, kind = 'grok', sessionId?: string): Promise<string> {
  if (kind === 'cursor') {
    const [plan, about] = await Promise.all([cursorPlanBlurb(), cursorAboutBlurb(cwd)])
    return [plan, about].filter(Boolean).join('\n\n') || 'Cursor CLI is not installed.'
  }
  if (kind === 'claude') return claudeUsageBlurb(cwd)
  if (kind === 'gpt') return gptUsageBlurb(cwd)
  if (kind === 'grok') {
    const grok = resolveBin('grok')
    const sid = String(sessionId || '').trim()
    if (grok && sid && /^[0-9a-f-]{20,}$/i.test(sid)) {
      try {
        const args = ['usage', sid]
        const sock = grokLeaderSocket()
        if (existsSync(sock)) args.push('--leader-socket', sock)
        const raw = await run(grok, args, cwd)
        const pretty = formatGrokUsage(raw)
        if (pretty) return pretty
      } catch (e) {
        return `Could not read Grok usage.\n${String((e as Error).message || e)}`
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
  return `Usage for this CLI is not available.`
}

function formatGrokUsage(raw: string): string | null {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const o = JSON.parse(text.slice(text.indexOf('{'))) as {
      session?: {
        inputTokens?: number
        outputTokens?: number
        cachedReadTokens?: number
        reasoningTokens?: number
        totalTokens?: number
        modelCalls?: number
        costUsdTicks?: number
        turnCount?: number
        primaryModelId?: string
      }
    }
    const s = o.session
    if (!s) return text.slice(0, 8000)
    const n = (v?: number) => (v == null ? '' : v.toLocaleString('en-US'))
    const cost = s.costUsdTicks != null ? `$${(Number(s.costUsdTicks) / 1_000_000_000).toFixed(2)}` : ''
    return [
      'This session',
      s.primaryModelId ? `Model: ${s.primaryModelId}` : '',
      s.turnCount != null ? `Turns: ${s.turnCount}` : '',
      s.inputTokens != null ? `Input tokens: ${n(s.inputTokens)}` : '',
      s.outputTokens != null ? `Output tokens: ${n(s.outputTokens)}` : '',
      s.cachedReadTokens != null ? `Cached tokens: ${n(s.cachedReadTokens)}` : '',
      s.reasoningTokens != null ? `Reasoning tokens: ${n(s.reasoningTokens)}` : '',
      s.totalTokens != null ? `Total tokens: ${n(s.totalTokens)}` : '',
      s.modelCalls != null ? `Model calls: ${s.modelCalls}` : '',
      cost ? `Est. cost: ${cost}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  } catch {
    return text.slice(0, 8000)
  }
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
