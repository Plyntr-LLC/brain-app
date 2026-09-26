import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type ResolveCloudflaredOpts = {
  userDataDir?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

export function cloudflaredFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

export function fallbackUserDataDir(platform: NodeJS.Platform = process.platform, home = homedir()): string {
  return platform === 'win32'
    ? join(home, 'AppData', 'Roaming', 'Brain')
    : join(home, 'Library', 'Application Support', 'Brain')
}

export function cloudflaredUserBin(userDataDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(userDataDir, 'bin', cloudflaredFileName(platform))
}

export function binRuns(path: string): boolean {
  try {
    return spawnSync(path, ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

export function win32CloudflaredCandidates(env: NodeJS.ProcessEnv, home: string, userDataDir: string): string[] {
  const name = cloudflaredFileName('win32')
  const pf = env.ProgramFiles || 'C:\\Program Files'
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  return [
    cloudflaredUserBin(userDataDir, 'win32'),
    join(pf, 'cloudflared', name),
    join(pf86, 'cloudflared', name),
    join(local, 'Microsoft', 'WinGet', 'Links', name),
    join(local, 'Programs', 'cloudflared', name)
  ]
}

function namedCandidates(opts: {
  userDataDir: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
}): Array<string | undefined> {
  const { userDataDir, platform, env, home } = opts
  if (platform === 'win32') {
    return [env.CLOUDFLARED_BIN, ...win32CloudflaredCandidates(env, home, userDataDir)]
  }
  return [
    env.CLOUDFLARED_BIN,
    cloudflaredUserBin(userDataDir, platform),
    join(home, '.local', 'bin', 'cloudflared'),
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared'
  ]
}

function lookupOnPath(opts: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; extraDirs: string[] }): string | null {
  const { platform, env, extraDirs } = opts
  const sep = platform === 'win32' ? ';' : ':'
  const pathVal = env.PATH || env.Path || ''
  const dirs = [...pathVal.split(sep).filter(Boolean), ...extraDirs]
  const names = platform === 'win32' ? ['cloudflared.exe', 'cloudflared'] : ['cloudflared']
  for (const dir of dirs) {
    for (const n of names) {
      const p = join(dir, n)
      if (existsSync(p) && binRuns(p)) return p
    }
  }
  try {
    if (platform === 'win32') {
      const r = spawnSync('where', ['cloudflared'], { encoding: 'utf8', env })
      const out = String(r.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
      return r.status === 0 && out && binRuns(out) ? out : null
    }
    const extra = extraDirs.join(':')
    const r = spawnSync('which', ['cloudflared'], {
      encoding: 'utf8',
      env: { ...env, PATH: `${env.PATH || ''}:${extra}` }
    })
    const out = String(r.stdout || '').trim()
    return r.status === 0 && out && binRuns(out) ? out : null
  } catch {
    return null
  }
}

export function resolveCloudflaredBin(opts: ResolveCloudflaredOpts = {}): string | null {
  const platform = opts.platform || process.platform
  const env = opts.env || process.env
  const home = opts.home || homedir()
  const userDataDir = opts.userDataDir || fallbackUserDataDir(platform, home)
  for (const p of namedCandidates({ userDataDir, platform, env, home })) {
    if (p && existsSync(p) && binRuns(p)) return p
  }
  const extraDirs =
    platform === 'win32'
      ? [dirname(cloudflaredUserBin(userDataDir, platform))]
      : [dirname(cloudflaredUserBin(userDataDir, platform)), '/opt/homebrew/bin', '/usr/local/bin']
  return lookupOnPath({ platform, env, extraDirs })
}
