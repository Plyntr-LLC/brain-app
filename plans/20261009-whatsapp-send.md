# Send WhatsApp messages from a Brain chat and from Desk

Joe 2026-10-09: "also we must be able to send messages from brain app here in chat but also in desk chats as well." This follows the WhatsApp accounts plan (`plans/20261009-whatsapp-accounts.md`, main plus named accounts such as `india`, each its own window `wa` / `wa:<name>`).

## Today (after the accounts and sizes work, 0.1.137 in progress)

- Chat: the brain-browser tools never press a control named send, reply, post, publish or submit (`PAY_REFUSE`, `payCheck`). WhatsApp's own Send button is refused. A gap: `browser_key Enter` in WhatsApp's message box is not fenced (the box is not in a form), so an agent can send without anyone's click, held back only by the written rule.
- Desk: a bot's ```` ```sms ```` block with `via: whatsapp` becomes a text tile with `sendable: false` and the note "WhatsApp send from Desk isn't set up. This stays a draft." (`controller.ts` `storeSms`, `WHATSAPP_NOTE`); `DeskCard` hides Send for WhatsApp; `senders.sendWhatsApp()` returns not sendable. iMessage tiles already send when Joe presses Send (`controller.ts` answer path, `senders.sendText`).
- `code/whatsapp/wa.cjs` (agency brain, Playwright on its own Chrome profiles) already sends on real WhatsApp Web: search box, click the chat row whose title matches, type in the footer message box, Enter, then wait until the new outgoing bubble shows sent, delivered or read, never a clock. It refuses to start a new chat. Its selectors are the starting point here.

## 1. Behavior when done

Sending always takes the person's click on a Send button that Brain draws. An agent never sends by itself.

