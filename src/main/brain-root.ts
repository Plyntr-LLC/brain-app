import { dirname } from 'node:path'
import { readWatching } from './agency-brain'
import { knownBrainPaths } from './brains'
import { realish } from './factory/paths'

export type BrainRoot = {
  /** The brain folder as listed (brains.json, Agency Brain config, or the caller's extra), for seat lookups. */
  root: string
  /** Its realpath, for containment checks. */
  real: string
}

/**
 * The brain folder that actually contains abs, judged by realpath so a symlink cannot hop out of
 * or into a brain. Candidates: every listed brain, the folder Agency Brain watches, and extra
 * (e.g. the chat's own folder). The deepest match wins. Null when abs is in no brain.
 */
export function brainRootFor(abs: string, extra: string[] = []): BrainRoot | null {
  const byReal = new Map<string, string>()
  const add = (p: string | null | undefined) => {
    const path = String(p || '').trim()
    if (!path) return
    const real = realish(path)
    if (!byReal.has(real)) byReal.set(real, path)
  }
  for (const p of extra) add(p)
  try {
    for (const path of knownBrainPaths()) add(path)
  } catch {
    /* no brains file */
  }
  try {
    add(readWatching().brainPath)
  } catch {
    /* no Agency Brain config */
  }
  let cur = realish(abs)
  for (;;) {
    const hit = byReal.get(cur)
    if (hit) return { root: hit, real: cur }
    const up = dirname(cur)
    if (up === cur) return null
    cur = up
  }
}
