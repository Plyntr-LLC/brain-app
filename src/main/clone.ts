import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { binEnv } from './ai-cli'
import { clonePlan } from './setup-folder'

function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  const env = { ...binEnv(), GIT_TERMINAL_PROMPT: '0' }
  const safe = ['-c', 'credential.helper=', ...args]
  return new Promise((resolve) => {
    const child = spawn('git', safe, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
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

export function redact(s: string): string {
  return s
    .replace(/x-access-token:[^@]+@/g, 'x-access-token:***@')
    .replace(/\/\/[^:]+:[^@]+@/g, '//***@')
    .replace(/Bearer\s+[A-Za-z0-9._\-=]+/gi, 'Bearer ***')
    .replace(/\bpbt_[A-Za-z0-9_-]+/g, 'pbt_***')
}

export function hasBrainMarker(dest: string): boolean {
  return (
    existsSync(join(dest, 'AGENTS.md')) ||
    existsSync(join(dest, 'CLAUDE.md')) ||
    existsSync(join(dest, '.team-config', 'roles.json'))
  )
}

function dirIsEmpty(dest: string): boolean {
  try {
    return readdirSync(dest).filter((name) => name !== '.DS_Store').length === 0
  } catch {
    return false
  }
}

const EMPTY_BRAIN =
  'GitHub copied an empty folder. The brain files are not in the repo yet. Wait a minute on GitHub, then tap Try again.'

export function defaultBrainDest(slug: string): string {
  const name = `${String(slug || '').trim()}-brain`
  const root = process.env.BRAIN_APP_SETUP_DRIVE === '1' ? String(process.env.BRAIN_APP_SETUP_ROOT || '').trim() : ''
  return join(root || join(homedir(), 'Projects'), name)
}

/** Remove a half-finished checkout with no brain files so the next copy can start clean. */
export function removeFailedBrainCheckout(dest: string): void {
  const path = String(dest || '').trim()
  if (!path || !existsSync(path)) return
  if (hasBrainMarker(path)) return
  rmSync(path, { recursive: true, force: true })
}

async function fillEmptyCheckout(dest: string, cloneUrl: string): Promise<boolean> {
  const branch = await currentBranch(dest)
  const fetch = await git(dest, ['fetch', cloneUrl, branch])
  if (fetch.code !== 0) return false
  const merge = await git(dest, ['merge', '--ff-only', 'FETCH_HEAD'])
  if (merge.code !== 0) return false
  return hasBrainMarker(dest)
}

export async function cloneBrain(opts: {
  cloneUrl: string
  dest: string
  email: string
  name: string
}): Promise<{ ok: boolean; dest: string; detail: string }> {
  if (existsSync(opts.dest)) {
    const probe = await git(opts.dest, ['rev-parse', '--is-inside-work-tree'])
    const isGit = probe.code === 0
    const origin = isGit ? await originHttps(opts.dest) : ''
    const want = opts.cloneUrl.replace(/https:\/\/x-access-token:[^@]+@/i, 'https://').replace(/https:\/\/[^:]+:[^@]+@/i, 'https://')
    const same = Boolean(origin && want && origin.replace(/\.git$/, '') === want.replace(/\.git$/, ''))
    const plan = clonePlan({
      destExists: true,
      isGit,
      sameOrigin: same,
      hasMarker: hasBrainMarker(opts.dest),
      empty: !isGit && dirIsEmpty(opts.dest)
    })
    if (plan === 'reuse') {
      await git(opts.dest, ['config', 'user.email', opts.email])
      await git(opts.dest, ['config', 'user.name', opts.name || opts.email.split('@')[0]])
      return { ok: true, dest: opts.dest, detail: 'Folder already has this brain. Using it.' }
    }
    if (plan === 'refuse-empty-brain') {
      const filled = await fillEmptyCheckout(opts.dest, opts.cloneUrl).catch(() => false)
      if (filled) {
        await git(opts.dest, ['config', 'user.email', opts.email])
        await git(opts.dest, ['config', 'user.name', opts.name || opts.email.split('@')[0]])
        return { ok: true, dest: opts.dest, detail: 'Copied the brain files into the folder.' }
      }
      return { ok: false, dest: opts.dest, detail: EMPTY_BRAIN }
    }
    if (plan === 'refuse-other-repo') {
      return {
        ok: false,
        dest: opts.dest,
        detail: 'That folder is already a different git repo. Pick another place or remove it, then try again.'
      }
    }
    if (plan === 'refuse-not-empty') {
      return {
        ok: false,
        dest: opts.dest,
        detail: 'That folder already has files and is not this brain. Pick another place, then try again.'
      }
    }
    if (plan === 'replace-empty') rmSync(opts.dest, { recursive: true })
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
  if (clean.startsWith('https://')) {
    const set = await git(opts.dest, ['remote', 'set-url', 'origin', clean])
    if (set.code !== 0) return { ok: false, dest: opts.dest, detail: redact(set.out).slice(-400) }
  }
  await git(opts.dest, ['config', 'user.email', opts.email])
  await git(opts.dest, ['config', 'user.name', opts.name || opts.email.split('@')[0]])
  if (!hasBrainMarker(opts.dest)) return { ok: false, dest: opts.dest, detail: EMPTY_BRAIN }
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

async function originHttps(cwd: string): Promise<string> {
  const r = await git(cwd, ['remote', 'get-url', 'origin'])
  return r.out.trim().replace(/https:\/\/x-access-token:[^@]+@/i, 'https://').replace(/https:\/\/[^:]+:[^@]+@/i, 'https://')
}

function withToken(url: string, token: string): string {
  const t = String(token || '').trim()
  const u = String(url || '').trim()
  if (!t || !u.startsWith('https://')) return u
  return u.replace(/^https:\/\//, `https://x-access-token:${t}@`)
}

async function currentBranch(cwd: string): Promise<string> {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const b = r.out.trim()
  return b && b !== 'HEAD' ? b : 'main'
}

export async function gitSyncAuthed(cwd: string, token: string): Promise<{ ok: boolean; detail: string }> {
  const st = await git(cwd, ['status', '--porcelain'])
  if (st.code !== 0) return { ok: false, detail: redact(st.out) }
  if (st.out.trim()) {
    await git(cwd, ['add', '-A'])
    const c = await git(cwd, ['commit', '-m', 'Brain.app sync'])
    if (c.code !== 0 && !/nothing to commit/i.test(c.out)) return { ok: false, detail: redact(c.out).slice(-400) }
  }
  const origin = await originHttps(cwd)
  const authed = withToken(origin, token)
  if (!authed) {
    const pull = await gitPull(cwd)
    if (!pull.ok) return pull
    return gitPushIfDirty(cwd)
  }
  const branch = await currentBranch(cwd)
  const fetch = await git(cwd, ['fetch', authed, `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
  if (fetch.code !== 0) return { ok: false, detail: redact(fetch.out).slice(-400) }
  const merge = await git(cwd, ['merge', '--ff-only', `origin/${branch}`])
  if (merge.code !== 0) return { ok: false, detail: redact(merge.out).slice(-400) }
  const ahead = await git(cwd, ['rev-list', '--count', `origin/${branch}..HEAD`])
  if (ahead.code !== 0) return { ok: false, detail: redact(ahead.out).slice(-400) || 'Could not tell if this folder is ahead of GitHub.' }
  const n = Number(ahead.out.trim())
  if (!Number.isFinite(n)) return { ok: false, detail: 'Could not tell if this folder is ahead of GitHub.' }
  if (n === 0) return { ok: true, detail: 'clean' }
  const p = await git(cwd, ['push', authed, `HEAD:refs/heads/${branch}`])
  return { ok: p.code === 0, detail: redact(p.out).slice(-400) }
}
