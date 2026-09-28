# Factory: stay on the named repo, do not die on an unrelated test

Joe 2026-09-28 on packed **0.1.86**. Live run `run-e50ebcf3-29d` (userData). Task: Plyntr email / mail-desk UI. Evidence, not guesses:

- 10:27 Start (still 0.1.84 in memory): Work repo **gutter-iq-quote-deploy** (profile `0c60ceef`). LastRepo steal.
- 10:27 Guide: "this is not gutter iq this is the mail desk for plyntr".
- 12:31 app swap to 0.1.86; run restored.
- 12:31 Guide: "why are we now showing the work repo as mykennel. we are working on the email system for plyntr".
- `reconcileWorkRepo` tries **newest notes first**. That note contains the exact folder token `mykennel` → `from: 'project'` → retarget **to** mykennel (profile `1ed8810e`).
- Grok then wrote `scripts/undo-square-customer-pull.mjs` and `src/lib/dates.js` in mykennel. `factoryWriteBlock` only refuses the **brain**, so it may write any other repo.
- Verify ran mykennel `npm test` (1645 pass, 1 fail). The fail is `tests/square-tax.test.js` (`resolveSquareTaxForInvoice is not defined`). That file is **not** in this turn's audit. Phase **failed**. He abandoned.

He wants Factory to launch the work and keep going. Not fail every time something nearby is messy. Version stays **0.1.86** until pack. Do not pack in the implement pass.

Chat/Skin/`chat-reach.ts` untouched. Kennel `staging`/`main` never auto-push. Existing FactoryPane widgets stay (WP13); no redesign.

This file is the locked plan. Opus 5.5 medium implements it.

## Locked decisions

### 1. Reconcile ignores a folder the note is only mentioning, not choosing

`reconcileWorkRepo` still never uses lastRepo. Newest Guide note still wins **when it names a destination**.

Change: when resolving a Guide note, **drop tokens that equal the current `workRepo` basename** (folded) and the lastRepo basename before `resolveWorkRepo`. Joe typing "mykennel" to complain about the label must not pin mykennel. The rest of that note ("email system for plyntr") plus older notes plus the task still resolve.

Also try a **joined hyphen**: consecutive tokens `mail` + `desk` try `mail-desk` (exact Projects folder) before the single-word loop. Same for any two adjacent tokens whose join matches a folder.

After stripping, newest note with an `ok` hit wins; else the task. If nothing unique, keep the current workRepo (do not lastRepo-steal).

Reproduce with the live texts: start on quote-deploy or mykennel, notes as in the run, end on **mail-desk**, not mykennel.

Call reconcile on `restoreRun` for a non-terminal run (after the lock is held) so an app update retargets without waiting for Guide. If the new repo needs prep, same dirty card as today.

### 2. Factory writes stay in the work repo

`factoryWriteBlock` / `filterFactoryPermission`: a **write** whose git top is a different repo than `workRepo` is refused (same shape as the brain refusal: a short sentence). Reads of the brain stay allowed. Writes in the work repo stay allowed. Paths with no git top (tmp) stay allowed.

Grok's cwd is the brain; that is why it can wander. This is the guard, not a prompt.

### 3. Unrelated verify fails do not stop the run

After `npm run` rows, a **fail** whose tail does not name any path in this turn's `audit.work` is **not** `phase: failed`. Keep the fail row visible. Continue to review (strict / voice / diff) so the work can still land.

A fail that **does** name a changed path: one automatic builder `fix` turn with the existing verify note, then verify again. If it still fails, still continue to review with the fail row (do not sit on `failed`). One auto-fix per verify pass, not a loop.

`track()` catch for a real throw can still set `failed`; Guide Send already resumes that. Do not use `failed` for "the suite next door is red".

Empty-work-repo afterTurn: keep reconcile-then-audit. If still empty: one more builder turn, then **paused** with the error (Resume/Guide continue), not `failed`.

## File list

Edit: `src/main/factory/resolve-repo.ts` (joined hyphen token; optional helper to resolve a note with ignored basenames), `src/main/factory/controller.ts` (`reconcileWorkRepo`, `restoreRun`, `verifyStep`, `afterTurn`), `src/main/factory/gates.ts` (+ existing write-guard tests if that is where they live), `scripts/check-factory.ts`, `GOAL.md` Inbox (one line; version stays 0.1.86).

Not touched: Chat, Skin, `chat-reach.ts`, pack, Kennel auto-push, `reviewAccept`.

## Checks

1. `npm run typecheck`
2. `node --test --experimental-strip-types src/main/factory/*.test.ts src/main/write-guard.test.ts`
3. `node --experimental-strip-types scripts/check-factory.ts` → `FACTORY_PASS`

New FACTORY_PASS:

- **WR 1:** Run starts on quote-deploy (or mykennel). Guide "why are we now showing the work repo as mykennel. we are working on the email system for plyntr" moves to **mail-desk**, not mykennel.
- **WR 2:** Guide "this is not gutter iq this is the mail desk for plyntr" from quote-deploy → mail-desk.
- **VF 1:** Builder writes `src/send.ts` in mail-desk. Verify `test` fails with a tail that only names `tests/square-tax.test.js` (not in audit). Phase is **not** `failed`; review (or later) is reached.
- Keep RT 1–6 and GF 1–2.

## Out of scope

Pack / notarize / replacing Brain.app (next pass after independent Opus APPROVE). Fixing mykennel's `resolveSquareTaxForInvoice` test. A work-repo picker.
