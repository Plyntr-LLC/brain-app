# Software factory UX: dirty start, named repos, live files, Opus plans

Joe 2026-09-27. Packed **0.1.84**. Existing FactoryPane layout stays (WP13). Chat/Skin/`chat-reach.ts` untouched. Factory stays gated (no `--always-approve`, shims, `factoryWriteBlock`). Kennel `staging`/`main` still never auto-pushes.

Joe: the factory needs to work better. (a) Dirty work repo must not refuse Start. (b) A project name or one of its names finds the repo, shown up front so it can be corrected. (c) Show files being referenced like Chat. (d) Plans, review, and approval route to Opus 5.5; the reviewer is always an independent session. Then: guide the run after Start (chat-like composer); a Ship in advance checkbox so a clean Opus approval commits and pushes without another click; never treat a review with gaps as PASS, even if Opus calls them non-blockers; at least 5 auto fix+review cycles before a held reject; after a held reject, more than Commit anyway / Abandon.

This file is the locked plan. Opus 5.5 medium implements it. Sections 1–5 may already be in the working tree; finish those if incomplete, then land 6–9. Do not revert 1–5.

## Locked decisions

### 1. Dirty work repo: Start, then Commit first or Stash first

`startRun` does **not** return `{ ok: false }` for uncommitted changes.

If the work repo is dirty after resolve + lock:

- Create the run as today (triage fields, lock, `rememberRepo`).
- Set `needsPrep: 'dirty'` and `dirtyFiles` (repo-relative porcelain paths, cap 20 in the record; UI shows up to 8).
- Do **not** start `triageStep`. `base` stays current HEAD until prep finishes.
- Return `{ ok: true, run }` so the run view opens.

Copy (short): **This repo has uncommitted changes (N files). Commit them first, or stash them, then Factory starts.**

Buttons: **Commit first** / **Stash first**. `decideRun` choices `'prep-commit' | 'prep-stash'`.

- **Commit first:** real git, all current dirty paths (tracked + untracked, same as porcelain). Message `WIP before Factory: {title}`. Reuse `commitRun` in `git-audit.ts`. Then `base = headSha`, clear `needsPrep` / `dirtyFiles`, start `triageStep`.
- **Stash first:** `git stash push -u -m "Factory: {title}"`. Do not pop at the end of the Factory run. Then `base = headSha`, clear prep, start `triageStep`.
- Commit/stash failure: stay on `needsPrep: 'dirty'` with `error` (slice 300). Do not start triage.
- **Approve in advance does not skip this wait.** Joe chooses commit or stash.
- Clean tree: Start behaves as 0.1.82 (triage begins immediately).
- Abandon from this wait still releases the lock and does not commit or stash.
- Resume while `needsPrep` is set does not start triage.

Export `dirtyPaths(repo)` (and a thin `stashAll` if it keeps git in `git-audit.ts`) from `git-audit.ts`. Tests inject a tmp repo.

### 2. Repo names, not only the exact folder token

Keep order: path in the task, then a `~/Projects` folder, then last Factory repo. Never the brain.

After exact lowercase folder-name token (today, token length ≥ 3):

For each task token with length ≥ 4, against Projects folders that are git repos and not the brain:

1. **Folded exact:** strip non-alphanumeric from token and folder name (`brainapp` / `brain app` → `brain-app`).
2. **Unique prefix:** folder name or folded name starts with the token / folded token. Exactly one hit wins.
3. **Unique contains:** folder name or folded name contains the token / folded token. Exactly one hit wins.

Ambiguous (two+ hits for that token): skip the token. Do not pick. Fall through to the next token, then lastRepo.

`from: 'name'` for these hits (exact folder token stays `'project'`). Tests inject `projectsDir`.

Examples that must pass in `resolve-repo.test.ts` with injected folders `brain-app`, `agency-brain`, `mykennel`, `lotline`:

- `fix footer in brain-app` still `'project'`
- `kennel` → `mykennel` (`from: 'name'`, unique contains)
- `brain app` / `brainapp` → `brain-app`
- `brain` → `brain-app` (unique prefix; `agency-brain` does not start with `brain`)
- `fix typo` with no name still lastRepo or `NAME_THE_REPO`

Show the repo **up front** so it can be corrected:

- Intake: folder **basename** first, then the full path. If `from === 'last'`, add: `Last Factory repo. Name the folder in the task if this is wrong.`
- Run view: same (basename + path) as the first line after the title. Naming a different folder in the task already re-resolves on intake; do not add a picker.

`resolveRepo` IPC `from` union adds `'name'`.

### 3. Live file hits like Chat

`StreamEvent` already has `{ kind: 'file'; path; tool? }`. Factory `onEvent` already forwards stream events. `FactoryPane` currently ignores `kind: 'file'`.

Collect unique paths during the run (renderer state, like Chat `filesRef`). Render each as the existing Skin ToolCard chrome (`.skin-tool` / `.skin-tool.live`, tool label + basename). Live while the turn is running; not live after `done`/`error` for that turn. Do not restyle Chat. Do not add a competing layout.

