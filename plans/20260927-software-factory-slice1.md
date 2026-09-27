# Software factory Slice 1: implementation plan

## Context

GOAL.md Inbox line 1 (2026-09-27): build Slice 1 of `plans/20260927-software-factory-spec.md`, and fix Chat/Skin ACP so it can write outside the open folder the way Terminal can. Today `handleReq` in `src/main/acp-session.ts` (lines 505 to 547) refuses `fs/read_text_file` and `fs/write_text_file` unless `underRoot(pool.cwd, abs)`. That is Brain's own allowlist, not macOS. Factory is a new `+` tab that runs a T0/T1 job: cwd is the brain (hooks, AGENTS.md, skills), edits land in a separate `workRepo` by absolute path, and a main-process controller owns triage, phases, verify, review and commit. No push, no deploy, no pack, no version bump. Chat `RULES` string stays as is.

Decisions this plan makes (the spec leaves them open):
- **Commit is a click.** Review phase ends with a Commit button in the PhaseRail. Nothing else in Slice 1 changes git history without a person, and the spec says no silent tier or gate changes.
- **Dirty workRepo refuses start.** A run starts only when `git status --porcelain` on workRepo is empty. Commit then stages exactly what the run changed. Message: "This repo has uncommitted changes. Commit or stash them, then start again."
- **Closing a Factory tab mid-run pauses the run** (cancel the Grok turn, keep the lock and the run record). Reopening from the picker lists paused runs. An explicit "Abandon run" button releases the lock.
- **Brain writes from Factory are refused at the ACP layer and shown in the audit.** Not reverted.

## 1. Behavior true when Slice 1 is done

Chat / Skin
- Grok and Cursor Chat/Skin ACP read and write any absolute path the user can (`fs/*_text_file`), same reach as Terminal. Relative paths are refused.
- `brainWriteBlock` still refuses `skills/` and `.team-config/` for team or no-seat roles, judged against the brain folder that actually contains the realpath of the target (not only `pool.cwd`).
- In-app file explorer (`files:read`, `files:write`, `files:list`, `readSafe`, `writeSafe`) stays scoped to the open brain. No change in `files.ts`.
- Chat `--always-approve`, `yoloMode`, leader socket `leader-brain-app.sock`, and RULES are unchanged.

Factory
- `+` picker has a "Factory" row after Terminal. It opens a tab `type: 'factory'` with the same tab chrome.
- Intake: task text + work repo folder (folder picker, default last used). brainPath = the open brain folder.
- Triage (`triage.ts`, rules only, under 200 ms): size T0..T3 and risk none/elevated/critical with reasons. T2/T3 shows a warning and the run is capped at T1 ("doing the smallest safe slice"). Critical risk requires a "Proceed at T1" click.
- Phases: `intake -> triage -> build -> verify -> review -> commit -> done`, plus `paused`, `upgrade`, `failed`, `abandoned`. PhaseRail shows them.
- Build runs on a separate Grok pool: lane `factory`, cwd = brainPath, no `--always-approve`, no `yoloMode`, own leader socket `leader-brain-factory.sock`, PATH shims first, `ANTHROPIC_API_KEY` removed from child env.
- Each build turn prompt = `wrapPromptWithHooks({ cwd: brainPath, ... })` around a brief of at most 1,200 characters carrying role, tier, phase, workRepo absolute path, "edit only under workRepo with absolute paths", "no git push, no gh, no deploy, do not commit".
- Every Grok permission ask reaches the UI (the Chat permission card), except the filter's auto-rejects: push/gh/deploy/publish verbs, and edits whose path is under brainPath when workRepo is outside brainPath.
- After each build turn: git audit on brainPath (new porcelain entries vs pre-turn snapshot) and workRepo (`--numstat` vs run base). Brain changes show as a red "Brain changed" list. Not reverted.
- Tripwire after each build turn: over tier limits, lockfile changed, or schema/migration changed moves phase to `upgrade` with buttons (T0 over limit but within T1: "Move to T1" / "Trim" / "Stop"; over T1: "Trim" / "Stop", plus a note that T2 is Slice 2). Tier never changes without the click.
- Verify: main runs scripts, no model. T0: `npm run typecheck` if `package.json` has it. T1: plus `npm test` if present. Missing script = "skipped" row, not a fail.
- Review: T0 shows diff only. T1 sends one self-check turn (same session, brief phase `review`) and then shows the diff.
- Commit click: controller uses the real `/usr/bin/git` (not the shim) in workRepo: `git add -- <run paths>` and `git commit -m "<task first line>"`. Records the sha. Never pushes.
- One active run per workRepo (lock keyed by realpath). A second start on the same repo is refused with the running run's title.
- Run records live under `app.getPath('userData')/factory/` only. After an app restart the tab comes back (persist.ts `type: 'factory'`, `runId`), the run reloads in `paused` state, and Resume re-warms with `session/load` of the saved Grok session id and resends the current phase brief.
- Phone never lists Factory tabs.

