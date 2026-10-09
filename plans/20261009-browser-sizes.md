# Small, Wide and Large for the browser in a chat

Joe 2026-10-09: "When I expand the browser I would also like to be able to then compress it again to its small size. I would like an option to expand it even further so that it maybe takes up more space, so that I can keep chatting in the chat but it's a larger window that I can interact with more easily. I also want to be able to minimize it again."

Working preference 13 (existing screens stay): Joe asked for these controls explicitly. Hide keeps its place, and the picture keeps its place in the thread for small and wide. The new buttons sit after Hide in the same row. Large is a new view he asked for.

## Today (0.1.136)

- `TerminalWorkspace.tsx` holds `pageView: 'small' | 'wide' | 'note'` per chat tab and renders `ChatPageTurn` as `pageSlot` under the message that opened the page (inside `SkinPane` when Skin is on, which is the default; in the plain thread otherwise).
- `ChatPageTurn`: the `BrowserPicture`, then one button: Hide (sets `note`), or Open browser (sets `wide`) when the page wants a sign-in. The note ("There were browsers.") click sets `small`.
- `BrowserPicture`: a small click widens. Wide (`img.wide`: full width, 320 px tall, max 420) is live (`browser.watch` frames) and takes mouse, keys and wheel through `pagePoint` and `mapClick` (object-fit contain, box-agnostic).
- Nothing in wide goes back to small. Wide's 320 px height leaves the 1100x800 page at about 440x320.
- The poll for the picture runs every 0.5 s in wide and 1.5 s otherwise.
- `onOpened` (a tool in this chat opened a page for a newer message) moves the picture under that message and sets `small`.

## 1. Behavior when done

1. Views: `small`, `wide`, `large`, `note`.
2. Under the picture, the first button is what it is today: Hide, or Open browser when the page wants a sign-in. After it, one button for each size the picture is not in, in the order Small, Wide, Large. While Open browser shows, Wide is left out (Open browser does the same thing). Nothing shows in `note`.
3. A small click on the picture still widens it.
4. Large docks the same picture at the top of the chat pane, above the conversation: full pane width, 60% of the pane's height. The conversation scrolls in the space below it and the message box stays on screen and usable. The thread shows no second copy, so there is one picture and one live watch.
5. Large is live and interactive exactly like wide: frames, mouse, drag, keys, wheel, through the same `pagePoint` and `mapClick`. The poll is 0.5 s in wide and in large.
6. Small, from wide or large, puts the picture back under its message at small size. Hide still gives the note; the note still brings back small.
7. A newer message whose tool opens a page moves the picture under that message and keeps the size it had (small, wide or large). Only a hidden picture comes back small. This changes wide too: today a new turn shrinks it.
8. Desk pictures do not change. `BrowserPicture`'s mode type widens to include `large`; Desk never passes it.

## 2. How this can fail

F1. Large renders the picture in the dock and in the thread: two images, two watches, double frames.
F2. The dock pushes the message box off screen or leaves the conversation no room.
F3. Large is not live (the watch only starts for `wide`) or keeps the 1.5 s poll, so the page looks stale.
F4. A click or drag on the large picture lands on the wrong page point.
F5. Keys typed in the message box while large go to the page, or keys typed into the focused picture go to the message box.
F6. Small from large leaves the dock on screen, or puts the picture under the wrong message.
F7. A tool opening a page on a newer turn collapses large (or wide) back to small.
F8. The new buttons replace or move Hide or Open browser, or show in the note.
F9. Switching chat tabs leaves another tab's dock on screen.
F10. The Desk picture changes.

## 3. End-to-end check (medium case) and its artifact

New `scripts/render-ui/browser-sizes.tsx` for the existing `scripts/render-ui.ts` harness (`node --experimental-strip-types scripts/render-ui.ts browser-sizes`). Window 1400x900. It mounts two real `ChatPane`s (tabs `a` and `b`, Skin on as in the app; `a` active) with the stub `window.brain` pattern from `browser-live.tsx`: `browser.onOpened` keeps listeners, `browser.face` returns a canvas jpeg (1100x800, a dark box at page 60,60 to 360,140), `browser.watch`, `browser.pointer` and `browser.key` record calls, `browser.onFrame` keeps listeners.

