# In-app browser that the brain's browser control uses

Joe 2026-10-08: the in-thread browser never showed, and a full Chrome window opened half off screen. He wants one browser inside Brain. It shows small in the thread, opens larger inside the app, keeps logins (WhatsApp) across chats and Desk, works for several chats at once, and is the browser the brain uses when it does browser control. No Chrome window.

## Today (0.1.134)

- `shared-browser.ts` launches real Google Chrome through puppeteer on `~/.brain-sessions/desk` and parks its OS windows off screen or minimized (`chrome.ts` `place`, `PARKED`, `MINIMIZED`). That is the half-off-screen Chrome Joe saw, plus a second Chrome in the Dock.
- The thread picture (`ChatPageTurn` + `BrowserPicture`, a jpeg polled every 1.5 s through `browser:face`) starts only when the whole sent message is one web address (`pageAfterSend`, `openSharedPage`).
- Chat CLIs (Claude stream-json, Grok and Cursor ACP, Codex app-server) get no browser tool from Brain. Their browser control is control-chrome / Playwright / `open`, which drive Joe's own Chrome. Nothing connects them to the picture.

Probe (done, `/tmp/bb-probe/main.js`, Electron 37 from this repo): an offscreen `BrowserWindow({ show: false, webPreferences: { offscreen: true, partition: 'persist:…' } })` with a plain Chrome user agent loaded web.whatsapp.com to its "Scan to log in" QR page (not the unsupported-browser page), `capturePage()` returned a 2200x1600 image for a 1100x800 view, and a CDP `Input.dispatchMouseEvent` click on example.com's link navigated. `Emulation.setFocusEmulationEnabled` sent before the first `loadURL` hung; after the load it worked.

## 1. Behavior when done

1. No Google Chrome process is ever started by Brain for browsing. Every page Brain opens is an offscreen `WebContentsView` in a hidden `BaseWindow` inside Brain.app (no Dock icon, no visible window, nothing in Cmd-Tab), on one persistent partition `persist:brain-browser`, plain Chrome user agent. Logins (WhatsApp Web QR, any site) persist across app restarts and are shared by every chat and every Desk bot.
2. Windows are keyed exactly as today (`windowKey`): WhatsApp is one shared window `wa` that no close ever closes; every other address uses the owner's own window (`chat:<tabId>`, `desk:<botId>`, `page`). Several owners browse at the same time; one window still serializes its own steps (existing page lanes and locks in `desk/browser.ts`, unchanged).
3. The picture is 1100x800 CSS pixels at scale 1, so `mapClick` coordinates from the picture land on the same CSS pixel in the page. Clicks, keys, and wheel from the picture reach the page as trusted input (CDP `Input.*`).
4. Links that try to open a new window (`target=_blank`, `window.open`) load in the same offscreen window. No new visible window. Downloads save to Electron's downloads folder (`app.getPath('downloads')`, `~/Downloads` in the app) without a dialog. Permission prompts (notifications, camera, mic, location) are denied.
5. Every chat CLI that Brain starts gets a `brain-browser` MCP server bound to that tab's owner `chat:<tabId>`:
   - Claude: `--mcp-config <json>` (not strict, so Joe's other MCP servers stay), plus `--disallowedTools mcp__control-chrome` so Claude in Brain cannot drive Joe's Chrome.
   - Grok and Cursor ACP: `mcpServers` on chat-lane `session/new` and `session/load`, stdio form `{ name, command, args, env: [{ name, value }] }`.
   - Codex: `thread/start` and `thread/resume` `config.mcp_servers.brain_browser` (probe: Codex 0.144.1 accepted it and called the tool with the owner).
   - Factory and Desk lanes are unchanged (Desk keeps its browse fences, which already use this same shared browser).
6. Tools: `browser_open {url}`, `browser_read {}`, `browser_click {target}`, `browser_type {target, text}`, `browser_key {key}`, `browser_scroll {direction}`, `browser_screenshot {}`, `browser_close {}`. They run on the existing desk engine (`open` / `runStep` / `pressKey` / `picture` / `closeOwner`), so they return the same page text plus numbered controls, the same pay check (a pay or buy control is never clicked by the agent; the tool says the person can click it in the picture), and the same sign-in stop (the tool tells the agent to ask the person to sign in, in the picture in the thread). `browser_key Enter` runs the same pay check on the focused field's form submit button before pressing. Enter in a box that is not in a form (WhatsApp compose) is not fenced; the rules and tool text say sending needs the person's yes.
7. The MCP server is a dependency-free CJS file shipped as `extraResources` `browser-mcp.cjs`, run as `<Brain executable>` with `ELECTRON_RUN_AS_NODE=1` (the pattern the desk sender scripts already use). It reaches Brain over a unix socket in Brain's userData, mode 0600, with a per-run random token passed only in the MCP env. A wrong token or unknown action gets an error and touches nothing.
8. When any tool call opens or moves a page for `chat:<tabId>`, main sends `browser:opened { owner }` to the renderer. That tab's `TerminalWorkspace` puts the existing `ChatPageTurn` under the newest message I sent (sets `pageAt` to that message's `at`, view `small`) unless the picture is already showing there. The bare-address send keeps working. No layout change to `ChatPageTurn`, `BrowserPicture`, or Desk (working preference 13): Hide, Open browser, small/wide stay where they are. Wide polls faster (0.5 s) than small (1.5 s).
9. Chat rules for Claude and Grok (and the MCP tool descriptions for every CLI) say: web pages, including WhatsApp Web, go through the brain-browser tools, which show in this thread; do not open Chrome, control-chrome, Playwright or puppeteer windows, or `open <url>` unless the person asks for their own Chrome; sending a message or anything external still needs the person's yes.
10. The puppeteer Chrome path is deleted (`makeDeskLaunch`, window parking, `macChromePath`, `deskProfileDir`, `puppeteer-core`). The in-page readers (`pageSnapshot`, `pageScroll`, `pageSubmitFor`) and their tests stay and are reused.

