import { spawn } from 'node:child_process'
import { redact } from './clone'
import { binEnv } from './ai-cli'

function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const env = { ...binEnv(), GIT_TERMINAL_PROMPT: '0' }
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'credential.helper=', ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    const t = setTimeout(() => {
      child.kill()
      resolve({ code: 1, out: 'Git took too long.' })
    }, 120_000)
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

/** Drop a clone token from origin. A missing remote is fine. */
export async function stripOriginToken(folder: string): Promise<void> {
  const origin = await git(folder, ['remote', 'get-url', 'origin'])
  if (origin.code !== 0) return
  const clean = origin.out
    .trim()
    .replace(/https:\/\/x-access-token:[^@\s]+@/i, 'https://')
    .replace(/https:\/\/[^:\s]+:[^@\s]+@/i, 'https://')
  if (!clean.startsWith('https://') || clean === origin.out.trim()) return
  await git(folder, ['remote', 'set-url', 'origin', clean])
}

/** Point this folder at GitHub and push. The token is not written into .git/config. */
export async function publishLocalToGithub(opts: {
  folder: string
  repo: string
  token: string
  email?: string
  name?: string
}): Promise<{ ok: boolean; detail: string }> {
  const clean = `https://github.com/${opts.repo}.git`
  const authed = `https://x-access-token:${opts.token}@github.com/${opts.repo}.git`
  const email = String(opts.email || '').trim()
  if (email.includes('@')) {
    await git(opts.folder, ['config', 'user.email', email])
    await git(opts.folder, ['config', 'user.name', opts.name || email.split('@')[0]])
  }
  const origin = await git(opts.folder, ['remote', 'get-url', 'origin'])
  const set =
    origin.code === 0
      ? await git(opts.folder, ['remote', 'set-url', 'origin', clean])
      : await git(opts.folder, ['remote', 'add', 'origin', clean])
  if (set.code !== 0) return { ok: false, detail: redact(set.out).slice(-400) }
  const dirty = await git(opts.folder, ['status', '--porcelain'])
  if (dirty.code !== 0) return { ok: false, detail: redact(dirty.out).slice(-400) }
  if (dirty.out.trim()) {
    const add = await git(opts.folder, ['add', '-A'])
    if (add.code !== 0) return { ok: false, detail: redact(add.out).slice(-400) }
    const committed = await git(opts.folder, ['commit', '-m', 'Local brain before GitHub sync'])
    if (committed.code !== 0 && !/nothing to commit/i.test(committed.out)) {
      return { ok: false, detail: redact(committed.out).slice(-400) }
    }
  }
  const head = await git(opts.folder, ['rev-parse', '--verify', 'HEAD'])
  if (head.code !== 0) {
    const fetched = await git(opts.folder, ['fetch', authed, 'HEAD'])
    if (fetched.code !== 0) return { ok: false, detail: redact(fetched.out).slice(-400) }
    const checked = await git(opts.folder, ['checkout', '-B', 'main', 'FETCH_HEAD'])
    if (checked.code !== 0) return { ok: false, detail: redact(checked.out).slice(-400) }
    return { ok: true, detail: 'Copied the GitHub brain into this folder.' }
  }
  const branch = (await git(opts.folder, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() || 'main'
  const pushed = await git(opts.folder, ['push', authed, `HEAD:${branch === 'HEAD' ? 'main' : branch}`])
  if (pushed.code !== 0) return { ok: false, detail: redact(pushed.out).slice(-400) }
  return { ok: true, detail: 'This brain now has a GitHub copy.' }
}
