import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { mapClick } from '@shared/page-picture'

/** The live page. A small click only enlarges. A wide click, key, or wheel reaches the page. */
export function BrowserPicture(props: {
  mode: 'small' | 'wide' | 'note'
  src: string | null
  onToggle: () => void
  onShow: () => void
  onClickAt?: (x: number, y: number) => void
  onTypeText?: (text: string) => void
  onPressKey?: (key: string) => void
  onWheel?: (deltaY: number) => void
}) {
  const shot = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const el = shot.current
    if (props.mode !== 'wide' || !el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      props.onWheel?.(e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [props.mode, props.onWheel])

  if (props.mode === 'note') {
    return (
      <button type="button" className="ghost desk-browser-note" onClick={props.onShow}>
        There were browsers.
      </button>
    )
  }

  function onClick(e: MouseEvent<HTMLButtonElement>) {
    if (props.mode !== 'wide') {
      props.onToggle()
      return
    }
    shot.current?.focus()
    const img = shot.current?.querySelector('img')
    if (!img || !img.naturalWidth || !img.naturalHeight) return
    const rect = img.getBoundingClientRect()
    const style = getComputedStyle(img)
    const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0
    const borderTop = Number.parseFloat(style.borderTopWidth) || 0
    const mapped = mapClick(
      { x: e.clientX - rect.left - borderLeft, y: e.clientY - rect.top - borderTop },
      { width: img.clientWidth, height: img.clientHeight },
      { width: img.naturalWidth, height: img.naturalHeight }
    )
    if (!mapped) return
    props.onClickAt?.(mapped.x, mapped.y)
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (props.mode !== 'wide') return
    if (e.key === 'Enter' || e.key === 'Backspace' || e.key.startsWith('Arrow')) {
      e.preventDefault()
      e.stopPropagation()
      props.onPressKey?.(e.key)
      return
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      props.onTypeText?.(e.key)
    }
  }

  return (
    <button
      type="button"
      ref={shot}
      className="desk-browser-shot"
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {props.src ? <img className={props.mode === 'wide' ? 'wide' : ''} src={`data:image/jpeg;base64,${props.src}`} alt="" /> : null}
    </button>
  )
}