Keep the existing **Work repo changes** audit list after turns. Live cards are the Chat-like layer; audit stays the git truth.

Cap unique live hits at 40.

### 4. T2/T3 plans are Opus 5.5 medium, first time

Do not send the first T2/T3 plan to Grok.

`afterTriage` for T2/T3 calls `opusPlan` (fresh `claude -p --model opus --effort medium --permission-mode plan --output-format text`, prompt in argv, stdin closed, no Anthropic keys, cwd = work repo). Same `planPrompt` / `opusArgs` as today.

Rejects: every reject is another **fresh** `runOpus` (independent process). Reject 3 still pauses. Do not call Grok `planStep` for planning. Resume of a waiting plan with text still does not start a build (unless `runThrough`, which auto-approves as today). Resume that needs a new plan calls `opusPlan`, not Grok.

Wait copy is always **Opus is writing the plan**. Plan card: **Plan by Opus**. `plan.by` is `'opus'` for new plans. Old `'grok'` on disk still renders.

`runThrough` still auto-approves once Opus plan text is saved. Unchecked still waits on Approve.

T0/T1 still skip plan. Grok still **builds**. Opus still does **not** edit (`--permission-mode plan`).

### 5. Review and approval stay independent Opus

T2/T3 (and existing `strictNeeded`) still spawn a **new** `runOpus` for strict review. Never reuse the planner process. Never send review to the Grok builder session.

Approve in advance is still the human checkbox. The planner must not PASS its own work. Push is not a click when **Ship in advance** is on and Opus returned a clean pass (section 7). Deploy stays a click. Never auto-deploy.

Factory Opus stays `--effort medium` only (`opusArgs` unchanged).

### 6. Guide after Start (chat-like)

The run view gets a bottom composer like Chat: textarea + Send, always while the run is live (not done/abandoned). Placeholder: `Guide this run`. Enter sends (Shift+Enter newline). Do not restyle Chat. Reuse Factory field/actions; sent notes may use the existing `.bubble.me` class so they read like a thread.

`guideRun(id, text)` IPC (also `factory:guide`). Store `guide: { at: number; text: string }[]` on the run (last 20, each cut at 800). Include the latest note in the next builder/planner/fix brief via `buildBrief` `note` (and `planPrompt` reasons).

- Busy (a prompt in flight): queue. When that turn returns, drain: one follow-up turn with the queued notes before verify if still in build, else before the next phase.
- Waiting on a plan: sending a note re-runs `opusPlan` with the note (does not Approve the plan).
- Held after 5 failed reviews: sending a note is **Keep fixing** with that note, then a fresh Opus review.
- Paused: notes sit on the run and go into the Resume brief.
- Never send Joe's guide to the Opus reviewer process (the reviewer stays independent). The fix brief can name the review sidecar plus the guide.

