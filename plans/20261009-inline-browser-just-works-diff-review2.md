Items 1, 2, and 3 are fixed in this diff. One new problem is open, so this does not ship.

**Fixed**

1. Navigation keys with Cmd, Ctrl, or Option now reach the page. In `onKeyDown`, a command chord returns early only when the key is outside `MOVES` and outside the edit set, so Cmd+Q and Cmd+W stay Brain's. Arrows, Backspace, Delete, Home, End, PageUp, and PageDown fall through, are `preventDefault`'d, and are sent with their modifier bits.

```103:119:src/renderer/src/BrowserPicture.tsx
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (!wide || LONE.has(e.key)) return
    const command = MAC ? e.metaKey : e.ctrlKey
    if (command && !e.altKey && !MOVES.has(e.key)) {
      const k = e.key.toLowerCase()
      const edit = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : EDIT[k]
      // Cmd+Q, Cmd+W and the other app shortcuts stay Brain's.
      if (!edit) return
      // ...
    }
    e.preventDefault()
    e.stopPropagation()
    const text = e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : undefined
    void window.brain.browser.key(props.owner, { key: e.key, code: e.code, modifiers: modifiers(e), text })
  }
```

On macOS, `key()` turns those chords into the page's editing commands (`moveToBeginningOfLine`, `moveWordLeft`, `deleteToBeginningOfLine`, `deleteWordBackward`, and the `AndModifySelection` forms) before the raw-key path. The render check sends Cmd+Left, Cmd+Shift+Right, Cmd+Up, Cmd+Down, Cmd+Backspace, Option+Left, and Option+Backspace as `4/12/4/4/4/1/1` and still requires Cmd+Q unsent. J7 checks the caret on a real field.

2. A press arms window `mousemove` and `mouseup` until the release, and `move`/`up` are clamped into the contained page rectangle (the object-fit bands), including a release past the picture. Element hover moves are skipped while that drag is active. The render check's outside release is `down,move,up` at `naturalWidth`.

3. `package.json` and both root `version` fields in `package-lock.json` are `0.1.136`.

**Still open**

None of 1–3.

**New**

4. The same clamp runs for every `move` and `up`, and `mousedown` arms the window listeners even when the press was in a band and no `down` was sent. A hover in the letterbox is delivered at the page edge, and a click in the band sends `up` there. Those bands are the wide layout's normal margin, and `mapClick` still treats them as outside the page. The empty-band render check only records `mousePressed`, so it stays green.

```79:90:src/renderer/src/BrowserPicture.tsx
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
```

```131:152:src/renderer/src/BrowserPicture.tsx
      onMouseDown={(e) => {
        if (!wide) return
        e.preventDefault()
        pointer('down', e)
        shot.current?.focus({ preventScroll: true })
        dragging.current = true
        const move = (ev: globalThis.MouseEvent) => { /* ... */ }
        const up = (ev: globalThis.MouseEvent) => {
          window.removeEventListener('mousemove', move, true)
          window.removeEventListener('mouseup', up, true)
          dragging.current = false
          pointer('up', ev)
        }
        window.addEventListener('mousemove', move, true)
        window.addEventListener('mouseup', up, true)
      }}
```

REJECT