Probes already run against the real CLIs with a stub server: Claude (`--mcp-config` plus `--disallowedTools mcp__control-chrome`: control-chrome tools gone, every other server kept), Grok ACP, Cursor ACP, and Codex `thread/start` config all called the tool with the right owner.

Not covered (said in the reply, added to `todo/deferred-backlog.md`): Google-account sign-in may refuse an embedded browser (that is why GitHub login already uses the system browser); a true live `WebContentsView` for wide mode (wide stays a fast-polled picture); a hard block on control-chrome for Grok and Cursor (they get rules and tools, not a deny list); the old Chrome profile's WhatsApp login does not carry over, Joe scans the QR once.

## 2. How this can fail

F1. Picture at device scale 2 while clicks are CSS pixels: every picture click lands at half position.
F2. CDP command before the first load hangs the first open forever.
F3. Offscreen page never paints: empty or blank picture, or a stale frame after navigation.
F4. Two owners opening WhatsApp get two `wa` windows (two sessions fight, QR loops), or a chat's close kills `wa`.
F5. A `target=_blank` link or `window.open` creates a visible Electron window, or nothing happens.
F6. Typing into a contenteditable box (WhatsApp compose) does nothing because `insertText` went to an unfocused element.
F7. MCP owner differs from the renderer's owner, so the agent browses but the thread shows nothing (or another tab's thread shows it).
F8. The `browser:opened` event lands while that tab is not mounted or for a tab with no sent message, and throws or sets a bad `pageAt`.
F9. Packaged app cannot find `browser-mcp.cjs`, or `ELECTRON_RUN_AS_NODE` is fused off, so the tools never appear.
F10. Claude in Brain still has control-chrome tools and uses Joe's Chrome; or `--mcp-config` replaces Joe's other MCP servers.
F11. Grok or Cursor ACP rejects or ignores `mcpServers`, so `session/new` fails (chat broken) or the tools are silently absent.
F12. The socket accepts a call without the token, or from a stale token after restart.
F13. The agent clicks a pay or buy control through `browser_click`.
F14. A tool call that never returns (page hang) hangs the CLI turn forever.
F15. Closing a chat tab leaves its offscreen window and webContents alive (leak).
F16. Some code path still launches Google Chrome (`pgrep -f "Google Chrome.*brain-sessions"` non-empty).
F17. Quitting Brain leaves the socket file, so the next run cannot listen.
F18. The hidden browser windows show up in Brain's `BrowserWindow.getAllWindows()` (16 call sites: Dock reopen, bring-front, quit, broadcasts), so Brain shows, focuses, or messages a web page. Probe: a hidden `BaseWindow` hosting the offscreen `WebContentsView` renders and captures, and is not in `BrowserWindow.getAllWindows()`.
F19. A sign-in ends the desk session and the next tool call fails because the new session has no page yet.
F20. `browser_key Enter` in a form submits it without the pay check that `browser_click` runs.

## 3. End-to-end check (medium case) and its artifact

