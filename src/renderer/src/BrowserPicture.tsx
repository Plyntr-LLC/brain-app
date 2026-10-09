import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { mapClick } from '@shared/page-picture'

const EDIT: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut' }
const LONE = new Set(['Meta', 'Shift', 'Control', 'Alt', 'CapsLock', 'Fn'])
const MAC = /mac/i.test(navigator.platform)

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
}

/** The live page. A small click only enlarges. Wide, it shows the page as it changes and takes the mouse and keys. */
export function BrowserPicture(props: {
  mode: 'small' | 'wide' | 'note'
  src: string | null
  /** The browser place this picture shows: `chat:<tab>` or `desk:<bot>`. */
  owner: string
  /** The tab or Desk holding the picture is the one on screen. */
  active: boolean
  onToggle: () => void
  onShow: () => void
}) {
  const shot = useRef<HTMLButtonElement>(null)
  const lastMove = useRef(0)
  const [live, setLive] = useState<string | null>(null)
  const wide = props.mode === 'wide' && !!props.owner
  const watching = wide && props.active

  useEffect(() => {
    if (!watching) return
    const owner = props.owner
    const off = window.brain.browser.onFrame((f) => {
      if (f.owner === owner) setLive(f.src)
    })
    void window.brain.browser.watch(owner, true)
    return () => {
      off()
      void window.brain.browser.watch(owner, false)
      setLive(null)
    }
  }, [watching, props.owner])

  useEffect(() => {
    const el = shot.current
    if (!wide || !el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      void window.brain.browser.wheel(props.owner, e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [wide, props.owner])

  if (props.mode === 'note') {
    return (
      <button type="button" className="ghost desk-browser-note" onClick={props.onShow}>
        There were browsers.
      </button>
    )
  }

  /** The page point under the mouse, or null in the empty bands around the page. */
  function pagePoint(e: MouseEvent<HTMLButtonElement>, clamp: boolean) {
    const img = shot.current?.querySelector('img')
    if (!img || !img.naturalWidth || !img.naturalHeight) return null
    const rect = img.getBoundingClientRect()
    const style = getComputedStyle(img)
    const left = Number.parseFloat(style.borderLeftWidth) || 0
    const top = Number.parseFloat(style.borderTopWidth) || 0
    const box = { width: img.clientWidth, height: img.clientHeight }
    const natural = { width: img.naturalWidth, height: img.naturalHeight }
    let x = e.clientX - rect.left - left
    let y = e.clientY - rect.top - top
    if (clamp) {
      x = Math.min(Math.max(x, 0), box.width)
      y = Math.min(Math.max(y, 0), box.height)
    }
    return mapClick({ x, y }, box, natural)
  }

  function pointer(type: 'down' | 'up' | 'move', e: MouseEvent<HTMLButtonElement>) {
    const at = pagePoint(e, type !== 'down')
    if (!at) return
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'
    void window.brain.browser.pointer(props.owner, {
      type,
      x: at.x,
      y: at.y,
      button: type === 'move' && !e.buttons ? 'none' : button,
      buttons: e.buttons,
      clickCount: type === 'move' ? 0 : Math.max(1, e.detail)
    })
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (!wide || LONE.has(e.key)) return
    const command = MAC ? e.metaKey : e.ctrlKey
    if (command && !e.altKey) {
      const k = e.key.toLowerCase()
      const edit = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : EDIT[k]
      // Cmd+Q, Cmd+W and the other app shortcuts stay Brain's.
      if (!edit) return
      e.preventDefault()
      e.stopPropagation()
      void window.brain.browser.key(props.owner, { key: e.key, code: e.code, modifiers: modifiers(e), command: edit })
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const text = e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : undefined
    void window.brain.browser.key(props.owner, { key: e.key, code: e.code, modifiers: modifiers(e), text })
  }

  const src = (wide && live) || props.src
  return (
    <button
      type="button"
      ref={shot}
      className="desk-browser-shot"
      onClick={() => {
        if (!wide) props.onToggle()
      }}
      onMouseDown={(e) => {
        if (!wide) return
        e.preventDefault()
        pointer('down', e)
        // Keys go to the page while the picture has focus. Scrolling it into view would move it under the mouse.
        shot.current?.focus({ preventScroll: true })
      }}
      onMouseUp={(e) => {
        if (wide) pointer('up', e)
      }}
      onMouseMove={(e) => {
        if (!wide) return
        const now = performance.now()
        if (now - lastMove.current < 33) return
        lastMove.current = now
        pointer('move', e)
      }}
      onContextMenu={(e) => {
        if (wide) e.preventDefault()
      }}
      onDragStart={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      {src ? <img className={props.mode === 'wide' ? 'wide' : ''} src={`data:image/jpeg;base64,${src}`} alt="" draggable={false} /> : null}
    </button>
  )
}
