import { join } from 'node:path'

/** Desk files live under desk/ in the open brain. They are local to this Mac and never synced. */

export const DESK_DIR = 'desk'

export function deskDir(brain: string): string {
  return join(brain, DESK_DIR)
}

export function botsDir(brain: string): string {
  return join(brain, DESK_DIR, 'bots')
}

export function botFile(brain: string, id: string): string {
  return join(botsDir(brain), `${id}.md`)
}

export function mailFile(brain: string): string {
  return join(brain, DESK_DIR, 'mail', 'desk.md')
}

export function memoryDir(brain: string): string {
  return join(brain, DESK_DIR, 'memory')
}

export function memoryFile(brain: string, id: string): string {
  return join(memoryDir(brain), `${id}.md`)
}

/** Raw lines moved out of This week. Never put in a prompt. */
export function archiveFile(brain: string, id: string): string {
  return join(memoryDir(brain), `${id}-archive.md`)
}

/** isoWeek of the last weekly memory pass for that bot. */
export function weekFile(brain: string, id: string): string {
  return join(memoryDir(brain), `${id}-week.txt`)
}