`scripts/check-in-app-browser.ts`, bundled with esbuild and run under this repo's Electron with a temp userData and `app.setPath('downloads', <temp>)`. It uses the real modules, not fakes: `shared-browser.ts` (`sharedDeskBrowser`, `faceShared`, `clickShared`, `typeShared`, `wheelShared`, `closeShared`, the same functions the IPC handlers call), the in-app launch under it, the bridge, the real `browser-mcp.cjs` spawned as a stdio child from the spec builder the chat code uses, and real CLIs started from the arg and param builders the chat code uses. Every MCP call and every CLI turn has a hard deadline; a step past it fails.

Local http fixture pages: `/form` (heading "Purple Walrus 42"; a `#next` link; a `target=_blank` link; a "Pop window" button that runs `window.open('/next')`; a contenteditable "Message box" whose Enter writes `echo: <text>` into `#echo`; a "Buy now" button whose click writes `purchased` into `#bought`; a "Download file" link to `/file.txt` with `Content-Disposition: attachment`; buttons that request notification and geolocation permission and write the outcome into `#perm`), `/checkout` (a form with a "Card" field whose only submit button is "Buy now" and whose submit handler writes `purchased`), `/next` (heading "Next page"), `/tall` (5000 px tall), `/login` (password field), `/cookie` (prints `document.cookie`), `/hang` (never answers).

