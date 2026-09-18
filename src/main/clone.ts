import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { binEnv } from './ai-cli'

function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: binEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const t = setTimeout(() => {
      child.kill()
      resolve({ code: 1, out: out + '\nGit took too long.' })
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      out += String(d)
    })
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ code: code ?? 1, out })
    })
    child.on('error', (e) => {
      clearTimeout(t)
      resolve({ code: 1, out: String(e.message || e) })
    })
  })
}

function redact(s: string): string {
  return s.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@').replace(/\/\/[^:]+:[^@]+@/g, '//***@')
}

export async function cloneBrain(opts: {
  cloneUrl: string
  dest: string
  email: string
  name: string
}): Promise<{ ok: boolean; dest: string; detail: string }> {
  if (existsSync(opts.dest)) {
    const probe = await git(opts.dest, ['rev-parse', '--is-inside-work-tree'])
    if (probe.code === 0) {
      await git(opts.dest, ['config', 'user.email', opts.email])
      await git(opts.dest, ['config', 'user.name', opts.name || opts.email.split('@')[0]])
      return { ok: true, dest: opts.dest, detail: 'Folder already has git. Using it.' }
    }
  }
  mkdirSync(dirname(opts.dest), { recursive: true })
  const parent = dirname(opts.dest)
  const r = await git(parent, ['clone', opts.cloneUrl, opts.dest], 180_000)
  if (r.code !== 0) return { ok: false, dest: opts.dest, detail: redact(r.out).slice(-800) }
  const origin = await git(opts.dest, ['remote', 'get-url', 'origin'])
  const clean = origin.out
    .trim()
    .replace(/https:\/\/x-access-token:[^@]+@/i, 'https://')
    .replace(/https:\/\/[^:]+:[^@]+@/i, 'https://')
  if (clean.startsWith('https://')) await git(opts.dest, ['remote', 'set-url', 'origin', clean])
  await git(opts.dest, ['config', 'user.email', opts.email])
  await git(opts.dest, ['config', 'user.name', opts.name || opts.email.split('@')[0]])
  return { ok: true, dest: opts.dest, detail: 'Cloned the shared brain onto this computer.' }
}

export async function gitPull(cwd: string): Promise<{ ok: boolean; detail: string }> {
  const r = await git(cwd, ['pull', '--ff-only'])
  return { ok: r.code === 0, detail: redact(r.out).slice(-400) }
}

export async function gitPushIfDirty(cwd: string): Promise<{ ok: boolean; detail: string }> {
  const st = await git(cwd, ['status', '--porcelain'])
  if (st.code !== 0) return { ok: false, detail: redact(st.out) }
  if (!st.out.trim()) return { ok: true, detail: 'clean' }
  await git(cwd, ['add', '-A'])
  const c = await git(cwd, ['commit', '-m', 'Brain.app sync'])
  if (c.code !== 0 && !/nothing to commit/i.test(c.out)) return { ok: false, detail: redact(c.out).slice(-400) }
  const p = await git(cwd, ['push'])
  return { ok: p.code === 0, detail: redact(p.out).slice(-400) }
}
