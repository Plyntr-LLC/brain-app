import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readWatching } from './agency-brain'
import { gitPull, gitPushIfDirty } from './clone'

let timer: ReturnType<typeof setInterval> | null = null
let cwd = ''

function abOwns(folder: string): boolean {
  const w = readWatching()
  return Boolean(w.brainPath && w.watching && w.brainPath === folder)
}

async function tick(): Promise<void> {
  if (!cwd || !existsSync(join(cwd, '.git'))) return
  if (abOwns(cwd)) return
  await gitPull(cwd)
  await gitPushIfDirty(cwd)
}

/** Quiet pull/push when Agency Brain is not watching this folder. Never force. */
export function startBrainSync(folder: string): void {
  if (!folder) return
  cwd = folder
  if (abOwns(folder)) return
  if (timer) clearInterval(timer)
  void tick()
  timer = setInterval(() => void tick(), 60_000)
}

export function stopBrainSync(): void {
  if (timer) clearInterval(timer)
  timer = null
  cwd = ''
}
