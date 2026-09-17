import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function appCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    return [
      join(local, 'Programs', 'Agency Brain', 'Agency Brain.exe'),
      join(local, 'Agency Brain', 'Agency Brain.exe'),
      join(pf, 'Agency Brain', 'Agency Brain.exe')
    ]
  }
  return ['/Applications/Agency Brain.app']
}

function configPath(): string {
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(roaming, 'Agency Brain', 'config.json')
  }
  return join(homedir(), 'Library/Application Support/Agency Brain/config.json')
}

function statePath(): string {
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(roaming, 'Agency Brain', 'state.json')
  }
  return join(homedir(), 'Library/Application Support/Agency Brain/state.json')
}

type SafeConfig = {
  installed: boolean
  brainPath: string | null
  name: string | null
  email: string | null
  watching: boolean
}

export function detectApp(): { installed: boolean; path: string } {
  const hits = appCandidates().filter((p) => existsSync(p))
  return { installed: hits.length > 0, path: hits[0] || appCandidates()[0] }
}

/** Reads Agency Brain config. Never returns tokens. */
export function readWatching(): SafeConfig {
  const installed = detectApp().installed
  const config = configPath()
  if (!existsSync(config)) {
    return { installed, brainPath: null, name: null, email: null, watching: false }
  }
  try {
    const raw = JSON.parse(readFileSync(config, 'utf8')) as {
      brainPath?: string
      memberEmail?: string
      memberName?: string
      brandName?: string
      kind?: string
      state?: string
    }
    let watching = false
    try {
      const st = JSON.parse(readFileSync(statePath(), 'utf8')) as { state?: string }
      watching = st.state === 'running' || st.state === 'pulling' || st.state === 'pushing'
    } catch {
      watching = Boolean(raw.brainPath && existsSync(raw.brainPath))
    }
    return {
      installed,
      brainPath: raw.brainPath && existsSync(raw.brainPath) ? raw.brainPath : null,
      name: raw.brandName || raw.memberName || null,
      email: raw.memberEmail || null,
      watching
    }
  } catch {
    return { installed, brainPath: null, name: null, email: null, watching: false }
  }
}

export function writesAllowed(): boolean {
  return process.env.BRAIN_APP_ALLOW_CREATE === '1'
}
