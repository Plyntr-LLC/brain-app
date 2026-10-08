/**
 * One page at a time. A turn claims synchronously, then waits.
 * A later claim that lands before this one touches the page wins, and this one does not run.
 * The lane stays held until release, so the next turn cannot overlap the work.
 */
let generation = 0
let tail: Promise<void> = Promise.resolve()

export function startPageTurn(): { promise: Promise<boolean>; release: () => void } {
  const mine = ++generation
  const prev = tail
  let released = false
  let release!: () => void
  tail = new Promise<void>((resolve) => {
    release = () => {
      if (released) return
      released = true
      resolve()
    }
  })
  return { promise: prev.then(() => mine === generation), release }
}
