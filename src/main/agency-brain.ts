import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_PATH = '/Applications/Agency Brain.app'
const CONFIG = join(homedir(), 'Library/Application Support/Agency Brain/config.json')
const STATE = join(homedir(), 'Library/Application Support/Agency Brain/state.json')

type SafeConfig = {
  installed: boolean
  brainPath: string | null
  name: string | null
  email: string | null
  watching: boolean
}

export function detectApp(): { installed: boolean; path: string } {
  return { installed: existsSync(APP_PATH), path: APP_PATH }
}

/** Reads Agency Brain config. Never returns tokens. */
export function readWatching(): SafeConfig {
  const installed = existsSync(APP_PATH)
  if (!existsSync(CONFIG)) {
    return { installed, brainPath: null, name: null, email: null, watching: false }
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG, 'utf8')) as {
      brainPath?: string
      memberEmail?: string
      memberName?: string
      brandName?: string
      kind?: string
      state?: string
    }
    let watching = false
    try {
      const st = JSON.parse(readFileSync(STATE, 'utf8')) as { state?: string }
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
