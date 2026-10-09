# Delete obsolete tests, cut marginal ones down, revive the useful dead ones

Joe 2026-10-09: "if there are obsolete ones get rid of them. if there are marginally unhelpful ones delete them or reduce them to what is useful."

## What the audit found (2026-10-09, every unit file and render page run; all below also fail or exist on `6293c1c`)

- Can't load under `node --test --experimental-strip-types`: `src/main/ads2ai.test.ts`, `src/main/project-hooks.test.ts`, `src/main/sync-attention.test.ts` (extensionless imports; project-hooks also reaches a TypeScript parameter property, which strip-only mode rejects).
- Stale: `factory/conductor.test.ts` pins `const railActivity = railFor(tab, lastChatId, activityByTab)` (now `deskOn ? null : railFor(...)`); `render-ui chat-look` expects `.me` before each reply avatar (now `.skin-user-turn`); `render-ui desk` step 8's fake `window.brain.browser` lacks `watch`, `onFrame`, `pointer`, `key` (since 0.1.136); `scripts/check-shell-switch.ts` cannot load (its electron stub lacks `BaseWindow`, `WebContentsView`, `session.fromPartition`, since 0.1.135) and, with those added, misses only two source pins: the `auth:logout` body (now also signs out of GitHub; the behavioral logout steps H2, g1, s14 pass) and "title label" (moved to TitleBar).
- Marginal: 21 unit tests read app source as text and match it. Most pin wording or code shape and break on any refactor without catching a behavior bug. A few are the only cheap guard of a real safety rule.

## 1. Behavior when done

Delete (whole test, pure source-shape pin or unloadable with no cheap way back):
2. `src/renderer/src/TitleBar.test.ts` (whole file: one pin that FirstRun uses `<TitleBar>`).
3. `desk/browser.test.ts`: "browser.ts uses payCheck from the shared file and does not split words itself" (the pay fence behavior has its own tests in that file).
4. `desk/welcome.test.ts`: "welcome spawns nothing: no ai-cli, no child_process".
6. `claude-thought.test.ts`: "Claude reads thinking itself and asText does not".
7. `grok-leader.test.ts`: "Cursor picker keeps live Grok models instead of stripping grok-*".
8. `agent-label.test.ts`: "the skin pulse is not wrapped in if (busy)", with its source-scanning helper and fixtures if nothing else uses them.
9. `phone-lib.test.ts`: "phone Now routes through sendTextRef and sendText reads busyRef".
10. `phone-lib.test.ts`: "a queued paste shows its folded line on the phone and edits as the full text".
12. `setup-folder.test.ts`: "setup:install accepts Agency Brain id".