1. MCP `chat:A`: `initialize`, `tools/list` has exactly the 8 tools. `browser_open /form` returns "Purple Walrus 42" and numbered controls within 45 s (F2). `browser:opened` was emitted for `chat:A` and no other owner (F7 main side).
2. `faceShared('chat:A')` and `browser_screenshot`: each a jpeg with natural size exactly 1100x800, over 5 KB, more than 3 distinct colours on a pixel grid (F1, F3). Saved as `form.jpg`.
3. Picture click (F1): read `#next`'s CSS centre from the page; scale it into a 550x400 picture box (divide by 2); `mapClick(point, {550,400}, {1100,800})` must return the CSS centre (within 1 px); pass only that return value to `clickShared('chat:A', x, y)`. The URL becomes `/next`. Then both `browser_screenshot` and `faceShared` return a jpeg that is 1100x800, not one colour, and byte-different from `form.jpg` (F3 stale frame). Saved as `next.jpg`.
4. Two chats at once (behavior 2): with `chat:A` on `/form`, `chat:B` opens `/next`. The two owners' windows are different webContents (ids differ) and `browser_read` for each returns its own heading, in parallel calls.
5. Shared and saved logins (behavior 1): in A's window the page sets `document.cookie = "brain=1; max-age=3600; path=/"`; B's `/cookie` read shows `brain=1`. The check quits Electron normally and starts phase two (a second Electron run of the same script, same userData): `/cookie` shows `brain=1` again.
6. Contenteditable (F6): `browser_type` "Message box" "hello from the check", `browser_key Enter`; the read shows `echo: hello from the check`. Then the picture's own input path: `typeShared('chat:A', 'Z')` after clicking the box puts `Z` in it, and on `/tall` `wheelShared('chat:A', 600)` changes `scrollY` (read back from the page).
7. New windows (F5, behavior 4): `browser_click` the `target=_blank` link, then from `/form` the "Pop window" button: each time the same owner window ends on `/next`. Brain's `BrowserWindow.getAllWindows()` count is 0 and every hidden host has `isVisible()` false, before and after (F18).
8. Pay fence (F13): `browser_click "Buy now"` is not clicked: error text says it spends money and the person can click it in the picture; `#bought` does not say `purchased`. On `/checkout`: `browser_type "Card" "4242"` then `browser_key Enter` returns the same refusal and `purchased` is absent.
9. Downloads and permissions (behavior 4): the check listens on the partition's `will-download`. Clicking "Download file" gives an item that reports `done` with state `completed` and a save path of `file.txt` in the temp downloads folder within 10 s, with nobody answering anything (a save panel would hold the item until someone did). The "Ask notifications" and "Ask location" clicks end with `#perm` showing `notif:denied` and `geo:denied1`. Before and after the download and after each permission click, `BrowserWindow.getAllWindows()` is 0 and every hidden host has `isVisible()` false.
10. Sign-in: `browser_open /login` says the page wants a sign-in and to ask the person; the next `browser_open /next` works.
11. WhatsApp (F4): `chat:A` and `chat:B` both `browser_open https://web.whatsapp.com`. The read text is the "Scan to log in" page (not the unsupported-browser page). Hidden host count grows by exactly one and both owners' pictures come from the same webContents. Saved as `whatsapp.jpg`. `browser_close` from `chat:A` leaves that webContents alive.
12. Close (F15): `chat:B` opens `/form`; record its webContents id. MCP `browser_close` destroys exactly that webContents. `chat:C` opens `/form`; `closeShared('chat:C')` (the tab-close path) destroys its webContents. The WhatsApp webContents is still alive after both.
13. Socket (F12, F14, F17): the socket file mode is 0600. Calls with a wrong token and with no token are refused and change nothing. `browser_open /hang` returns an error within 45 s. After `stopBrowserBridge` the socket file is gone; a second start listens again; a call with the first run's token is refused.
14. Builders (behavior 5, 9): `claudeChatArgs(...)` has `--mcp-config` with the owner and `BROWSER_RULE` in `--append-system-prompt`; Grok chat `_meta.rules` from `sessionNewParams` contains `BROWSER_RULE`; factory `sessionNewParams` and factory `sessionLoadParams` still send `mcpServers: []`. The real-process steps below record what the chat functions actually send: the check wraps `LineRpc.prototype.request` to log every method and params object and then passes the call through unchanged.
15. Real Claude (F10): a baseline `claude -p` run with the chat args minus the browser args records the init `mcp_servers` names. Then a run with `claudeChatArgs` for `chat:D`, asked "Use the browser tools to open <base>/form and reply with only the page heading." Init tools contain `mcp__brain-browser__browser_open` and no `mcp__control-chrome__` tool; every baseline server except control-chrome is still listed; the answer contains the heading; the bridge saw `chat:D`. 240 s deadline.
16. Real Grok (F11) through the chat's own functions: `acpWarm` for tabs `E1` and `E2` on one folder (one pool, so one Grok process with two sessions; the pool starts its leader through Brain's own `ensureGrokLeader`), then the chat prompt function on each with the same ask. Each answer has the heading and the bridge saw `chat:E1` and `chat:E2`, each from its own session. The recorded `session/new` params for each carry the server with that tab's owner. The Grok leader runs on its own socket: `grokLeaderSocket()` reads `BRAIN_GROK_LEADER_SOCK` when set and the check sets it, because `makeLeader` unlinks a socket it did not start, and the check must never take over the running Brain's leader.
17. Real Cursor the same way: `acpWarm` for tab `F` and the chat prompt function; answer has the heading; the bridge saw `chat:F`; the recorded `session/new` carries `chat:F`.
17b. Every chat `session/load` (F11, item 7), for both `grok` and `cursor`, using the session ids from steps 16 and 17: `acpWarm({ tabId: 'W1', resumeId })` (a fresh tab that resumes), `acpWarm({ tabId: 'W2' })` then `acpWarm({ tabId: 'W2', resumeId })` (an open tab moved to another session), and `acpResume({ tabId: 'W3', sessionId })`. Each of those three recorded `session/load` calls carries the brain-browser server with `chat:W1`, `chat:W2`, `chat:W3`. Then a prompt on the resumed `W3` tab through the chat prompt function makes the bridge see `chat:W3`.
18. Real Codex (F11, item 16) through the chat's own functions: `codexWarm({ tabId: 'G' })` and the chat Codex prompt function. The recorded `thread/start` params carry `config.mcp_servers.brain_browser` with `chat:G`; the answer has the heading; the bridge saw `chat:G`. Then the pools are dropped (`codexKillAll`) and `codexWarm({ tabId: 'G2', resumeId: <G's thread id> })` on a fresh pool: the recorded `thread/resume` params carry the same config with `chat:G2`, it returns that thread, and a prompt makes the bridge see `chat:G2`. A start or resume that errors fails the check.
19. Chrome (F16): the pids from `pgrep -x "Google Chrome"` (main processes only) recorded at start; no new pid at the end.

Prints `IN_APP_BROWSER_PASS` or the first failing step. Artifact: the trace in `plans/20261008-inline-browser-check.txt`, pictures in `plans/20261008-inline-browser-shots/`.

**Renderer check (F7, F8 renderer side).** New `scripts/render-ui/browser-opened.tsx` for the existing `scripts/render-ui.ts` harness. It mounts two real `ChatPane`s (`chat-a`, `chat-b`; Skin is on, as in the app) with a stub `window.brain` whose `browser.onOpened` keeps the listeners and whose `browser.face` returns a canvas jpeg. Asserts:
- an `onOpened('chat:chat-a')` before any message does not throw and renders no `.page-turn`;
- after sending "check the site" in chat-a, `onOpened('chat:chat-a')` renders exactly one `.page-turn` in chat-a, inside the turn whose user text is "check the site";
- a second `onOpened('chat:chat-a')` leaves that one `.page-turn` where it was;
- `onOpened('chat:chat-b')` changes nothing in chat-a, and chat-b (no message) shows no `.page-turn`;
- after the turn finishes and a second message is sent, `onOpened('chat:chat-a')` moves the one `.page-turn` under the second message;
- after Hide (the note), another `onOpened` for the same turn keeps the note.
Prints RENDER_UI_PASS and saves a screenshot to `plans/20261008-inline-browser-shots/thread.png`.

**Packaged check (F9).** After `pack:mac`, a node script imports the same `bridgeScriptPath({ resourcesPath, appPath })` and `serverSpec({ exec, script, sock, token, owner })` the app uses, with `resourcesPath = dist/mac-arm64/Brain.app/Contents/Resources` and `exec = dist/mac-arm64/Brain.app/Contents/MacOS/Brain`, spawns exactly that command, args and env, and requires `initialize` plus 8 tools.

Then `npm run typecheck` and the desk tests (`browser`, `controller`, `ipc`, `shared-browser`) pass, and `node --experimental-strip-types scripts/render-ui.ts shared-browser` prints RENDER_UI_PASS.

**Ported harnesses (item 15).** `src/main/desk/shared-browser.test.ts` and `scripts/render-ui/shared-browser.tsx` keep running against the real `inapp.ts`, `desk/browser.ts`, `shared-browser.ts`, `browser-ipc.ts`, the real `chat:send` and `chat:close` handlers (`registerStubIpc`; `chat:close` also runs `closeWarm` and `stopPrompt`), the real desk controller's `removeBot`, the preload, and the real `BrowserPicture`, `ChatPane` and `DeskPane`. Only the fake underneath changes: the puppeteer fake is replaced by one Electron-level fake of `BaseWindow`, `WebContentsView`, `session` and `webContents` (`loadURL`, `executeJavaScript`, `capturePage`, `debugger.sendCommand` for `Input.*` and `Emulation.*`), kept in one file both harnesses load (`scripts/fakes/electron-browser.js`). It records the same `pages` (one per webContents, with `windowId` and `_closed`), `entered` (every non-blank `loadURL`), `actions` (`mouse x y <window>`, `type`, `press`, `wheel`), `shotIds`, and the same `holdGoto`, `holdClick` and `holdPrepare` switches.

The hold point for `holdPrepare` is the same moment the old `setViewport` hold was. `inapp.ts` opens a window in this order: create the view (its webContents is in `pages`, URL `about:blank`), `loadURL('about:blank')` and wait for it, attach the debugger, send `Emulation.setFocusEmulationEnabled`, and only after that `pageFor` returns and `goTo` calls `loadURL(target)`. The fake holds the focus call. At that moment the new webContents exists, the blank load has finished (so the call is legal: the probe hung only when it was sent before any load), and the target is not in `entered`. A close at that moment must make `pageFor` destroy the host and return before `goTo` ever calls `loadURL(target)`.

Every assert the old test made stays, with both halves of each:
- Three owners (chat-a, chat-b, desk:writer) open three windows while `holdGoto` holds their loads; `entered` is exactly those three URLs in order; then all three pages show their URL.
- WhatsApp from chat-a, desk:writer and chat-b (`/send?phone=` included) is one window: the live page count grows by exactly one and the other owners' pages keep their URLs.
- `picture('chat:chat-a')` and `picture('desk:writer')` both come from the `wa` window (`shotIds` are that window twice) and equal the fake jpeg.
- The `chat:close` handler for chat-a destroys chat-a's page, leaves the `wa` page alive, and leaves chat-b's page alive.
- `removeBot('writer')` through the real desk controller destroys desk:writer's page and leaves the `wa` page and chat-b's page alive.
- A desk browse holding `desk:writer` does not block `goTo` for chat-c (finishes inside 800 ms), and writer's page keeps its URL and stays open.
- `chat:send` with a bare address opens that page; `hello` and `see https://example.com` change no page; the three warm calls carry exactly the three texts and no `tools`, `browse`, `jpeg`, or image data.
- Preload `clickAt`, `typeText`, `pressKey`, `wheel` for chat-a produce exactly `mouse 300 100 <a>`, `type hi <a>`, `press Enter <a>`, `wheel 40 <a>`, all on chat-a's window.
- A click queued behind a held click on chat-a's window lands on chat-a's window (`mouse 9 8 <a>` present) and not on the `wa` window (`mouse 9 8 <wa>` absent), after chat-a opened WhatsApp in between.
- Two owners' clicks on the `wa` window run one at a time: the second does not enter while the first is held, and each appears exactly once. No `bringToFront`-style call happens (the fake records any `focus` or `show`, and there are none).
- Close while preparing, through the `chat:close` handler for chat-z: the webContents recorded for that open (the new entry in `pages`) ends `_closed`, `entered` did not grow (the target was never loaded), `picture('chat:chat-z')` is null, chat-a's page is still alive, and the `wa` webContents is still alive.
- The same for a desk `closeOwner('desk:late')` while preparing: that recorded webContents ends `_closed`, `entered` did not grow, `picture('desk:late')` is null, and the `wa` webContents is still alive.
- The desk seat argv and `sendWhatsApp().sendable` asserts at the end of the old test stay unchanged.
- Render page: a small click on a chat picture widens only that chat, adds nothing to `actions`, and never calls `browser:showWindow`; a click in the empty band of a wide picture adds nothing to `actions`; a wide click, a key, and a wheel reach that chat's window at the mapped point; the desk picture does the same; Open browser on the desk stays on the picture and does not call `browser:showWindow`; sign-in shows "Sign in, in the browser.".

