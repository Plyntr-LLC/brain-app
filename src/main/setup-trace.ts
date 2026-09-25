import { appendFileSync, mkdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'

export function setupTracePath(): string {
  const forced = String(process.env.BRAIN_APP_SETUP_TRACE_FILE || '').trim()
  if (forced) return forced
  const home = userInfo().homedir
  if (process.platform === 'darwin') return join(home, 'Library/Application Support/brain-app/setup-trace.jsonl')
  return join(home, '.config/brain-app/setup-trace.jsonl')
}

export function setupTrace(row: Record<string, unknown>): void {
  if (process.env.BRAIN_APP_SETUP_TRACE !== '1') return
  const file = setupTracePath()
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(row) + '\n')
}