## 2. Failure modes the checks must catch

- Factory pool reuses Chat's pool at the same cwd (poolKey collision).
- `--always-approve` in Factory argv, or `yoloMode` in Factory `session/new` `_meta`.
- Factory permission ask auto-answered: tab found with alwaysApprove default, or no tab (the `!tab` branch at acp-session.ts:472 auto-allows today; factory lane must cancel).
- Factory leader shares `leader-brain-app.sock`, or `acpKillAll` leaves the factory leader running.
- `acpGrokAccount` / `acpGrokReady` pick the factory pool for Chat `/usage`.
- `git push`, `gh`, `wrangler deploy`, `npm publish`, `vercel`, `fly deploy` reach a shell from Factory (shim or filter must stop it); controller commit accidentally goes through the shim.
- Factory `fs/write_text_file` to `<brain>/AGENTS.md` succeeds when workRepo is elsewhere; audit misses a native-tool write to `AGENTS.md`; audit reports files that were already dirty before the turn.
- Chat ACP still refuses `/tmp/x/out.md` outside cwd; or a team role can write `<other brain>/skills/a.md` because the check used `pool.cwd`; or a symlink inside cwd pointing at `skills/` bypasses the guard.
- `files:write` / `readSafe` starts accepting paths outside the brain.
- Triage: typo request not T0; T2/T3 signal runs at T2; critical risk proceeds without a click; triage over 200 ms.
- Tripwire silently changes tier, or does not fire on 4 files / 200 lines / `package-lock.json` / `migrations/*.sql`.
- Second run on same repo (or same repo via symlink path) is allowed; lock is never released after done/abandon.
- Run store path is under brainPath or workRepo, or anything new appears in either repo's `git status` after store writes.
- Resume after restart loses phase, tier, workRepo, grok session id, or lock.
- Brief over 1,200 characters, or missing role/tier/phase.
- `persist.ts` drops the factory tab or `runId` on save; phone lists it.
- Typecheck red.

## 3. File list