The puppeteer-only asserts become their in-app versions: one Chrome launch with exact options becomes every view created with `offscreen: true` on `persist:brain-browser`, one partition prepared, and every host created with `show: false`; the clip and viewport asserts become a 1100x800 capture handed back unchanged (no resize) and a 2200x1600 capture resized to exactly 1100x800; the park and minimize bounds become no `show`, `focus`, or `BrowserWindow` call ever made by the browser code.

## 4. Files

- New `src/main/desk/inapp.ts`: Electron offscreen launch returning the existing `DeskLaunch & { windows: DeskWindows }` shape and the `DeskPage` adapter (CDP input, `capturePage` resized to 1100x800).
- `src/main/desk/chrome.ts`, `src/main/desk/chrome.test.ts`: delete the puppeteer launch and window parking; keep the in-page readers; add `pageActiveSubmit`.
- `src/main/shared-browser.ts`: in-app launch; `openedFor(owner)` emitter.
- New `src/main/browser-bridge.ts`: socket server (0600, per-run token, `browser-<pid>.sock`, stale sockets swept), tool calls on the desk engine, `browser:opened` emit, `bridgeScriptPath` and `serverSpec` builders, Claude args, ACP `mcpServers`, Codex config.
- New `src/main/browser-mcp.cjs`: stdio MCP server.
- `src/main/index.ts`: start and stop the bridge.
- `src/main/claude-stream.ts` (`claudeChatArgs`), `src/main/acp-session.ts` (`sessionNewParams` owner argument; new `sessionLoadParams` used by every load call), `src/main/codex-app.ts` (`codexThreadParams` for start and resume): pass the server for chat tabs; browser rule.
- `src/shared/chat-reach.ts`: `BROWSER_RULE`.
- `src/preload/index.ts`, `src/renderer/src/TerminalWorkspace.tsx`: `browser.onOpened`, place the existing picture, wide poll.
- `src/shared/desk.ts`, `src/main/desk/ipc.test.ts`, `src/main/desk/shared-browser.test.ts`: drop puppeteer types and imports.
- `electron-builder.yml`: ship `browser-mcp.cjs`. `package.json`: drop `puppeteer-core`, version 0.1.135.
- `src/main/desk/browser.ts`: `read` and `key` step actions (key runs the pay check on Enter).
- New `scripts/check-in-app-browser.ts` (+ `scripts/in-app-browser/electron-check.ts`, `set-paths.ts`), `scripts/check-packaged-browser-mcp.ts`, `scripts/render-ui/browser-opened.tsx`, `scripts/fakes/electron-browser.js` (the shared Electron-level fake).
- Ported to that fake: `src/main/desk/shared-browser.test.ts`, `scripts/render-ui/shared-browser.tsx`, and the stub branch in `scripts/render-ui.ts`.
- `src/main/grok-args.ts`: `grokLeaderSocket()` honours `BRAIN_GROK_LEADER_SOCK`.
- `GOAL.md` Now line. Agency brain: `context/tools-stack.md` one line, `todo/deferred-backlog.md` deferred items.
