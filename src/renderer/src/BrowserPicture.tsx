import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { mapClick } from '@shared/page-picture'

const EDIT: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut' }
/** Keys that move or delete in a field. With Cmd, Ctrl or Option they are the page's, not Brain's. */
const MOVES = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'])
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
  const dragging = useRef(false)
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

  /** The page point under the mouse. A press in the empty bands around the page is null; a move or release
   * (a drag can end anywhere, even outside the picture) is pulled onto the nearest edge of the page. */
  function pagePoint(e: { clientX: number; clientY: number }, clamp: boolean) {
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
      const scale = Math.min(box.width / natural.width, box.height / natural.height)
      const padX = (box.width - natural.width * scale) / 2
      const padY = (box.height - natural.height * scale) / 2
      x = Math.min(Math.max(x, padX), box.width - padX)
      y = Math.min(Math.max(y, padY), box.height - padY)
    }
    return mapClick({ x, y }, box, natural)
  }

  function pointer(type: 'down' | 'up' | 'move', e: { clientX: number; clientY: number; button: number; buttons: number; detail: number }) {
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
    if (command && !e.altKey && !MOVES.has(e.key)) {
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
        // Until the button comes up, the whole window's mouse belongs to this press, inside the picture or not.
        dragging.current = true
        const move = (ev: globalThis.MouseEvent) => {
          const now = performance.now()
          if (now - lastMove.current < 33) return
          lastMove.current = now
          pointer('move', ev)
        }
        const up = (ev: globalThis.MouseEvent) => {
          window.removeEventListener('mousemove', move, true)
          window.removeEventListener('mouseup', up, true)
          dragging.current = false
          pointer('up', ev)
        }
        window.addEventListener('mousemove', move, true)
        window.addEventListener('mouseup', up, true)
      }}
      onMouseMove={(e) => {
        if (!wide || dragging.current) return
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