1. One sender in Brain main, `src/main/desk/wa-send.ts`, sends `{ account, to, body }` through the in-app WhatsApp window of that account (`wa` or `wa:<name>`, the accounts plan's keys). It holds that window's page lane for the whole send, so no browser tool step lands on the window in the middle. Steps:
   - Not on web.whatsapp.com: load it. Wait up to 30 s for the chat list or the QR. QR means the account is not linked: not sent, note "WhatsApp <account> is not linked in Brain. Open it and scan the QR first."
   - Search for `to` in WhatsApp's search box (cleared first). Rows are the chat and contact results; a row's name is its first `span[title]`. A row whose name equals `to` (case and spacing ignored) wins. Else exactly one row whose name contains `to` wins. Several: not sent, note names up to five. None: not sent, note "No WhatsApp chat named <to>." It never starts a new chat and never falls back to the top row.
   - Click that row. The open chat's header name must equal the chosen name, else not sent.
   - Click the message box and clear whatever it holds (select all, delete). Enter the body: each line as text, Shift+Enter between lines. Read the box back. It must equal the body (whitespace normalized), else the box is cleared and not sent.
   - Note the `data-id`s of the chat's message rows (`#main [role="row"]`). Press Enter once. Then wait up to 20 s for a row whose `data-id` was not there before, whose text holds the body's first line, and whose status (the row's `aria-label`s, read the way wa.cjs `outgoingState` reads them) is Sent, Delivered or Read. Pending only, no new row, or a row marked not sent: note "WhatsApp did not show it as sent. Check the chat before sending again." That case is never retried by Brain.
   - Sent: `{ ok: true, chat: <name> }`.
2. Chat. A new brain-browser tool `whatsapp_send { to, text, account? }`. `account` follows the accounts plan (left out or `main` is the main WhatsApp; a bad name is an error). Empty `to` or `text`, or text over 4,000 characters, is an error. The tool sends nothing. It puts a Send card in this chat and answers at once: the card is shown, nothing is sent until the person presses Send there, and the card shows what happened.
   - The card sits in the turn of the newest message the person sent, after the browser picture if that turn has one. It shows "WhatsApp (<account>) to <to>", the text, and two buttons: Send and Don't send.
   - Send: the buttons go, the card says "Sending…", then "Sent to <chat name>." or "Not sent: <note>". Don't send: "Not sent." A card is answered at most once. Main keeps each card's state (waiting, sending, sent, not sent) by a random id and owner. The move from waiting to sending happens before anything is awaited, so two answers that arrive together start one send. A second answer, an unknown id, or an answer from another chat is refused.
   - Cards live while Brain runs. A restart drops cards that were never answered.
3. The gap closes. On a WhatsApp window (`wa` or `wa:*`), `browser_key` Enter (any name `keyName` maps to Enter, such as `return`) while the focus is WhatsApp's message box (a contenteditable inside the chat footer) is refused with a reply that says to use `whatsapp_send`. Enter elsewhere on WhatsApp (the search box) still works. The person can still press WhatsApp's own Send in the picture.
4. Desk. The ```` ```sms ```` block takes an optional `account:` line for WhatsApp. A WhatsApp tile is sendable, shows "Account: <account>" when one is named, and has Send like an iMessage tile. Send runs the same sender (1) through the shared browser the controller already holds (`opts.browser.whatsappSend`); `senders.ts` stays free of electron and its `sendWhatsApp` stub is deleted. The tile ends sent, or shows the note and stays not sent. Don't send works as for iMessage. A bad account name makes the tile not sendable with a note. Desk's prompt example names `account:`.
5. `BROWSER_RULE` and the tool text say: to send a WhatsApp message, draft it, then call `whatsapp_send`; the person presses Send on the card. The `whatsapp_send` description says nothing is sent until then.

The alternative is letting an agent send after the person types yes in the chat, with no card. Brain cannot tell a real yes from text a web page or a message slipped in, so this plan keeps the click. Flipping it later is one switch in the bridge.

Not in this plan (to `todo/deferred-backlog.md`): telling the agent the card's result in a later tool reply; sending files or pictures; starting a new chat with a phone number; WhatsApp sending from the Grok Bot.

## 2. How this can fail

F1. A message goes out without the person's Send click: from `whatsapp_send` itself, from `browser_key Enter` in the message box, or from a card answered twice.
F2. It goes to the wrong person: a partial-name match picks one of several, the top row is used as a fallback, or the header was not checked.
F3. It goes from the wrong number: the account's window is not the one the card names.
F4. Multi-line text sends as several messages, or is cut, because Enter was typed for a newline.
F5. "Sent" is reported when WhatsApp still shows a clock or nothing, or Brain retries and sends twice.
F6. A browser tool step (click, type) lands on the WhatsApp window in the middle of a send and changes what is typed or where.
F7. An account that is not linked hangs, or reports sent.
F8. A card shows in the wrong chat tab, or a Desk tile's Send stays hidden for WhatsApp, or Don't send sends.
F9. Stale or forged answers: an unknown id, another chat's id, or a second answer starts a send.
F10. Typing fails (the box did not take the text) and Enter sends a partial message.

## 3. End-to-end check (medium case) and its artifact

New `scripts/check-whatsapp-send.ts` bundles new `scripts/in-app-browser/send-check.ts` and runs it under this repo's Electron on a temp userData, like the accounts check. Real modules: `shared-browser.ts`, `desk/inapp.ts`, `desk/browser.ts`, `wa-send.ts`, `browser-bridge.ts` with the real `browser-mcp.cjs` over stdio, the real Desk `fences.ts`, `controller.ts` and `senders.ts`. The check passes the bridge an `onSendAsk` that records what main would send to the window, and answers through the same `answerSend` the IPC handler calls.

Stand-in WhatsApp, served for `web.whatsapp.com` on every partition through `protocol.handle` (as in the accounts check). It copies the structure wa.cjs reads: `#pane-side` with `[role="row"]` rows whose first `span[title]` is the name, a search box `input[aria-label="Search or start a new chat"]` that keeps every row whose name contains the query, in the contact order below, a chat pane `#main` with `header span[title]`, message rows `#main [role="row"]` each holding a `[data-id]`, and a footer `div[contenteditable="true"][data-tab="10"]` where Shift+Enter adds a line and Enter posts a new outgoing row whose status `aria-label` is " Pending " and becomes " Sent " after 300 ms. It also shows a Send button beside the box. Every posted message is appended to `localStorage.sent` as `{ chat, text }`, so the check reads exactly what went out, where, and how many times. An unlinked partition (no `localStorage.linked`) shows the QR canvas instead. Main and india are linked by the check first; `work` is not.

Contacts and what each one does, in list order:
- Raj Patel: normal. Its box starts holding "old draft".
- Pat: normal. "Pat" is also inside "Raj Patel", and a search for "Pat" lists Raj Patel first, Pat second.
- Sam Lee, Sam Ortiz: normal.
- Decoy: clicking its row opens a chat whose header says "Someone Else".
- Slowpoke: the new row stays " Pending ".
- Echo: already has an outgoing row " Sent " with the text "Echo test"; a new row stays " Pending ".
- Ghost: Enter posts nothing and adds no row.
- Reader: the new row goes " Pending " then " Read " (never " Sent ").
- Sticky: whatever is typed becomes "stuck text" in the box; select all and delete empties it; Enter posts what the box holds.

1. `tools/list` has `whatsapp_send` with `to`, `text`, `account`, and its description says nothing is sent until the person presses Send. `BROWSER_RULE` says to draft the message and call `whatsapp_send`.
2. `whatsapp_send { to: 'Raj', text: 'Hello Raj\nSecond line', account: 'india' }` returns at once and says a card is shown. `onSendAsk` got one ask with owner `chat:A`, account `india`, the to and the text. Both stand-ins' `sent` are still empty (F1).
3. Two `answerSend(id, true, 'chat:A')` calls started together, the second before the first returns: one result is sent to `Raj Patel`, the other is refused. India's `sent` is exactly `[{ chat: 'Raj Patel', text: 'Hello Raj\nSecond line' }]`: one row with two lines (F4), and without "old draft" (F10). Main's `sent` is empty (F3, F1, F9).
4. A later `answerSend` of that id (yes or no), an unknown id, and that id answered from `chat:B` are each refused; india's `sent` still has one entry (F1, F9).
5. A new ask answered no: nothing sent; a later yes on it is refused (F8, F9).
6. To `Sam` (Sam Lee and Sam Ortiz): not sent, the note names both, `sent` unchanged. To `Nobody`: not sent, "No WhatsApp chat named Nobody.", `sent` unchanged. To `sam lee`: one row posted to Sam Lee only. To `Pat`: the check first reads the search results for "Pat" in the window and requires Raj Patel above Pat; then one row is posted to Pat only and nothing to Raj Patel, so a sender that clicks the first row containing the name fails here. To `Decoy`: not sent, `sent` unchanged (the header check) (F2).
7. Account `work`: not sent within 35 s, the note says it is not linked; nothing in any `sent` (F7). Account `../x`: `whatsapp_send` is an error, no card, every `sent` unchanged. One send with the account left out and one with `main`: each posts only to main's `sent`, india's unchanged (F3).
8. Confirmation (F5): Slowpoke is not sent within 25 s with the "did not show it as sent" note and exactly one posted row (no retry). Echo with the text "Echo test" is not sent and has exactly one new posted row (the older Sent row does not count). Ghost is not sent and its `sent` is empty. Reader is sent, with one posted row.
9. A send to Raj and, started 100 ms later from `chat:B`, `browser_type` into the india window's message box: the `browser_type` returns only after the send's result, and Raj's sent text is exactly the card's text (F6).
10. `chat:A` opens india, clicks Raj's row, `browser_type` "x" into the message box, then `browser_key Enter`, then `browser_key return`: both refused, each reply names `whatsapp_send`, `sent` unchanged. `browser_click "Send"`: refused, `sent` unchanged. `browser_key Enter` in the search box (after typing "Sam") is not refused (F1).
11. To Sticky: not sent, nothing posted, and the box is empty afterward (F10).
12. Desk: the real `parseTurn` on a bot turn with ```` ```sms ```` `to: Raj Patel` / `via: whatsapp` / `account: india` gives a block with account `india`. The real controller stores a tile with `via: 'WhatsApp'`, `account: 'india'`, `sendable: true`. Answering yes through the real controller (built with the real `sharedDeskBrowser()`, as `openDeskController` does) posts exactly one row to Raj Patel in india's `sent`, its text equal to the block's body, and the tile ends `sent: 'yes'`. A second tile answered no posts nothing and ends `sent: 'no'`. A tile with `account: ../x` is not sendable, has a note, and answering yes on it posts nothing (F8, F3).

Prints `WHATSAPP_SEND_PASS` or the first failing step. Artifact: `plans/20261009-whatsapp-send-check.txt`.

Renderer: new `scripts/render-ui/whatsapp-send.tsx` with two real `ChatPane`s and a stub `window.brain` (`browser.onSendAsk` keeps listeners, `browser.sendAnswer` records calls and resolves after 300 ms). An ask for `chat:a` after "send it to Raj" shows one card in that turn with the account, to, text, Send and Don't send; `chat:b` shows none. Send calls `sendAnswer(id, true)` once, the card shows "Sending…" then "Sent to Raj Patel.", and no buttons remain. A second card whose answer resolves `{ ok: false, note: 'No WhatsApp chat named Nobody.' }` shows "Not sent: No WhatsApp chat named Nobody." with no buttons. A third card's Don't send calls `sendAnswer(id, false)` once and shows "Not sent." with no buttons. With the page picture in the same turn, the card sits after it. The Desk page (the real `DeskPane` with a stub view holding a WhatsApp text tile, `account: 'india'`, `sendable: true`) shows "Account: india" and an enabled Send; clicking Send calls the tile answer with yes, and on a second tile Not now calls it with no (F8).

Real WhatsApp (needs Joe's yes, asked in chat before it runs): with his main WhatsApp linked in Brain, one `whatsapp_send` to his own "Message yourself" chat with the text "Brain send test", and Joe presses Send on the card. The chat shows the message with a sent tick; a screenshot is saved. If Joe says no, the reply says real WhatsApp sending is unproven.

Then `npm run typecheck`, the desk tests, `check-whatsapp-accounts.ts`, and the render checks `browser-sizes`, `browser-live`, `browser-opened`, `shared-browser` still pass.

## 4. Files

- New `src/main/desk/wa-send.ts`: the sender over the page interface (load, search, open, type, Enter, confirm).
- `src/main/desk/inapp.ts`: a page `run` for in-page reads the sender uses, and Shift+Enter through the existing key input.
- `src/main/desk/chrome.ts`: the in-page readers the sender uses, and the message-box test for the Enter refusal.
- `src/main/desk/browser.ts`: `whatsappSend` holding the account's lane; the Enter refusal on WhatsApp windows.
- `src/shared/desk.ts`: `DeskBrowser.whatsappSend`, the result type, `textMsg.account`.
- `src/main/browser-bridge.ts`: `whatsapp_send`, card state by id and owner, `answerSend`, `onSendAsk`.
- `src/main/browser-mcp.cjs`: the tool. `src/shared/chat-reach.ts`: `BROWSER_RULE`.
- `src/main/index.ts`: `browser:sendAsk` to the window, `browser:sendAnswer` handler. `src/preload/index.ts`: `browser.onSendAsk`, `browser.sendAnswer`.
- `src/renderer/src/TerminalWorkspace.tsx`, new `src/renderer/src/WhatsAppSendCard.tsx`, `src/renderer/src/skin/SkinPane.tsx` (a per-turn slot), `src/renderer/src/styles/shell.css`.
- Desk: `src/main/desk/fences.ts` (`account`), `controller.ts` (sendable tile, answer path through `browser.whatsappSend`), `senders.ts` (delete the `sendWhatsApp` stub), `runner.ts` (prompt example), `src/renderer/src/DeskCard.tsx` (Send, Account line).
- New `scripts/check-whatsapp-send.ts`, `scripts/in-app-browser/send-check.ts`, `scripts/render-ui/whatsapp-send.tsx`.
- `GOAL.md` Now line; agency brain `todo/deferred-backlog.md`.
