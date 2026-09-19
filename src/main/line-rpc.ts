import { spawn, type ChildProcess } from 'node:child_process'

export type RpcMsg = {
  jsonrpc?: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export function rpcErrorMessage(err: { message?: string; data?: unknown }): string {
  const data = err.data
  let extra = ''
  if (typeof data === 'string') extra = data
  else if (data && typeof data === 'object') {
    const rec = data as { message?: unknown; details?: unknown }
    extra = String(rec.message || rec.details || '')
  }
  return [err.message, extra].filter(Boolean).join(': ')
}

export function spawnBin(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): ChildProcess {
  return spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
}

export class LineRpc {
  private buf = ''
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; t: ReturnType<typeof setTimeout> | null }
  >()
  dead = false
  stderr = ''

  constructor(
    readonly proc: ChildProcess,
    private onNote: (msg: RpcMsg) => void,
    private onReq: (msg: RpcMsg) => void,
    private withJsonrpc: boolean
  ) {
    proc.stdout?.on('data', (d) => this.push(String(d)))
    proc.stderr?.on('data', (d) => {
      this.stderr += String(d)
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-4000)
    })
    proc.on('exit', () => this.die(new Error('agent process exited')))
    proc.on('error', (e) => this.die(e))
  }

  private push(chunk: string): void {
    this.buf += chunk
    const parts = this.buf.split('\n')
    this.buf = parts.pop() || ''
    for (const line of parts) this.onLine(line)
  }

  private onLine(line: string): void {
    const t = line.trim()
    if (!t.startsWith('{')) return
    let msg: RpcMsg
    try {
      msg = JSON.parse(t) as RpcMsg
    } catch {
      return
    }
    if (msg.method && msg.id != null) {
      this.onReq(msg)
      return
    }
    if (msg.method) {
      this.onNote(msg)
      return
    }
    if (msg.id == null) return
    const id = Number(msg.id)
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (p.t) clearTimeout(p.t)
    if (msg.error) p.reject(new Error(rpcErrorMessage(msg.error) || 'rpc error'))
    else p.resolve(msg.result)
  }

  write(obj: Record<string, unknown>): void {
    if (this.dead) throw new Error('agent process is gone')
    const stdin = this.proc.stdin
    if (!stdin || stdin.destroyed) throw new Error('agent stdin is closed')
    try {
      stdin.write(JSON.stringify(obj) + '\n')
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'EPIPE') this.die(new Error('agent stdin closed'))
      throw e
    }
  }

  /** timeoutMs <= 0 means wait until the agent replies, dies, or the user stops. */
  request(method: string, params: unknown, timeoutMs = 0): Promise<unknown> {
    const id = this.nextId++
    const body: Record<string, unknown> = { id, method, params: params ?? {} }
    if (this.withJsonrpc) body.jsonrpc = '2.0'
    this.write(body)
    return new Promise((resolve, reject) => {
      const t =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`${method} timed out`))
            }, timeoutMs)
          : null
      this.pending.set(id, { resolve, reject, t })
    })
  }

  notify(method: string, params: unknown): void {
    const body: Record<string, unknown> = { method, params: params ?? {} }
    if (this.withJsonrpc) body.jsonrpc = '2.0'
    this.write(body)
  }

  reply(id: number | string, result: unknown): void {
    const body: Record<string, unknown> = { id, result }
    if (this.withJsonrpc) body.jsonrpc = '2.0'
    this.write(body)
  }

  error(id: number | string, code: number, message: string): void {
    const body: Record<string, unknown> = { id, error: { code, message } }
    if (this.withJsonrpc) body.jsonrpc = '2.0'
    this.write(body)
  }

  die(err?: Error): void {
    if (this.dead) return
    this.dead = true
    for (const p of this.pending.values()) {
      if (p.t) clearTimeout(p.t)
      p.reject(err || new Error('agent process exited'))
    }
    this.pending.clear()
  }

  kill(): void {
    this.die(new Error('stopped'))
    try {
      this.proc.kill('SIGTERM')
    } catch {
      /* */
    }
  }
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && 'text' in v) return String((v as { text?: unknown }).text || '')
  return ''
}

export function fileHits(obj: unknown, tool?: string): { kind: 'file'; path: string; tool?: string }[] {
  const out: { kind: 'file'; path: string; tool?: string }[] = []
  const seen = new Set<string>()
  const keys = new Set(['target_file', 'path', 'file_path', 'filePath', 'target_directory', 'absolutePath', 'file'])
  function walk(v: unknown, depth: number): void {
    if (depth > 5 || !v || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    const o = v as Record<string, unknown>
    for (const k of keys) {
      const p = o[k]
      if (typeof p === 'string' && p.length > 1 && p !== 'file' && !seen.has(p)) {
        seen.add(p)
        out.push({ kind: 'file', path: p, tool })
      }
    }
    for (const val of Object.values(o)) {
      if (val && typeof val === 'object') walk(val, depth + 1)
    }
  }
  walk(obj, 0)
  return out
}
