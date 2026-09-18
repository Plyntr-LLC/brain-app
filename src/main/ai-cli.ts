import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { AiKind } from '../shared/contracts'

export function extraPath(): string {
  const home = homedir()
  const dirs =
    process.platform === 'win32'
      ? [
          join(home, '.local', 'bin'),
          join(home, '.grok', 'bin'),
          join(home, 'AppData', 'Roaming', 'npm'),
          join(home, 'AppData', 'Local', 'Programs'),
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : '',
          process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Git', 'cmd') : '',
          process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'] as string, 'Git', 'cmd') : ''
        ]
      : [join(home, '.local/bin'), join(home, '.grok/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  return dirs.filter(Boolean).join(delimiter)
}

export function binEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homedir(),
    PATH: `${extraPath()}${delimiter}${process.env.PATH || ''}`
  }
}

function winNames(base: string): string[] {
  return process.platform === 'win32' ? [`${base}.exe`, `${base}.cmd`, base] : [base]
}

function binCandidates(kind: AiKind): string[] {
  const home = homedir()
  const names: Record<AiKind, string> = { grok: 'grok', claude: 'claude', gpt: 'codex', cursor: 'cursor-agent' }
  const base = names[kind]
  const out: string[] = []
  for (const n of winNames(base)) {
    out.push(join(home, '.local', 'bin', n), join(home, '.grok', 'bin', n))
    if (process.platform !== 'win32') out.push(join('/opt/homebrew/bin', n), join('/usr/local/bin', n))
  }
  return out
}

function whichOnPath(kind: AiKind): string | null {
  const names: Record<AiKind, string> = { grok: 'grok', claude: 'claude', gpt: 'codex', cursor: 'cursor-agent' }
  const want = winNames(names[kind])
  const dirs = `${extraPath()}${delimiter}${process.env.PATH || ''}`.split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const n of want) {
      const p = join(dir, n)
      if (existsSync(p)) return p
    }
  }
  return null
}

export function resolveBin(kind: AiKind): string | null {
  for (const p of binCandidates(kind)) if (existsSync(p)) return p
  return whichOnPath(kind)
}

export function detect(): Record<AiKind, boolean> {
  return {
    grok: Boolean(resolveBin('grok')),
    claude: Boolean(resolveBin('claude')),
    gpt: Boolean(resolveBin('gpt')),
    cursor: Boolean(resolveBin('cursor'))
  }
}

export type SessionCmd = { name: string; description: string; hint?: string }

export type StreamEvent =
  | { kind: 'thought'; data: string }
  | { kind: 'text'; data: string }
  | { kind: 'file'; path: string; tool?: string }
  | { kind: 'status'; data: string }
  | { kind: 'context'; used?: number; total?: number; percent?: number }
  | { kind: 'commands'; commands: SessionCmd[] }
  | { kind: 'done' }
  | { kind: 'error'; data: string }

function packPrompt(
  system: string,
  history: { who: 'brain' | 'me'; text: string }[],
  text: string
): string {
  const convo = history
    .filter((m) => m.who === 'me' || m.who === 'brain')
    .slice(-10)
    .map((m) => `${m.who === 'me' ? 'User' : 'Brain'}: ${m.text}`)
    .join('\n')
  return `${system}\n\n${convo ? `Conversation so far:\n${convo}\n\n` : ''}User: ${text}\nBrain:`
}

function parseGrokLine(line: string): StreamEvent | null {
  const t = line.trim()
  if (!t.startsWith('{')) return null
  try {
    const o = JSON.parse(t) as {
      type?: string
      data?: string
      toolName?: string
      title?: string
      rawInput?: { target_file?: string; path?: string; target_directory?: string }
      locations?: { path?: string }[]
    }
    if (o.type === 'thought' && o.data) return { kind: 'thought', data: o.data }
    if (o.type === 'text' && o.data) return { kind: 'text', data: o.data }
    if (o.type === 'tool_call') {
      const raw = o.rawInput || {}
      const p = raw.target_file || raw.path || raw.target_directory
      if (p) return { kind: 'file', path: p, tool: o.toolName || o.title }
    }
    if (o.type === 'tool_call_update' && Array.isArray(o.locations)) {
      const p = o.locations.find((l) => l.path)?.path
      if (p) return { kind: 'file', path: p }
    }
  } catch {
    return null
  }
  return null
}

