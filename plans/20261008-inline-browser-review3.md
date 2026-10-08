Item 15 is still open. Items 7, 14, and 16 are fixed. Nothing new.

**15.** The ported-harness paragraph keeps both files and names most of the old checks. The close-while-opening check is still the one a wrong run can pass, and the new hold point fights the probe.

The queued click is "still lands there after chat-a opens WhatsApp." The test also requires that same `mouse 9 8` to be absent on `wa`. A click delivered to both windows still matches the sentence.

The preparing-close sentence is "a chat closed while its window is still preparing never navigates and its window is destroyed; the same for a desk `closeOwner`."

- "A chat closed" is satisfied by `closeShared`, which step 12 already calls. The test calls the `chat:close` handler (`close!(null, 'chat-z')` in `shared-browser.test.ts`), which also runs `closeWarm` and `stopPrompt`.
- "Its window is destroyed" is satisfied by destroying the host while the webContents recorded for that open stays alive. The old assert is that recorded page's `_closed`.
- Neither close is required to leave the WhatsApp webContents alive. A preparing close that also destroys `wa` still matches. The "keeps `wa`" clause is only on the later `chat:close` of chat-a, after that window is already open.

`holdPrepare` is "held on the `Emulation.setFocusEmulationEnabled` call that ends a window's preparation," and that close has to show the target URL was never loaded. The probe says that call before the first `loadURL` hangs, and after the load it works. Today the hold is `setViewport`, before `goto`, while the new page is still `about:blank` and `entered` has not grown. Holding the focus call either waits on the call that hangs, or waits after the target `loadURL`, in which case `entered` already contains the URL and "never navigates" fails on a correct open. The hold has to be a moment where that new webContents exists, the target is not in `entered`, and a blank load has already finished so the focus call is legal.

The small-click sentence is "widens only that chat." The test also requires the action list unchanged and the window not shown. A small click that also sends `mouse` to the page still widens only that chat.

Fixed: 7, 14, 16.

Still open: 15.

New: none.

REJECT
