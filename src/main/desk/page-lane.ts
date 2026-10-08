/**
 * One queue per window. Different windows run together.
 * The same window waits: the later step runs after the earlier one finishes.
 */
const tails = new Map<string, Promise<void>>()

export function startPageTurn(key = 'page'): { promise: Promise<boolean>; release: () => void } {
  const prev = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  let released = false
  const gate = new Promise<void>((resolve) => {
    release = () => {
      if (released) return
      released = true
      resolve()
    }
  })
  const done = prev.then(() => gate)
  tails.set(key, done)
  done.then(() => {
    if (tails.get(key) === done) tails.delete(key)
  })
  return { promise: prev.then(() => true), release }
}
