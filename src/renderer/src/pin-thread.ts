import { useEffect } from 'react'

/** While the thread is pinned to the end, a new picture frame or size keeps it at the end. It never scrolls up to the picture. */
export function usePageFollow(
  thread: { current: HTMLElement | null },
  pinned: { current: boolean },
  watch: string
) {
  useEffect(() => {
    if (!pinned.current) return
    const el = thread.current
    if (el) el.scrollTo(0, el.scrollHeight)
  }, [thread, pinned, watch])
}