Show the thread above the composer (Joe's notes). Keep Pause / file cards / activity.

### 7. Ship in advance (clean Opus only)

Second intake checkbox, same pattern as Approve in advance, default **on**:

**Ship in advance** — If Opus finds no gaps, commit and push. Never deploys. Never pushes main, master, staging, prod, or production.

`startRun({ shipThrough })` stored on the run. Independent of `runThrough`:

- `runThrough` only: auto-commit on a **clean** Opus pass (section 8). No push.
- `shipThrough` only: still wait on plan / permission cards; after a clean Opus pass, auto-commit then auto-push.
- both on: walk away through push.
- Dirty prep still always waits.

Auto-push uses existing `publishRun` / `publishBlock`. If the branch is protected, detached, no remote, or HEAD moved: stay `done` with the commit and `pushError` set to that sentence. Never auto-deploy. Kennel `staging`/`main` stay refused.

`strictNeeded` false (plain T0/T1): `shipThrough` does **not** push (no Opus approval). Tiny copy on the run: `Ship in advance waits for an Opus review with no gaps.` Missing `claude` (`strict.status === 'missing'`): no auto-commit and no auto-push.

`finishReview` may be async so it can `publishRun` after `commitRunNow`.

### 8. Gaps are never a PASS

Independent Opus review. Controller decides accept/reject, not Opus's story.

`reviewAccept(text)` in `opus.ts` (unit-tested):

- Last line must be PASS or FAIL (`verdict`).
- Second-to-last (or a `GAPS: N` line) required. Missing `GAPS:` on a PASS → reject.
- `GAPS: 0` + last line PASS → accept only if the body does not name leftovers: `nit`, `nits`, `non-blocker`, `not a blocker`, `leave for later`, `optional follow`, `follow-up` as an open item.
- `GAPS: N` with N > 0 → reject even if last line is PASS.
- Last line FAIL → reject.

`strictPrompt` tells the reviewer: any gap is FAIL, including nits and non-blockers; end with `GAPS: <n>` then `PASS` or `FAIL`.

`strictStep` uses `reviewAccept`. A rejected PASS is stored as `strict.status === 'fail'` with why (`PASS named gaps` / `PASS without GAPS: 0`). Auto-commit and auto-push require `strict.status === 'pass'` from `reviewAccept`. Human **Commit anyway** is Joe overriding, not an Opus approval; auto paths never use it.

### 9. Five review cycles, then a held reject with Chat-like choices

`REVIEW_MAX = 5`. On FAIL / rejected PASS, auto `fix` + fresh independent Opus, while `reviewCycles < 5`. The 5th failed review **holds** (phase review, diff shown). Approve in advance and Ship in advance do **not** commit or push from a held reject.

Held copy: **Opus has not approved after 5 reviews. Gaps still count.**

Buttons (keep Commit anyway and Abandon; add the rest):

| Action | What |
| --- | --- |
| Keep fixing | Another builder fix turn, then a new Opus review (cycles may go past 5). |
| Re-review | Fresh Opus only, no fix turn. |
| Guide | The composer; Send does Keep fixing with that note. |
| Trim | Existing trim. |
| Pause | Existing pause. |
| Commit anyway | Existing human override. Not an Opus pass. |
| Abandon run | Existing. |

`Decision` adds `'keep-fix' | 're-review'`. Keep-fix / re-review clear `strict` so `reviewStep` runs Opus again; do not reset `reviewCycles`.

## File list

Edit

- `src/shared/factory.ts`: `needsPrep`, `dirtyFiles`, `shipThrough?`, `guide?`.
- `src/main/factory/opus.ts` (+ tests): `reviewAccept`, `REVIEW_MAX` or keep max in controller; `strictPrompt` GAPS lines.
- `src/main/factory/git-audit.ts`: `dirtyPaths`, stash helper.
- `src/main/factory/resolve-repo.ts` (+ tests): folded / unique prefix / unique contains; `from: 'name'`.
- `src/main/factory/controller.ts`: dirty prep; Opus plans; `guideRun`; 5 review cycles; held `keep-fix` / `re-review`; `shipThrough` auto-push after clean pass; `finishReview` async.
- `src/main/factory/brief.ts`: room for a guide note (still cap 1200; cut the task first).
- `src/main/factory/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/FactoryPane.tsx`: composer, ship checkbox, held buttons, file cards, basename repo line. Tiny CSS only if the composer needs it (`.factory-compose`).
- `scripts/check-factory.ts`: S2 held after 5 FAILs (not 2); PASS-with-nits does not auto-commit; shipThrough pushes only on `GAPS: 0` + PASS; guide queues; keep-fix after hold spawns another reviewer. Planner pid ≠ reviewer pid.
- `GOAL.md` Inbox: new line for guide / ship / gaps / 5 cycles. Version stays 0.1.82. No pack.

Not touched: `chat-reach.ts`, Chat RULES, files.ts explorer, Phone, first-run, Settings chrome, pack, version, Kennel auto-push.

## Test map (no live CLI)

1. Dirty Start returns `ok: true` with `needsPrep: 'dirty'` and files listed; triage has not run; lock is held.
2. `prep-commit` creates a WIP commit, clears prep, then triage proceeds; `base` is the new HEAD.
3. `prep-stash` leaves a stash, work tree clean, then triage proceeds; Factory done does not `stash pop`.
4. `runThrough: true` still waits on dirty prep (does not auto-commit WIP).
5. Clean Start is unchanged (no `needsPrep`).
6. `kennel` → `mykennel`; `brain` → `brain-app` not `agency-brain`; `brainapp` → `brain-app`; exact `brain-app` still `'project'`.
7. T2 first plan: one fake `claude` spawn, `plan.by === 'opus'`, no Grok `Phase: plan` prompt. `runThrough: false` waits for Approve.
8. T2 reject 1: a second claude spawn (new pid), not a Grok plan turn.
9. T2 then strict: reviewer spawn is a different pid than the planner.
10. runThrough T2/T3 still auto-build after the Opus plan sidecar exists.
11. Slice 1 dirty-refuse check is gone; critical-risk Proceed still refuses start until Proceed (unchanged).
12. Five FAILs: four auto fix turns, fifth holds; no auto-commit; `keep-fix` starts another review.
13. `reviewAccept`: `PASS` plus `nit` / `non-blocker` / missing `GAPS:` → fail. `GAPS: 0` + `PASS` → pass.
14. `shipThrough` + clean pass: commit and stubbed push called. `shipThrough` + protected branch: commit, `pushError` set, no remote update.
15. `shipThrough` + missing claude: no push.
16. Guide while plan waits: another `opusPlan` with the note, still waiting.
17. Guide while busy: applied after the in-flight turn (queued).

## Out of scope this pass

Pack / notarize / gh release. Replacing Brain.app. Grok as builder becoming Opus. Auto-pop stash. A work-repo picker. Redesign of Chat or FactoryPane. Auto-deploy. Pushing `main` / `staging` / Kennel protected branches.
