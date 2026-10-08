import { useEffect } from 'react'

/** Follow the page picture while the thread is already pinned. The message list keeps its own scroll. */
export function usePageFollow(
  thread: { current: HTMLElement | null },
  pinned: { current: boolean },
  watch: string
) {
  useEffect(() => {
    if (!pinned.current) return
    const turn = thread.current?.querySelector('.page-turn')
    if (turn instanceof HTMLElement) turn.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [thread, pinned, watch])
}
