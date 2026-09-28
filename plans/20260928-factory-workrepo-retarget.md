# Factory: Work repo label follows the repo Joe is actually in

Joe 2026-09-28 after packed **0.1.85**. He directed Factory onto the Plyntr email work. File cards / edits looked like mail-desk. The run still said Work repo is the Gutter IQ quote folder (`gutter-iq-quote-deploy`, last Factory repo). That label is `run.workRepo`, set once at Start. Guide never retargets it. Factory write-block only refuses brain edits, so Grok can write mail-desk while Commit and the label stay on the quote repo.

Existing FactoryPane layout stays (WP13). Chat/Skin/`chat-reach.ts` untouched. Factory stays gated. Kennel `staging`/`main` still never auto-push. Do not pack. Version stays 0.1.85.

This file is the locked plan. Opus 5.5 medium implements it.

## Locked decisions

### 1. Reconcile workRepo from the task, then from a Guide note

`run.workRepo` is the commit target and the line on screen. It must be the unique repo the task (or a later Guide note) names.

`reconcileWorkRepo(state)` (controller, with tests):

1. Resolve **without lastRepo** (never steal Gutter IQ). Never the brain.
2. First try `resolveWorkRepo({ task: run.task, brainPath: run.brainPath })`.
3. If a Guide note was just stored, also try `resolveWorkRepo({ task: note, brainPath })`. A unique hit on the note wins over the original task.
4. If not `ok`, or the hit is the current `run.workRepo` (same realpath), no-op.
5. Else **retarget**:
   - Release the lock on the old repo if this run holds it.
   - `acquireLock` the new repo. If another run holds it, set `error` (slice 300), keep the old workRepo, do not start a builder in the old repo from this call.
   - Set `workRepo` to `gitTop`, `profile` from `readProfile`/`runProfile`, `base` to `headSha` of the new repo, `rememberRepo`.
   - Persist. The Work repo line already binds `run.workRepo`; no new layout.
   - If the new tree is dirty and the run has not built yet (`needsPrep` already, or phase is `triage` / waiting `plan` with no diff): set `needsPrep: 'dirty'` and `dirtyFiles` as Start does. Do not auto commit/stash.
   - If a builder turn is already in flight: still retarget; the interrupted/follow-up turn uses the new repo. Do not stash the old repo. Do not move leftover files.

Call reconcile:

- At the start of `guideRun` after the note is stored (before interrupt / follow-up).
- At the start of `resumeRun` when it would start work.
- At the start of `opusPlan` and `buildStep` (so a restored 0.1.84 run whose **task** uniquely names mail-desk flips on the next turn without waiting for Guide).

Do **not** retarget from lastRepo. Do **not** retarget from ambiguous names (`quote` hits gutter-iq-quote-deploy and guttercompass-quote). Do **not** make the brain the work repo.

### 2. Copy

No FactoryPane redesign. After a successful retarget, the existing Work repo line shows the new basename + path. Optional one-line `error` cleared; do not add a picker.

## File list

Edit: `src/main/factory/controller.ts`, `scripts/check-factory.ts`, `GOAL.md` Inbox (one line; version stays 0.1.85). Tests: injected `mail-desk` and `gutter-iq-quote-deploy` (or the existing gutter fixture). A run started with `workRepo` given as the quote folder and task "email system for Plyntr" retargets to mail-desk on `guideRun` / `buildStep`. A "fix typo" task does not retarget. Ambiguous `quote` does not retarget.

Not touched: `chat-reach.ts`, Chat, Skin, pack, version, Kennel auto-push, `reviewAccept`.

## Out of scope

Pack / notarize. Replacing Brain.app. A work-repo picker. Auto-moving uncommitted files from the old repo into the new one.
