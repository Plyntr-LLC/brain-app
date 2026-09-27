import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Realpath of a path, or of its nearest existing parent with the missing tail put back. */
export function realish(p: string): string {
  let cur = resolve(String(p || ''))
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(cur)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      const up = dirname(cur)
      if (up === cur) return resolve(String(p || ''))
      tail.push(basename(cur))
      cur = up
    }
  }
}

/** True when target is root or inside it. Both sides are compared as given; realish them first. */
export function underPath(root: string, target: string): boolean {
  if (!root || !target || !isAbsolute(root) || !isAbsolute(target)) return false
  const b = resolve(root)
  const t = resolve(target)
  return t === b || t.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** Both sides realpath'd, so /var and /private/var or a symlinked folder compare equal. */
export function underReal(root: string, target: string): boolean {
  return underPath(realish(root), realish(target))
}
