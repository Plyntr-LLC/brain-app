# Factory: Work repo follows Joe, Guide Send starts now, chrome stays put

Joe 2026-09-28 after packed **0.1.85**. Three things, one root each:

1. He directed Factory onto the Plyntr email work. File cards looked like mail-desk. The Work repo line stayed `gutter-iq-quote-deploy`. `run.workRepo` is snapshotted at Start; Guide never moved it. `factoryWriteBlock` only refuses the brain, so Grok can edit mail-desk while Commit and the label stay on the quote repo.
2. The run then said **failed** and stopped. `afterTurn` audits **the frozen workRepo**. Grok wrote mail-desk; quote-deploy has no diff → `This turn changed no files in the work repo.` → `failed`. Guide on `failed` / `paused` stores the note and returns. He has to click Resume. That is the dead stop.
3. Guide Send is hard to trust. The composer sits in the same scroller as the log, so it and the Triage/Plan/Build row scroll off. Unsent notes say **Waiting for the next turn.** even when he just hit Send. He needs Send to start work **now**, and to see that it went.

Retarget for (1) is already in the working tree (`reconcileWorkRepo`, RT 1–6). This plan keeps that and locks (2) and (3). Version stays **0.1.85**. Do not pack.

Joe asked for the chrome change: the phase row stays at the top, the Guide box stays at the bottom, the info in between scrolls. That is the one layout change. Pills, Send, and control placement stay. Chat/Skin/`chat-reach.ts` untouched. Factory stays gated. Kennel `staging`/`main` still never auto-push.

This file is the locked plan. Opus 5.5 medium implements it.

## Locked decisions

### 1. Keep `reconcileWorkRepo` (already in tree)

Do not rip it out. Behavior as in `plans/20260928-factory-workrepo-retarget.md` and RT 1–6: unique resolve without lastRepo; newest Guide note wins over the task; lock/profile/base/`rememberRepo` follow; never the brain; never an ambiguous name; another run's repo sets `error` and does not start work there; dirty new repo waits on Commit/Stash first only before the first build.

Call sites stay: `guideRun` after the note is stored, `resumeRun` when it would start work, start of `opusPlan` and `buildStep`.

### 2. Failed is not a dead end; afterTurn audits the repo Joe is in

**Root cause of the empty-file fail:** audit uses `run.workRepo`. If Grok wrote the named repo and the label is still lastRepo, the audit is empty and the run dies.

`afterTurn`, before `auditTurn`:

1. `reconcileWorkRepo`. `'stop'` (other lock, or prep on a not-yet-built repo): do not fail as empty; return. Prep/error already persisted.
2. Audit `state.run.workRepo` (the post-reconcile path).
3. If that audit has work files, continue verify as today.
4. If it still has none: `failed` with the same error and `resumePhase: 'build'` (genuine empty turn). Guide Send then starts work (decision 3). Do not invent a second phase.

Verify `npm run` fail still sets `failed` with `resumePhase: 'build'`. `track()` catch still sets `failed`. Those stay. They must not be a dead end.

### 3. Guide Send starts work now

`guideRun` after reconcile:

- Busy + interruptible (`plan|build|verify|review`, not triage/prep/Proceed): interrupt and start the follow-up (already shipped). Keep it.
- **`failed` or `paused`:** do not store-and-return. `gen++`, then `resumeTo(state, run.resumePhase || 'build')` so this Send **is** Resume with the note. The next builder/planner brief carries it (already: `openNotes` / `withGuide`).
- Waiting plan: fresh `opusPlan` (already).
- Review with a diff: one `fix` turn (already).
- Triage in flight, dirty prep, Proceed, upgrade cards: still queue the note unsent. Those are the only waits.

When `guideRun` starts a follow-up (interrupt, failed/paused resume, waiting plan, review fix), `markSent` **before** `track` so the bubble is sent on the IPC return. Notes that stay queued stay unsent.

`resumeTo` already starts a build from `failed` with `run.note`. That stays. Open Guide notes still lead the brief.

RT 2 today: Guide retargets, then a separate `resumeRun` starts the turn. After this slice, Guide on a settled/failed/paused run starts the turn itself. Update RT 2: after the Guide note, `settle` without requiring a second Resume (Resume while already busy stays a no-op).

### 4. Composer: Send looks like it sent, and it did

`sendNote` in FactoryPane:

- Clear the box **before** awaiting IPC (optimistic). On `!ok`, put that text back if the box is still empty, show `error`. On ok, `setRun(res.run)`.
- Never leave the typed text sitting there after a successful Send.

Unsent subtitle (only while `!g.sent`):

- Follow-up started this Send: there should be no unsent line (`markSent` in decision 3).
- Truly queued: **Queued until this step finishes.** not **Waiting for the next turn.**
- Drop **Waiting for the next turn.** That line is why Send feels like it did nothing.

Do not disable the composer on `failed` / `paused`. Live already includes those.

### 5. Chrome: phase row pinned top, Guide box pinned bottom, info scrolls

**Root cause:** `.factorywrap { overflow: auto }` so the whole pane, including `.phaserail` and `.factory-compose`, scrolls away.

Run view only (intake Start screen stays a single scroller):

- `.factorywrap` on a run: column flex, `overflow: hidden` (Chat's `.chatpane` pattern). Do not restyle Chat.
- Inside `.factory`: three regions, same widgets, same order.
  - **Head (not scrolling):** title, Work repo line, `.phaserail` (Triage … Commit, status word, tier chip).
  - **Body (the only scroller):** everything that is now between the rail and the composer (activity, files, cards, plan, audit, verify, diff, errors, actions, Guide bubbles).
  - **Foot (not scrolling):** `.factory-compose` (textarea + Send) when the run is live. Opaque `var(--card)` so body text does not show through.
- Do not move Send. Do not restyle the pills. Do not put Pause/Resume in the footer. Do not change intake.

`factory-head` / `factory-body` wrappers are allowed. That is the layout Joe asked for.

## File list

Edit: `src/main/factory/controller.ts` (`afterTurn`, `guideRun`, `markSent` timing), `src/renderer/src/FactoryPane.tsx` (`sendNote`, run-view wrappers, unsent copy), `src/renderer/src/styles/shell.css` (factorywrap run chrome only), `scripts/check-factory.ts` (RT 2 + new Guide-on-failed; keep RT 1–6), `GOAL.md` Inbox (one line; version stays 0.1.85).

Not touched: `chat-reach.ts`, Chat pane CSS beyond not regressing it, Skin, pack, version, Kennel auto-push, `reviewAccept`.

## Checks

1. `npm run typecheck`
2. `node --test --experimental-strip-types src/main/factory/*.test.ts`
3. `node --experimental-strip-types scripts/check-factory.ts` → `FACTORY_PASS`

New / updated FACTORY_PASS:

- RT 1–6 still pass (retarget).
- RT 2: Guide note naming mail-desk retargets **and** the follow-up turn runs there without a separate Resume.
- **GF 1:** A run that `failed` with the empty-work-repo error: `guideRun` with a note starts a builder turn (`busy` / a prompt) and the note is `sent`. Phase is not left sitting on `failed` with an unsent note.
- **GF 2:** `afterTurn` path: start on quote-deploy, task uniquely names mail-desk, builder writes `mail-desk/src/send.ts` only. After settle, workRepo is mail-desk, audit lists `src/send.ts`, phase is not `failed` with the empty-work-repo error.

## Out of scope

Pack / notarize / replacing Brain.app. A work-repo picker. Auto-moving leftover files from the old repo. Redesigning the pills or the Start form.
