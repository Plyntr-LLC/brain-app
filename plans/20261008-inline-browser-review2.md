The picture click, the stale frame, the two-chat cookie, the pay fence, the real close, the renderer harness, the socket, the Chrome pid list, the WhatsApp text, the packaged spawn, the Codex start, and the 45-second bounds are all in the diff. Two of those items are only partly closed, and one hunk drops checks the new script does not replace.

**Fixed:** 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13.

**Still open:** 7, 14.

**New:** 15, 16.

**7.** Step 14 calls `sessionLoadParams` and says that helper is what every chat `session/load` sends. The script never runs `acpWarm` or `acpResume`. Those two still build their own load params (`acpWarm` has two `session/load` sites, `acpResume` has one), each with `mcpServers: []`. A correct helper left unused still passes. Assert the object those three chat calls pass, for both `grok` and `cursor`, and keep the factory `session/new` and factory `session/load` asserts that step 14 already has (`mcpServers: []`). Steps 14–16 already cover `BROWSER_RULE`, the two Grok sessions on one process, and the Claude baseline server names.

**14.** Steps 6, 7, and the file landing in step 9 cover `window.open`, `isVisible()`, `typeShared`, `wheelShared`, and the temp download. Step 9 still does not require the absence of a dialog or a permission window. "No visible window" sits only on the download clause, and a save panel or a permission window is not a `BrowserWindow` counted in step 7. Around the download and both permission buttons, require `BrowserWindow.getAllWindows()` still 0, every host `isVisible()` false, and `#perm` denied for notification and geolocation.

**15.** This hunk replaces an approved gate:

```diff
-Then `npm run typecheck` and the existing desk tests (`browser`, `shared-browser`, `controller`, `ipc`) still pass with the deleted puppeteer tests removed.
+Then `npm run typecheck` and the desk tests (`browser`, `controller`, `ipc`) pass. Two harnesses that only exercise the deleted puppeteer fake are removed with it and replaced by the checks above: `src/main/desk/shared-browser.test.ts` and `scripts/render-ui/shared-browser.tsx` (plus its stub branch in `scripts/render-ui.ts`).
```

Those files do more than drive the puppeteer fake, and the new scripts do not take those asserts over.

- A click already queued on a chat's own window still runs on that window after that owner opens WhatsApp. It must not land on `wa`. Two owners clicking the shared `wa` window run one at a time.
- Closing while that owner's window is still opening destroys it and never loads the URL. Step 12 calls `closeShared` only. The deleted test invoked the `chat:close` handler. Both the handler and a desk `closeOwner` during open have to destroy the recorded webContents and leave the WhatsApp webContents alive.
- Removing a desk bot destroys `desk:<id>` and leaves `wa` and every other owner's window up.
- `chat:send` of a bare address opens that page for the tab. `hello` and a sentence that only contains a URL do not. The model call carries no picture.
- On the real `BrowserPicture`: a small click only widens that chat; a click in the empty band does nothing; a wide click, key, and wheel hit that chat's window at the mapped point; the desk picture does the same; sign-in renders "Sign in, in the browser." The pure `mapClick` call and `typeShared` / `wheelShared` do not cover that component path.

**16.** This hunk adds `thread/resume` to behavior 5:

```diff
-   - Codex: `thread/start` `config.mcp_servers.brain_browser` if Codex accepts it; otherwise Codex is listed as not wired in the deferred backlog and the reply says so.
+   - Codex: `thread/start` and `thread/resume` `config.mcp_servers.brain_browser` (probe: Codex 0.144.1 accepted it and called the tool with the owner).
```

Step 18 only sends `thread/start`. Assert the object `codexWarm` passes to `thread/resume` includes `brain_browser`, the same config as start. A resume that omits it fails the check.

REJECT