Create
- `src/main/factory/triage.ts`: `triage(text, hints?) -> { size, risk, capped, reasons, ms }`. Keyword and count rules only.
- `src/main/factory/brief.ts`: `buildBrief({ role, tier, phase, workRepo, brainPath, task, note? })`, hard cap 1,200 chars (truncates task, never the rules lines).
- `src/main/factory/tripwire.ts`: `TIER_LIMITS` (T0: 1 file / 20 lines, T1: 3 files / 150 lines), `LOCKFILES`, `SCHEMA_RE`, `checkTripwire(tier, numstat[]) -> { trip, reasons, suggest }`.
- `src/main/factory/git-audit.ts`: `porcelain(repo)`, `numstat(repo, base)`, `auditTurn({ brainPath, workRepo, brainBefore, base })`. Uses `execFileSync('/usr/bin/git' or resolved real git)`. Also `commitRun(workRepo, paths, message)` and `isClean(repo)`.
- `src/main/factory/run-store.ts`: `factoryDir()` = `userData/factory`; `saveRun`, `loadRun`, `listRuns`; lock files `factory/locks/<sha1(realpath)>.json`; `acquireLock`, `releaseLock`, `activeRunFor(repo)`. Atomic tmp+rename like `persist.ts`. Refuses (throws) if the resolved dir is under brainPath or workRepo.
- `src/main/factory/gates.ts`: `DENY_CMD_RE` (push, gh, deploy, publish verbs), `filterFactoryPermission(msg, { brainPath, workRepo }) -> 'reject' | 'ask'`, `factoryWriteBlock(abs, brainPath, workRepo)`, `ensureShims(dir)` writing `git` and `gh` wrappers (git: exit 1 with a sentence on `push`, else exec real git; gh: always exit 1), `factoryEnv(brainPath)` = `binEnv(brainPath)` with shim dir prepended to PATH and `ANTHROPIC_API_KEY` deleted.
- `src/main/factory/controller.ts`: state machine, one object per run; `start`, `resume`, `decide` (upgrade, proceed-critical), `commit`, `pause`, `abandon`; emits `factory:event` `{ runId, phase, tier, risk, audit, tripwire, verify, error }` to all windows.
- `src/main/factory/ipc.ts`: `factory:triage`, `factory:start`, `factory:resume`, `factory:decide`, `factory:commit`, `factory:pause`, `factory:abandon`, `factory:list`, `factory:get`, `factory:pickRepo`. Registered from wherever `skin/ipc.ts` is registered.
- `src/main/brain-root.ts`: `brainRootFor(abs)`: realpath the target (or nearest existing parent), walk parents, first hit in `listBrains()` paths plus `readWatching().brainPath` wins; `null` when none.
- `src/renderer/src/FactoryPane.tsx`: intake form, PhaseRail, permission card, audit and tripwire panels, verify rows, diff text, Commit / Pause / Abandon / Resume.
- Tests: `src/main/factory/triage.test.ts`, `tripwire.test.ts`, `brief.test.ts`, `run-store.test.ts`, `gates.test.ts`, `git-audit.test.ts`, `src/main/grok-factory-args.test.ts` (or extend `grok-leader.test.ts`), and `scripts/check-factory.ts` (prints `FACTORY_PASS`).

Edit
- `src/main/grok-args.ts`: add `grokFactorySocket()` (`~/.grok/leader-brain-factory.sock`) and `grokFactoryAcpArgs(cwd, useLeader)` = `--cwd`, `--trust agent`, no `--always-approve`, leader flags on the factory socket. Chat functions unchanged.
- `src/main/grok-leader.ts`: turn the module singleton into `makeLeader(socketFn)` with `ensure/live/kill`; export the existing names bound to the chat socket plus `ensureGrokFactoryLeader`, `killGrokFactoryLeader`.
- `src/main/acp-session.ts`:
  - `Pool.lane: 'chat' | 'factory'`; `poolKey(kind, cwd, lane = 'chat')` returns `kind:cwd` for chat (unchanged) and `factory:kind:cwd` for factory.
  - `spawnArgs` and `bootPool`/`bootPoolNow` take lane; factory uses `grokFactoryAcpArgs` and `factoryEnv`. Factory lane is Grok only (throw on cursor).
  - `session/new` for factory: `_meta: { rules: FACTORY_RULES }`, no `yoloMode`.
  - `handleReq` permission: factory lane never auto-answers; no tab = reply `cancelled`; `filterFactoryPermission` reject = `pickOption(msg, true)`; otherwise the existing card path (the `permission` StreamEvent to `tab.onEvent`).
  - `fs/read_text_file`: chat and factory require `isAbsolute(abs)` and `existsSync`, no `underRoot`.
  - `fs/write_text_file`: require `isAbsolute`; root = `brainRootFor(abs)`; if root, `brainWriteBlock(roleForBrainWrite(root) or roleForKeylessWrite(root) per brainIdForFolder(root), root, realAbs)`. Factory lane also `factoryWriteBlock` (refuse under brainPath when workRepo is outside brainPath).
  - `acpGrokAccount` / `acpGrokReady`: filter `lane === 'chat'`.
  - `acpKillAll`: also kill the factory leader.
  - New exports for the controller: `factoryWarm({ runId, tabId, brainPath, resumeId })`, `factoryPrompt({ tabId, brainPath, text, onEvent })` (reuses `deliverAcpPrompt`, which already wraps hooks with cwd = brainPath), `factoryCancel`, `factoryClose`. Factory tabs are stored in the shared `tabPool`, so `acpDecidePermission` (and `skin:decide`) already reaches them.
