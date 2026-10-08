The check would not catch a wrong implementation. Several of the failures you listed are either untested or tested with a signal that stays green when the behavior is wrong. The original bug, the picture never appearing under the message, is explicitly allowed to be skipped.

1. **Step 3 does not match `mapClick`.** `mapClick` turns a point in the displayed box into natural-image pixels. With a 550×400 box and an 1100×800 image, the scale is 0.5, so feeding it the link’s CSS centre doubles the point and a correct click misses. Specify the input as the link centre scaled into that box, require `mapClick` to return the CSS centre, and pass only that return value to `clickAt`.

2. **F3’s stale frame is checked on the DOM, not the picture.** `browser_read` is `pageSnapshot`. A jpeg cached from `/form` still passes step 3 when the URL is `/next`. After that navigation, both `browser_screenshot` and `face('chat:A')` must return a new jpeg, natural size 1100×800, not one colour, and byte-different from the `/form` shot.

3. **Several chats at once, and shared logins, are not tested.** Step 8 only shows that WhatsApp is one `webContents`. A single page for every other address still passes. Before WhatsApp, leave `chat:A` on `/form`, open `/next` as `chat:B`, and require different webContents ids and the right heading from each read. Then set a cookie in A’s window, read it from B’s window, quit, and start again with the same userData. The cookie must still be there. That is the `persist:brain-browser` requirement.

4. **F13 can pass while Buy is clicked, and Enter skips the pay fence.** The fixture’s Buy button has no effect, so “page unchanged” is true either way. Make the button set the text `purchased`. `browser_click` must leave that text absent and say the person can click it. `browser_key` is specified as `pressKey`, and `pressKey` does not run `payCheck`. Add a field whose submit control is Buy now. `browser_type` plus `browser_key Enter` must not set `purchased` and must return the same sentence. The contenteditable is not in a form, so its Enter echo stays the F6 check.

5. **F15 never destroys a real window, and it never closes a tab.** After step 8, `chat:B` has only the shared `wa` window. `closeOwner` closes the key `chat:B`, which was never created, so “destroyed” is vacuously true. `chat:B` must open `/form` first. Record that webContents id. Both the MCP `browser_close` and the existing tab-close path (`chat:close` → `closeShared`) must destroy it. The WhatsApp webContents from step 8 must still be alive.

6. **F7 and F8 on the renderer are not a gate.** The required script only checks that main emitted `browser:opened`. The thread check is allowed to be skipped. Require a renderer harness, the same kind as `scripts/render-ui.ts`, with Skin on (that is the default): `onOpened` for this tab sets `pageAt` to the latest `me` message and `.page-turn` is under it; a second event does not move `pageAt`; no sent message does not throw and leaves `pageAt` null; another owner does not change this tab.

7. **Resume, Factory, and the rule text are outside the check.** `session/load` in `acpWarm` and `acpResume` sends `mcpServers: []` on its own, separate from `sessionNewParams`. Assert the object those load calls send for a chat tab includes this server, and that a factory `session/new` still sends `mcpServers: []`. One Grok process serves every tab in a folder (`poolKey` is `kind:cwd`). The Grok step must start two sessions on that one process and each `browser_open` must arrive as its own owner. Assert `BROWSER_RULE` is on the Claude argv and in the Grok chat rules. For F10, record a baseline `claude -p` init first and require every non-control-chrome server name from that list to still be present.

8. **F12’s second clause is not in the script.** Step 9 sends a wrong token only. Also send a call with the token omitted, and after the second start send the first run’s token. Both must error and leave the page unchanged. Assert the socket mode is `0600`.

9. **F16 only watches the old profile path.** `pgrep -f "Google Chrome.*brain-sessions"` stays empty if Chrome is launched with any other user-data-dir or via `open`. Record Google Chrome pids before the run and require no new pid at the end.

10. **The WhatsApp step checks the title only.** The unsupported-browser page is also titled WhatsApp. Require the snapshot text to be the scan-to-log-in page the probe already distinguished.

11. **The packaged check never uses the path the app will spawn.** Running `Contents/Resources/browser-mcp.cjs` by hand stays green when the spec builder points somewhere else. Spawn the command that builder returns for the packaged resources path, then require `initialize` and 8 tools.

12. **Codex can break and the script still prints pass.** Behavior 5 allows a deferral, but nothing attempts `thread/start`. Send the exact config the chat path sends. If Codex rejects it, a start without that config must still return a thread, and the deferral must be written. A `thread/start` that throws fails the check.

13. **F2 and F14 have no deadline.** A CDP command before the first load hangs step 1 forever, and “within the tool timeout” can be many minutes. Bound the first `browser_open` and the `/hang` call at 45 seconds. Past that, the step fails.

14. **Behavior 4 and the picture’s own key and wheel path have no step.** Add a `window.open('/next')` control beside the `target=_blank` link. Same window ends on `/next`, and `isVisible()` stays 0. A download from the fixture must land in a temp downloads directory with no dialog. A notification or geolocation request must be denied with no permission window. `typeText` and `wheel`, the functions `BrowserPicture` calls, must change the page: one character shows up in the contenteditable, and a wheel changes scroll on a page taller than the viewport.

REJECT