Reduce (keep the behavior asserts and the safety guards, drop the shape pins):
13. `desk/runner.test.ts` "the runner returns the child's text as printed...": keep the run and its two asserts; drop the import scan.
14. `plyntr-move.test.ts`: drop the one `brain-sync.ts` source match; the parse and credential asserts stay.
15. `plyntr-transfer.test.ts` "settings and the transfer call use the owner-seat gate": keep that the transfer uses the owner token (`transferUsesOwnerToken(`, `token: gate.token`) and the session role (`plyntrSessionRole(`); drop the two SettingsPanel text pins.
16. `phone-lib.test.ts` "phone server binds loopback only and does not log the token": keep only the security asserts: listens on `127.0.0.1`, no `0.0.0.0`, no `console.log/info/debug`, no token minted on start (`saveToken(mintToken())` absent), no token in a URL query (`/?t=` absent), no secret copied to the clipboard, the Settings text has no "Copy secret link" and no hard-coded email. Drop the ~35 "the file contains function X" pins.
17. `phone-lib.test.ts` "explorer lists files outside the watched brain folder": keep the `outsideProject(...)` behavior asserts; drop the AwayBlock, FirstRun and TitleBar text pins.
18. `phone-lib.test.ts` "Restart to install flushes chats then quitAndInstall": keep the four asserts that the install handler sets `installing`, quits through `app.quit()` (so chats are saved) and never calls `quitAndInstall` itself, and that quit finishes the install; this is the only guard against losing chats on update.
19. `setup-folder.test.ts` "Path B install URL pins org and repo on /permissions": keep every `plyntrBrainSyncInstallUrl` and `plyntrInstallPin` behavior assert; drop the `ipc-stubs.ts` text pins.
20. `factory/conductor.test.ts` "plan, strict, and build wording, and the T3 limit stays": drop the 11 asserts on FactoryPane.tsx and TerminalWorkspace.tsx text (including the stale `railActivity` one); the 20 behavior asserts stay.
21. `factory/conductor.test.ts` "the Tester runs the repo's own tsc...": drop the two `runBin(...)` text pins; keep the run's asserts and the "no npx" guard (npx can download and run packages).
21b. `desk/ipc.test.ts` "the live wiring uses the one shared in-app browser and the dry-run env" (review r1 #2): keep the asserts that Desk passes the dry-run flag (`process.env.BRAIN_APP_DRY_RUN === '1'`) and takes its write role through `roleForBrainWrite`, `roleForKeylessWrite` and `brainIdForFolder`; drop the `makeInAppLaunch`, `sharedDeskBrowser` and puppeteer pins (one shared browser is tested by `shared-browser.test.ts` and `check-in-app-browser.ts`).
21c. `setup-folder.test.ts` "setup lists Agency Brain and still reaches ready without it" (review r1 #3): keep the asserts that dry-run setup never clones (`clone skipped in dry-run` in `ipc-stubs.ts`), that a clone passes the token through the credential helper (`credential.helper=` and `x-access-token:${t}@` in `clone.ts`), and that setup switches to the cloned folder (`switchBrain(cloned.dest)`); drop the Agency Brain label, cloudflared and sync-status pins.

Keep unchanged (cheap, only guard of a safety rule): `cli-auth.test.ts` "cliSignedIn grok is existsSync on ~/.grok/auth.json, never a file read".

Revive:
22. New `src/main/test-resolve.ts`, imported only by tests: a `registerHooks` resolve hook that maps an extensionless relative import to its `.ts` file and serves a small electron stub (`app`, `BrowserWindow`, `ipcMain`, `shell`, `safeStorage`), the same approach `desk/shared-browser.test.ts` already uses, and a load hook that compiles the repo's `.ts` files with esbuild (as `check-shell-switch.ts` already does), because `line-rpc.ts` uses a parameter property that type stripping cannot run. `ads2ai.test.ts`, `sync-attention.test.ts` and `project-hooks.test.ts` (review r1 #1: revived, not deleted; its three tests cover `wrapPromptWithHooks` leaving slash commands unwrapped on every send, `extraFromStdout`, and `toolCaptureFromUpdate`) import it first and load the module under test with a dynamic import. No app source changes.
23. `render-ui chat-look`: the avatar check looks for `.skin-user-turn` before each reply row, with the same counts.
24. `render-ui desk`: the fake `window.brain.browser` gains `watch`, `onFrame`, `pointer`, `key` (recording calls like the rest); no step 8 assert is weakened.
25. `scripts/check-shell-switch.ts`: the electron stub gains `BaseWindow`, `WebContentsView` and `session.fromPartition`; the `auth:logout` body pin and the "title label" pin are deleted. Its other source checks (write guards through one role function, no token in preload or `plyntr:resolve`, no test hooks in the vault) stay.

## 2. How this can fail

F1. A deletion or reduction removes the only guard of a real safety rule: the phone server loopback-only and not logging its token, the transfer using the owner token, never reading `~/.grok/auth.json`, the Tester never using npx, a diverged sync's discard never pushing, the dry-run setup never fetching.
F2. A reduced test still runs but checks nothing (no asserts left, or only `assert.ok(true)`).
F3. The test hook leaks into app code or the build.
F4. A revived test passes because the hook stubs away the code under test.
F5. Step 8 or chat-look passes because an assert was weakened, not because the fake or selector was fixed.
F6. `npm run typecheck` breaks (top-level await, dynamic import types in tests).
F7. A deleted test was the only coverage of a behavior that does break (not a shape).

## 3. End-to-end check (medium case) and its artifact

`plans/20261009-test-cleanup-check.txt` records:
1. Before and after counts per file of tests and asserts, from a script that parses every `*.test.*` file (not by hand), and the exact list of deleted test names.
2. `node --test --experimental-strip-types` on all unit files: every file passes (was 92 of 96).
3. All 15 render pages: RENDER_UI_PASS (desk 149 and chat-look 32 included).
4. `check-shell-switch.ts`: exits 0 and prints its pass line.
5. Revived tests catch real bugs (F4), each on a scratch copy of the repo, not the working tree: in `brain-sync.ts` make the diverged discard push, and `sync-attention.test.ts` fails; in `ads2ai.ts` make the dry-run path call `fetch`, and `ads2ai.test.ts` fails. Restored, both pass.
6. Kept safety guards still bite (F1), same scratch method, one change at a time, each making its kept test fail: add `console.log(token)` to `phone.ts`; a `listen(port, '0.0.0.0')`; an `npx` command string in the Tester code; a `readFileSync` of the grok auth file in `cli-auth.ts`; change `token: gate.token` in `plyntr-sync.ts` to another token (item 15); call `quitAndInstall` directly in the install handler in `update.ts` (item 18); drop the dry-run flag in `desk/ipc.ts` and hard-code the Desk write role (item 21b); remove the dry-run clone skip in `ipc-stubs.ts` (item 21c); wrap slash commands in `wrapPromptWithHooks` (revived `project-hooks.test.ts`).
7. `git grep -n "test-resolve"` lists only test files (F3). `npm run typecheck` is clean (F6).
8. For every deleted test (items 2, 3, 4, 6, 7, 8, 9, 10, 12), the artifact names each assert it held that is not about wording or code shape, and the remaining test or check that covers that behavior, or states that it held none (F7, review r1 #5).

## 4. Files

The 21 test files above (13 unit test files edited or deleted), new `src/main/test-resolve.ts`, `scripts/render-ui/chat-look.tsx`, `scripts/render-ui/desk.tsx`, `scripts/check-shell-switch.ts`. Agency brain `todo/deferred-backlog.md`: check off `brain-app-stale-tests`, `brain-app-render-desk-step8`, `brain-app-shell-switch-title-label`.