1. Send "open the site" in `a`, fire `onOpened('chat:a')`. One `.page-turn` sits inside the turn whose text is "open the site". The picture is small. The buttons under it read exactly Hide, Wide, Large. Screenshot `small.png`.
2. Click Wide. The thread picture is `img.wide`. Buttons read Hide, Small, Large. `watch('chat:a', true)` was called once. Screenshot `wide.png`. Record the picture's rendered page-content width (from its box and natural size).
3. Click Large. `.chatpane.on > .page-dock` exists and is the element right before `.skin-pane`. The pane holds exactly one picture `img` (F1). The dock's height is 55% to 65% of the chat pane's. The rendered page-content width is larger than in step 2. Buttons read Hide, Small, Wide. Screenshot `large.png`.
3b. (review 1, F2) Live geometry, from `getBoundingClientRect`: the dock's left and right edges equal the chat pane's left and right content edges (within 2 px), so the dock spans the pane. The dock image's `clientWidth` equals the chat pane's `clientWidth` minus the dock's left and right padding (within 2 px), and the image runs from the dock's content top to the top of the dock's button row (within 2 px). `.skin-thread`'s top equals the dock's bottom (within 2 px), the two rects do not intersect, and the thread is at least 150 px tall. With 30 extra messages in the thread, the thread's `scrollHeight` exceeds its `clientHeight` and setting `scrollTop` moves it. `document.elementFromPoint` at the composer textarea's centre is that textarea, and the textarea's bottom is inside the window.
3c. (review 2, F3) For `chat:a`, the count of `watch(…, true)` minus the count of `watch(…, false)` is exactly 1 after Large, and two `watch(…, true)` never occur without a `watch(…, false)` between them. One frame sent through `onFrame` for `chat:a` changes the single dock image's `src`.
4. Mouse down and up on the dock picture at the screen point that `mapClick` puts on page point (210, 100). The recorded pointer events carry x, y within 1 px of (210, 100) (F4). Then a drag from that point released 200 px past the picture's right edge reports an `up` with x exactly 1100 (review 3).
4b. (review 3) A `wheel` event on the dock picture calls `browser.wheel` for `chat:a` with that deltaY.
5. Focus the picture and press `a`: `browser.key` gets it. Click the textarea and type `b`: `browser.key` gets nothing new and the textarea holds `b` (F5).
6. Send "next one" while large; fire `onOpened('chat:a')`. The dock is still there with one picture, and no `.page-turn` is in the thread (F7).
7. Click Small. No `.page-dock`. One `.page-turn` sits inside the "next one" turn with a small picture. `watch('chat:a', false)` was called (F6).
7b. (review 4) Click Large again, then Hide. No `.page-dock`. The note sits in the "next one" turn and shows no size buttons. The note click gives small with Hide, Wide, Large.
8. Click Wide, then fire `onOpened('chat:a')` after sending "third". The picture is under "third" and still wide (behavior 7). Hide gives the note with no size buttons (F8); the note click gives small with Hide, Wide, Large.
9. Large in `a`, then switch to tab `b`: no `.page-dock` is visible in `b`'s pane (F9).
10. Sign-in: `face` reports a sign-in. Small shows the text "Sign in, in the browser." and buttons Open browser, Large. Open browser gives wide.

Prints RENDER_UI_PASS. Screenshots in `plans/20261009-browser-sizes-shots/`.

Then the existing `render-ui.ts browser-live`, `browser-opened` and `shared-browser` still print RENDER_UI_PASS (F10 and the Desk), and `npm run typecheck` passes.

Live app: the packed app in the sandbox (`check-live-app.ts` pattern) opens a local page in a chat, clicks Large, and saves a window screenshot `plans/20261009-browser-sizes-shots/live-large.png` showing the dock, the conversation and the message box.

## 4. Files

- `src/renderer/src/TerminalWorkspace.tsx`: the view type, the dock in large, `pageSlot` null in the thread while large, poll in large, `onOpened` keeps the size.
- `src/renderer/src/ChatPageTurn.tsx`: size buttons after Hide or Open browser.
- `src/renderer/src/BrowserPicture.tsx`: `large` is live and interactive.
- `src/renderer/src/styles/shell.css`: `.page-dock` and the large image.
- New `scripts/render-ui/browser-sizes.tsx`; one line in `scripts/render-ui.ts` if pages are listed there.
- `package.json` 0.1.137 (shared with the WhatsApp accounts plan). `GOAL.md` Now line.
