# More than one WhatsApp in Brain's browser

Joe 2026-10-09: "We need to be able to link more than one WhatsApp. Even when a WhatsApp is linked I need to be able to use the browser without losing the WhatsApp logins." He linked his personal (US) number today in the 0.1.136 browser. He wants his India number linked too.

## Today (0.1.136)

- Every page Brain opens is an offscreen view on one saved partition, `persist:brain-browser` (`src/main/desk/inapp.ts` `BROWSER_PARTITION`, `browserSession()` memoizes that one prepared session).
- `windowKey(owner, url)` (`src/shared/page-picture.ts`) sends every web.whatsapp.com address to one window, key `wa`. Every other address uses the owner's window (`chat:<tab>`, `desk:<bot>`, `page`).
- WhatsApp Web keeps one account per browser store. Scanning a second number into `persist:brain-browser` would replace the first. So a second number needs its own store.
- `showing` (owner → window key) in `src/main/desk/browser.ts` decides which window later read, click, type, key, scroll, picture and watch steps use.

Probe (done, `/tmp/wa-probe/main.cjs`, this repo's Electron 37.10.3): `app.on('session-created')` fires for a partition created later; `ses.protocol.handle('https')` on it serves a stand-in page for `https://web.whatsapp.com/`; the window's `webContents.session === session.fromPartition('persist:brain-wa-india')`; its `storagePath` and the only folder under `userData/Partitions` is `brain-wa-india`.

## 1. Behavior when done

1. `browser_open` takes an optional `account` string. It applies only to a web.whatsapp.com address.
   - No account, an empty one, or `main`: the existing WhatsApp window `wa` on `persist:brain-browser`. That is the number Joe already linked, so he does not scan it again.
   - Any other name: trimmed, lowercased, spaces become dashes. It must then match `^[a-z0-9][a-z0-9-]{0,31}$`, else the tool returns an error and opens nothing. That account gets its own window, key `wa:<name>`, on its own saved partition `persist:brain-wa-<name>`. A new name shows that number's QR. "India", " india " and "INDIA" are one account.
   - An `account` with any other address is an error. Nothing opens, and the chat keeps showing what it showed.
2. Opening an account sets the chat's `showing` to that account's window, so the next read, click, type, key, scroll, screenshot, picture and live frames all act on that account. Every place in `desk/browser.ts` that derives a window key from an address takes the account: the lane key in `runStep`, `stepAdapter`, and `clickApproved`. An approved click on a WhatsApp address keeps the account of the WhatsApp window that owner is showing, so it lands where the hold was raised.
3. Two chats that open the same account share one window, the same as `wa` today.
4. Every WhatsApp window of every account is never closed by `browser_close`, a chat tab closing, or a Desk bot being removed. One predicate, `isWhatsAppKey(key)` (`wa` or `wa:*`), guards `inapp.ts` `close` and `browser.ts` `closeOwner`.
5. Every other address keeps using `persist:brain-browser`, so site logins stay shared across chats and Desk bots, and browsing other sites never runs inside a WhatsApp account's store. Restarting Brain keeps every account's login.
6. Each account's partition gets the same setup as the shared one, prepared once per partition: Chrome user agent, every permission denied except the two allowed today, downloads saved to Downloads with no dialog.
7. When the opened address is WhatsApp, the tool's reply (the page, or the sign-in reply when WhatsApp shows its QR) adds one line naming the account on screen and every account on this computer: `main` plus one per `userData/Partitions/brain-wa-*` folder.
8. The `browser_open` description, its `account` schema text, and `BROWSER_RULE` say how to pick an account: leave it out for the main WhatsApp, name the number (for example `india`) for another, and a new name shows a QR to link it. `browser_close` text says WhatsApp windows stay open.
9. Bare-address sends in a chat and Desk bots are unchanged (main account).

The alternative is every account on its own partition, including the first. That would be cleaner, but Joe would scan his personal number again, because Electron cannot move a partition's storage. This plan keeps the first account where it is. Flipping this later costs one rescan.

Not in this plan (goes to `todo/deferred-backlog.md`): forgetting or removing an account (deleting its partition); renaming `main`; a link clicked inside WhatsApp still loads in that WhatsApp window, as today (the login is kept, and opening web.whatsapp.com again brings WhatsApp back).

## 2. How this can fail

F1. Name normalization lets one number become two stores ("India" and "india"), or a name like `../x` or `a/b` reaches the partition name.
F2. A named account opens on `persist:brain-browser` (the scan replaces main's login) or main opens on a named partition (Joe has to rescan).
F3. `account` with a non-WhatsApp address opens that site inside a WhatsApp store, or silently ignores the account.
F4. After opening `india`, read, click or type act on main's window or the chat's own window.
F5. The lane key and the window key differ for an account, so two steps on the `india` window run at once, or a step waits on the wrong lane.
F6. An approved click (`clickApproved`) re-derives the key from the address alone and lands on main's window.
F7. A close (`browser_close`, tab close, `removeBot`) destroys `wa:india`.
F8. The account partition is not prepared: Electron's default user agent gets WhatsApp's unsupported-browser page, a permission prompt is allowed, or a download opens a save dialog.
F9. Two chats opening `india` get two windows that fight over one session.
F10. The account list is wrong: `india` missing after a restart, `brain-browser` listed, or a refused name listed.
F11. A restart loses a named account's storage.
F12. Agents never pass `account` because the tool text and rule do not mention it.

## 3. End-to-end check (medium case) and its artifact

New `scripts/check-whatsapp-accounts.ts` bundles new `scripts/in-app-browser/accounts-check.ts` and runs it twice under this repo's Electron on one temp userData, the same way `check-in-app-browser.ts` does. It uses the real `shared-browser.ts`, `desk/inapp.ts`, `desk/browser.ts`, `browser-bridge.ts`, and the real `browser-mcp.cjs` spawned over stdio from `serverSpec`, so every step goes through the same MCP calls a chat makes. Hard deadline on every call.

Stand-in WhatsApp: before any window opens, the check adds `app.on('session-created', ses => ses.protocol.handle('https', ...))`. For host `web.whatsapp.com` it serves a page titled "WhatsApp" that shows `Linked as: <localStorage.linked or nobody>`, a field "Link name", a button "Link" that saves the field into `localStorage.linked`, a "Ask notifications" button writing the outcome into the page, and a "Download file" link to `https://web.whatsapp.com/file.txt` with `Content-Disposition: attachment`. Any other https host is passed through. Plain http fixtures on 127.0.0.1 serve `/form` (sets cookie `brain=1`, has a "Next page" link) and `/cookie`.

Assertions compare against literal partition strings and literal folder names, never the code's own partition function.

Phase 1:
1. MCP `chat:A`: `tools/list` shows `browser_open` with an `account` property. `browser_open https://web.whatsapp.com/` returns `Linked as: nobody` and an accounts line naming `main`. That window's `webContents.session === session.fromPartition('persist:brain-browser')`. `browser_type "Link name" "personal"`, `browser_click "Link"`, then the read shows `Linked as: personal`.
1b. (review 1) `browser_open https://web.whatsapp.com/` with account `"main"`, then `"MAIN"`, then `" main "`: each is the same webContents id as step 1's window, its session is `session.fromPartition('persist:brain-browser')`, the read shows `Linked as: personal`, and `userData/Partitions/brain-wa-main` does not exist.
1c. (review 3) The `browser_open` description and its `account` schema text, and `BROWSER_RULE`, each say: leave the account out for the main number, pass a name such as `india` for another, and a new name shows a QR. `browser_close`'s description says WhatsApp windows stay open. The stand-in serves a sign-in variant at `https://web.whatsapp.com/?qr=1` (a visible `canvas` with `aria-label="Scan this QR code to link a device"`, which `asksSignIn` treats as a sign-in): `browser_open` of it returns the sign-in reply, and that reply still carries the accounts line naming the account on screen.
2. `browser_open https://web.whatsapp.com/` with account `" India "`: `Linked as: nobody` (F2). That window's session is `session.fromPartition('persist:brain-wa-india')`, and `userData/Partitions/brain-wa-india` exists. Link it as `india`. `browser_read` shows `Linked as: india` (F4). The accounts line says `india` is on screen and lists `main, india`.
3. Without touching the india window, read main's window `localStorage.linked` directly through its webContents: still `personal`.
4. `browser_open https://web.whatsapp.com/` with no account: `Linked as: personal`. Exactly two live WhatsApp windows exist (F2, F9).
4b. (review 5) `browser_open https://web.whatsapp.com/send?phone=15551212` with account `india` lands in the same india webContents. The same address with no account lands in main's webContents, on `persist:brain-browser`.
5. MCP `chat:B` opens account `INDIA`: same webContents id as chat A's india window, `Linked as: india` (F1, F9).
5b. (review 2, F5) The check takes the page-lane turn for the literal key `wa:india` through `startPageTurn` from `src/main/desk/page-lane.ts` (the module the engine uses, one bundle) and holds it. While held: `chat:B`'s `browser_open` of account `india` does not return and the india webContents gets no new `did-start-navigation`; `chat:C`'s `browser_open` of the main WhatsApp returns inside 10 s. After the hold is released, `chat:B`'s open returns `Linked as: india`.
6. Account `../x` and account `a/b`: both errors, no new window, no new folder under `Partitions` (F1). `browser_open <base>/form` with account `india`: error, nothing opened, `chat:A`'s next `browser_read` still shows the WhatsApp page it showed (F3).
7. India's partition is prepared (F8): in the india window `navigator.userAgent` has `Chrome/` and no `Electron`; "Ask notifications" ends `denied`; "Download file" completes into the temp downloads folder with no dialog within 10 s, seen on that partition's `will-download`.
8. General browsing (behavior 5): `chat:A` opens `<base>/form` and clicks "Next page" (URL becomes `/next`). Its window's session is `persist:brain-browser`. `chat:B` opens `<base>/cookie` and sees `brain=1`. Main's `localStorage.linked` is still `personal`, india's still `india`, and both WhatsApp windows are still on `https://web.whatsapp.com/`.
8b. (review 4, behavior 9) `chat:A` opens account `india` again, then the bare-address path `openSharedPage('<base>/form', 'chat:A')` runs: that page's session is `persist:brain-browser`, and both WhatsApp webContents are still on `https://web.whatsapp.com/`. Then `openSharedPage('https://web.whatsapp.com/', 'chat:A')`: `faceShared('chat:A')` comes from main's webContents, main's page reads `Linked as: personal`, and india's `localStorage.linked` is still `india`.
9. Approved click (F6): `chat:A` shows the india window. `browser_click "Buy now"` (a stand-in button the pay check holds) is refused. Then `sharedDeskBrowser().clickApproved('Buy now', 'https://web.whatsapp.com/', 'chat:A')`, the function the approve path calls, clicks it. India's page shows `bought`. Main's page does not.
10. Closes (F7): `browser_close` from `chat:A` and `chat:B`, `closeShared('chat:A')`, and `closeOwner('desk:x')` after `desk:x` opened account `india`. Both WhatsApp webContents are still alive.
11. Quit normally.

Phase 2 (same userData, fresh Electron):
12. `browser_open` main shows `Linked as: personal`. Account `india` shows `Linked as: india` (F11). The accounts line lists exactly `main, india` (F10). `/cookie` still shows `brain=1`.

Prints `WHATSAPP_ACCOUNTS_PASS` or the first failing step. Artifact: trace `plans/20261009-whatsapp-accounts-check.txt`.

Real WhatsApp, packed app (F8 against the real site): the existing sandboxed live-app pattern (`check-live-app.ts`, temp HOME and userData) opens real `https://web.whatsapp.com/` once with no account and once with account `india`. Both must reach the "Scan to log in" page, not the unsupported-browser page, with different `storagePath`s. Screenshots `plans/20261009-whatsapp-accounts-shots/main.jpg` and `india.jpg`.

Then `npm run typecheck`, the desk tests (`browser`, `controller`, `ipc`, `shared-browser`), and `check-in-app-browser.ts` phase 1 steps that cover `wa` (step 11, 12) still pass.

## 4. Files

- `src/shared/page-picture.ts`: `whatsappAccount(raw)` (normalize or refuse), `isWhatsAppKey`, `windowKey(owner, url, account?)`.
- `src/shared/desk.ts`: the url step carries `account?`.
- `src/main/desk/inapp.ts`: partition per key, session prepared once per partition, `isWhatsAppKey` close guard, `whatsappAccounts()` from the `Partitions` folder.
- `src/main/desk/browser.ts`: account in `runStep`'s lane key and `stepAdapter`; `clickApproved` keeps the shown WhatsApp account; `closeOwner` guard.
- `src/main/browser-bridge.ts`: `browser_open` account, refusals, accounts line, close text.
- `src/main/browser-mcp.cjs`: `account` in the schema, descriptions.
- `src/shared/chat-reach.ts`: `BROWSER_RULE`.
- `scripts/fakes/electron-browser.js` only if the shared fake needs the partition per view.
- New `scripts/check-whatsapp-accounts.ts`, `scripts/in-app-browser/accounts-check.ts`.
- `package.json` version 0.1.137 (shared with the sizes plan). `GOAL.md` Now line. Agency brain `todo/deferred-backlog.md`.