- `src/main/persist.ts`: `SavedTab.type` adds `'factory'`, `runId?: string`; `saveChats` copies `runId`.
- `src/main/phone-lib.ts` line 231: exclude `factory`.
- `src/main/ipc-stubs.ts` (or `index.ts`): register `factory/ipc.ts`. No change to `chat:send` or `files:write` beyond nothing (Chat reach is fixed in acp-session).
- `src/preload/index.ts`: `window.brain.factory.*` plus `onEvent`. Types beside the existing chat block.
- `src/renderer/src/TerminalWorkspace.tsx`: `Tab.type` adds `'factory'`, `runId?: string`; `addFactory(runId?)` beside `addTerm`; picker row "Factory" after Terminal; render branch `tabs.filter(t => t.type === 'factory')` mounting `FactoryPane`; save/load maps `runId`. Chat pane markup untouched.
- `src/renderer/src/styles/shell.css`: PhaseRail and audit list only (reuse existing tokens; no Chat selectors touched).
- `package.json`: add script `check:factory` only if the others have one (they do not today; skip). No version change.
- `GOAL.md`: rewrite Inbox line 1 and Now when landed.

Not touched: `files.ts`, `write-guard.ts`, Chat `RULES`, `warm.ts` routing for Chat, Settings, first-run, Phone UI.

## 4. Chat ACP allow vs Factory audit

| | Chat / Skin ACP | Factory ACP |
| --- | --- | --- |
| Pool key | `grok:<cwd>` / `cursor:<cwd>` | `factory:grok:<brainPath>` |
| Leader | `leader-brain-app.sock` | `leader-brain-factory.sock` |
| argv | `--always-approve` (unchanged) | none |
| `session/new` `_meta` | `yoloMode: true, rules: RULES` | `rules: FACTORY_RULES` only |
| Permission asks | auto unless alwaysApprove off or plan mode (unchanged) | always to the card; filter may auto-reject; no tab = cancelled |
| `fs/read_text_file` | any absolute path that exists | same |
| `fs/write_text_file` | any absolute path; `brainWriteBlock` against the target's own brain root | same, plus refuse any path under brainPath when workRepo is outside it |
| Shell reach | whatever Grok's tools do (Terminal parity) | PATH shims block `git push` and `gh`; filter rejects deploy/publish asks |
| Env | `binEnv(cwd)` | `binEnv(brainPath)` + shims first, no `ANTHROPIC_API_KEY` |
| After the turn | nothing | git audit: brain porcelain vs pre-turn snapshot, workRepo numstat vs base; tripwire; show, never revert |
| Git history | untouched by Brain | Commit on click via real git in workRepo; no push |

Chat is "allow like Terminal, guard only team-protected brain paths". Factory is "allow OS reach for the work repo, refuse and surface brain writes, deny publish verbs, and prove it with a post-turn audit".

## 5. Minimal Factory UI

- Picker row: "Factory" button after Terminal, plus a small "Paused runs" list if `factory:list` returns any.
- `FactoryPane`, top to bottom:
  1. Intake (only before start): task textarea, Work repo field with Choose folder button, Brain line (read-only brainPath), Start. Triage result appears inline on typing (debounced `factory:triage`): "T0 · risk none" with reasons; T2/T3 amber note "Capped at T1 in this version"; critical shows "Proceed at T1" button instead of Start.
  2. PhaseRail: one row of pills `Triage · Build · Verify · Review · Commit`, current one highlighted, `paused`/`upgrade`/`failed` as a status word beside it. Tier and risk chip at the right.
  3. Permission card: the exact `skin-perm` markup and class names from TerminalWorkspace (title, path, detail, option buttons), calling `window.brain.skin.decide(tabId, optionId)`. Copy the JSX or extract a `PermCard` component used by both, but Chat's DOM must not change.
  4. Activity: last Grok text chunk and `work:` status line, plain text, no chat bubbles.
  5. Audit: "Work repo changes" (path, +/-) and, if any, red "Brain changed (not reverted)" list.
  6. Tripwire box when phase is `upgrade`, with its buttons.
  7. Verify rows: script, pass/fail/skipped, last 20 lines on fail.
  8. Footer buttons by phase: Pause, Resume, Abandon, Commit (review only), done shows sha.
- Events: `factory:event` for phase/audit/tripwire/verify; Grok stream and permission events come through the controller's `onEvent` and are forwarded on `factory:event` with `kind: 'stream'`.

