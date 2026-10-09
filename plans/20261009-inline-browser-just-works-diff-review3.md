**4 is fixed.** A point in the empty band is no longer clamped onto the page, and a press there no longer arms the window listeners.

`pointer` now takes `clamp` (default false) and returns whether it sent. A hover goes through `onMouseMove` as `pointer('move', e)`, and the press is `pointer('down', e)`. Both leave `clamp` false, so `pagePoint` hands the raw point to `mapClick`, which still returns null in the letterbox. Nothing is sent.

```90:92:src/renderer/src/BrowserPicture.tsx
  function pointer(type: 'down' | 'up' | 'move', e: { clientX: number; clientY: number; button: number; buttons: number; detail: number }, clamp = false) {
    const at = pagePoint(e, clamp)
    if (!at) return false
```

`onMouseDown` sets `dragging` and adds the window `mousemove` / `mouseup` listeners only after that press returns true. Only those listeners pass `clamp: true`.

```138:151:src/renderer/src/BrowserPicture.tsx
        if (!pointer('down', e)) return
        // A press on the page owns the window's mouse until the button comes up, inside the picture or not.
        dragging.current = true
        const move = (ev: globalThis.MouseEvent) => {
          // ...
          pointer('move', ev, true)
        }
        const up = (ev: globalThis.MouseEvent) => {
          // ...
          pointer('up', ev, true)
        }
```

The new browser-live check (chat and desk) hovers and presses in the side band, then dispatches a window move, a window release, and an element release, and expects zero `browser.pointer` calls. The outside-release drag still passes `clamp: true`, and `pagePoint`'s clamp math is unchanged.

Fixed: 4. Still open: none. New: none.

APPROVE
