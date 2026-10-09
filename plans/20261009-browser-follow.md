# The chat stops jumping back to the browser picture

Joe 2026-10-09: "it keeps jumping me the whole way back in the thread to the last open browser window which is driving me crazy. somehow we need to avoid this and keep the working window close to the end of the thread so it stays where we are working."

## Cause (today)

`src/renderer/src/pin-thread.ts` `usePageFollow` runs on every change of `${pageView}:${pageShot}`. `pageShot` changes on every poll of the picture (every 0.5 s wide, 1.5 s small). When the thread is pinned to the end, it calls `.page-turn.scrollIntoView({ block: 'nearest' })`. The picture sits under the message that opened the page, which can be far up the thread, so each new frame scrolls the thread up to it. The scroll unpins the thread; as soon as Joe scrolls back to the end, the next frame pulls him up again.

## 1. Behavior when done

1. While the thread is pinned to the end, a new picture frame, a size change, or the picture appearing keeps the thread at the end. Nothing scrolls the thread up to the picture.
2. While the thread is not pinned (the person scrolled up to read), a frame or size change does not move what the person is reading: the lines on screen stay where they are. (Chrome's scroll anchoring may change `scrollTop` to keep them there; Brain itself does not scroll.)
3. The picture follows the work: when the person sends a new message and the picture is showing (small or wide), it moves under that new message, so it stays in the current turn near the end. A hidden picture (the note) stays where it was. Large is docked above the conversation, as before.
4. Everything else stays: the picture's size, the buttons, a tool opening a page on a newer turn, the dock.

## 2. How this can fail

F1. A frame still scrolls a pinned thread up to an older picture (the bug).
F2. A frame scrolls a thread the person scrolled up in.
F3. Widening the picture at the end leaves the thread short of the end (the bottom of the picture hidden).
F4. A new message leaves the picture in the old turn, or moves a hidden note, or makes two pictures.
F5. A move leaves two live watches at once, a watch that is never stopped, more than one stop and start, no live frame after the start, or the picture at another size. One stop and start of the live watch while the picture moves to the new turn is fine: the next frame comes at once.

## 3. End-to-end check (medium case) and its artifact

New `scripts/render-ui/browser-follow.tsx` on the real `ChatPane` (Skin on), stub `window.brain` whose `browser.face` returns a different jpeg on each call (so `pageShot` changes every poll), 1000x800 window.

Each reply is finished (a chat `done` event) before the next message is sent, so every send starts a new turn.

1. Appearance and reproduction. Send "open it". Before any picture, stream a long reply (60 paragraphs as chat `text` events), then finish the turn, so the thread is much taller than the window. Pin the thread at the end. Fire `browser:opened`: the picture appears in the "open it" turn, above the reply. The thread is still at the end and `scrollTop` did not fall (behavior 1). The picture is still in the "open it" turn and far above the end. Wait 3.2 s; `browser.face` returned at least twice in that time; the thread is still at the end and `scrollTop` did not fall (F1). On HEAD this step fails; the trace keeps that failing run.
2. Scroll up 600 px. Note the reply paragraph at the top of the visible area and its on-screen top. Wait 1.7 s with at least one `browser.face` landing: `scrollTop` is unchanged (F2). Still scrolled up, click Wide on the picture (far above): right after, and after 1.2 s of wide frames, that same paragraph's on-screen top is within 2 px of where it was (behavior 2). Then Small.
3. Back at the end, send "next": one small `.page-turn` under "next", the thread at the end (F4, behavior 3). Click Wide while pinned: the thread is still at the end and the wide picture's bottom is inside the thread's visible area, right after and after 1.2 s of frames (F3, F1).
4. Record the watch counts and send "wide move": one `.page-turn` under "wide move", still `wide`, the thread at the end. Across the move `watch(true)` rose by at most one and `watch(false)` by at most one, `watch(true)` minus `watch(false)` is still 1, two `watch(true)` never come without a `watch(false)` between, and a live frame sent after the move shows in that one picture (F5).
5. Small, then send "small move": one picture, small, under "small move" (F4).
6. Hide, then send "after hide": the note stays in the "small move" turn; no picture under "after hide" (F4).

Prints RENDER_UI_PASS; the run on HEAD before the change is saved as the reproduction. Then `browser-sizes`, `browser-live`, `browser-opened`, `shared-browser` and `whatsapp-send` render checks still pass, and `npm run typecheck`.

## 4. Files

- `src/renderer/src/pin-thread.ts`: pinned means stay at the end; no scroll to the picture.
- `src/renderer/src/TerminalWorkspace.tsx`: a new message moves a showing picture to it.
- New `scripts/render-ui/browser-follow.tsx`.
- `GOAL.md` Now line (0.1.137).