const running = new Map<string, ChildProcess>()

export function stopPrompt(tabId: string): boolean {
  const child = running.get(tabId)
  if (!child) return false
  try {
    child.kill('SIGTERM')
  } catch {
    /* */
  }
  running.delete(tabId)
  return true
}

export function promptStream(opts: {
  kind: AiKind
  text: string
  cwd: string
  history: { who: 'brain' | 'me'; text: string }[]
  system: string
  sessionId?: string
  model?: string
  effort?: string
  alwaysApprove?: boolean
  tabId?: string
  onEvent: (ev: StreamEvent) => void
}): Promise<string> {
  const bin = resolveBin(opts.kind)
  if (!bin) return Promise.reject(new Error(`${opts.kind} is not installed on this computer`))
  const slash = opts.text.trim().startsWith('/')
  const packed = slash ? opts.text.trim() : packPrompt(opts.system, opts.history, opts.text)

  const model = opts.model ? ['-m', opts.model] : []
  const effort = opts.effort ? ['--effort', opts.effort] : []
  const approve = opts.alwaysApprove ? ['--always-approve'] : []
  const verbatim = slash ? ['--verbatim'] : []

  const args =
    opts.kind === 'grok'
      ? [
          '-p',
          packed,
          ...model,
          ...effort,
          ...approve,
          ...verbatim,
          '--output-format',
          'streaming-json',
          '--max-turns',
          '50'
        ]
      : opts.kind === 'claude'
        ? ['-p', packed, '--output-format', 'text', '--max-turns', '4']
        : opts.kind === 'cursor'
          ? [
              '-p',
              '--trust',
              '--workspace',
              opts.cwd,
              '--output-format',
              'text',
              ...(opts.model ? ['--model', opts.model] : []),
              packed
            ]
          : ['exec', '--skip-git-repo-check', packed]

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: binEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (opts.tabId) {
      running.get(opts.tabId)?.kill('SIGTERM')
      running.set(opts.tabId, child)
    }
    let buf = ''
    let text = ''
    let err = ''
    const t = setTimeout(() => {
      child.kill('SIGTERM')
    }, 180_000)

    const handleLine = (line: string) => {
      if (opts.kind === 'grok') {
        const ev = parseGrokLine(line)
        if (!ev) return
        if (ev.kind === 'text') text += ev.data
        opts.onEvent(ev)
        return
      }
      if (line) {
        text += line + '\n'
        opts.onEvent({ kind: 'text', data: line + '\n' })
      }
    }

    child.stdout.on('data', (d) => {
      if (opts.kind !== 'grok') {
        const s = String(d)
        text += s
        opts.onEvent({ kind: 'text', data: s })
        return
      }
      buf += String(d)
      const parts = buf.split('\n')
      buf = parts.pop() || ''
      for (const line of parts) handleLine(line)
    })
    child.stderr.on('data', (d) => {
      err += String(d)
    })
    child.on('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
    child.on('close', (code, signal) => {
      clearTimeout(t)
      if (opts.tabId) running.delete(opts.tabId)
      if (buf.trim()) handleLine(buf)
      opts.onEvent({ kind: 'done' })
      const out = text.trim()
      if (signal === 'SIGTERM') {
        resolve(out)
        return
      }
      if (!out && code !== 0) {
        reject(new Error(err.trim().slice(0, 400) || `${bin} exited ${code}`))
        return
      }
      resolve(out || err.trim())
    })
  })
}