## Test map (12-item gate)

Run: `node --test --experimental-strip-types src/main/factory/*.test.ts src/main/grok-leader.test.ts src/main/write-guard.test.ts` and `node --experimental-strip-types scripts/check-factory.ts` (uses the `registerHooks` electron stub from `scripts/check-slash-skills.ts`, `app.getPath` pointed at a tmp userData).

1. `triage.test.ts`: "fix typo in footer" and 10 more fixtures; typo is T0; every call under 200 ms; T2/T3 fixtures return `capped: true, size: 'T1'` with the original in reasons; critical fixtures return risk critical.
2. `gates.test.ts`: shim `git push origin main` exits 1, `git status` passes through; `gh pr create` exits 1; `filterFactoryPermission` rejects titles/rawInput with `git push`, `gh `, `wrangler deploy`, `npm publish`, `vercel`, `fly deploy`. `check-factory.ts`: a factory-pool permission ask with `git push` gets `reject_once` replied.
3. `check-factory.ts`: fake factory pool with cwd = tmp brain; `fs/write_text_file` to `<tmp work repo>/src/a.ts` replies `{}` and the file exists. `grokFactoryAcpArgs` has `--cwd <brain>`.
4. `check-factory.ts`: factory `fs/write_text_file` to `<brain>/AGENTS.md` returns an error and the file is unchanged. `git-audit.test.ts`: tmp git brain, snapshot, touch `AGENTS.md`, `auditTurn` lists it under brain; a file dirty before the snapshot is not listed.
5. `tripwire.test.ts`: T0 with 2 files trips and suggests T1; T1 with 4 files or 151 lines trips with no tier change in the result; `package-lock.json` and `migrations/001.sql` trip. Controller unit in `check-factory.ts`: after trip, run tier is unchanged until `decide('upgrade')`.
6. `run-store.test.ts` + `check-factory.ts`: save a run in `build`, drop in-memory state, `loadRun` + controller `resume` gives phase `paused` with same tier, workRepo, grokSessionId, lock still held.
7. `run-store.test.ts`: `acquireLock(repo)` twice refuses the second; via a symlinked path also refuses; release after done/abandon allows a new one.
8. `grok-leader.test.ts` (extended): factory socket differs from chat socket; `grokFactoryAcpArgs` has no `--always-approve`. `check-factory.ts`: factory pool key differs from chat key for the same cwd; captured `session/new` params for factory lane have no `yoloMode`.
9. `check-factory.ts`: factory `session/request_permission` with a known tab does not reply and emits a `permission` event; with an unknown sessionId replies `cancelled`, never `allow_once`.
10. `check-factory.ts`: chat-lane pool with cwd = tmp brain A; `fs/write_text_file` to `<tmp>/elsewhere/out.md` replies `{}`; `fs/read_text_file` of it returns content; relative path is refused; team role writing `<tmp brain B>/skills/a.md` (B listed as a brain) is refused. `write-guard.test.ts` unchanged and green. `files.ts` `writeSafe` outside root still throws.
11. `npm run typecheck`.
12. `run-store.test.ts`: with userData stubbed to tmp, `factoryDir()` is under it and not under brain or work repo; after save/lock, `git status --porcelain` in both tmp repos is empty; store refuses a userData that resolves inside the work repo.

`check-factory.ts` prints `FACTORY_PASS` only if all its items pass. No live Grok, no tunnel.

## Verification

1. `npm run typecheck` green.
2. Both commands under Test map pass; `node --experimental-strip-types scripts/check-slash-skills.ts` still prints `SLASH_SKILLS_PASS` (handleReq changes must not break its fixtures, including line 454's stale permission case on the chat lane).
3. `npm run dev`: open `+`, see Factory after Terminal; Chat, Skin, Settings and Phone look unchanged. Start a dry-run Factory intake against a tmp repo to see triage and PhaseRail (no live Grok turn required).
4. Click-check note for later (not a gate): a live Cursor Chat write outside its `--workspace` may still be refused by Cursor itself; Brain no longer refuses it.
5. Rewrite GOAL.md Inbox line 1 and Now. No pack, no version bump. Independent review gate per GOAL.md before any pack.
