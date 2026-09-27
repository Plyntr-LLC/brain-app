# Software factory Slice 3: implementation plan

## Context

Joe 2026-09-27: build T3 now, and T2/T3 must be approvable **up front** so a run can start and continue to done without waiting on the plan card. Do **not** make Joe pick a work repo. Factory infers it from the task (and last used repo) the same way this brain session already does.

Live: 0.1.80 Slice 2 (`plans/20260927-software-factory-slice2.md`). T3 is capped at T2. T2 writes a plan then waits for Approve. Factory permission asks go to the card. Commit is a click.

Spec Slice 3: **T3 slices, parallel builders, full e2e, deploy token.** T3 column: slices + xhigh + human; xhigh + strict; full e2e + artifact; up to 3 parallel, non-overlapping files. Kennel `staging`/`main` still never auto-pushes (Opus 5.5 CLI gate stays outside Factory).

No pack. Version stays 0.1.80. Existing FactoryPane layout stays (WP13). Chat/Skin/`chat-reach.ts` untouched. Factory stays gated for the model (no `--always-approve`, shims, `factoryWriteBlock`).

## Locked decisions

1. **T3 is allowed.** Remove the Slice 2 cap. `triage.ts` returns `size: 'T3'` when the rules say T3. `asTier` keeps T3. LLM merge still raise-only; it can raise to T3.

2. **Approve in advance (run-through).** Intake checkbox **Approve in advance**, default **on**. Passed as `startRun({ runThrough })`. Stored on the run. When on:
   - The plan is still written (sidecar + UI) so you can read it while it runs.
   - As soon as the plan text is saved, the controller auto-approves and starts build. No wait on the plan card.
   - Factory permission asks that `filterFactoryPermission` would send to the card are auto-allowed (`pickOption` allow). Rejects (push/gh/deploy/brain edits) still auto-reject. `tab.factory.runThrough` is set in `factoryWarm`.
   - Tripwire with a `suggest` auto-upgrades (pre-approved). Tripwire with `suggest: null` (lockfile, schema, over T3) still stops.
   - After a clean review (diff present, voice not REJECT, strict pass or missing), **auto-commit**. Second strict FAIL still waits on Commit anyway. Voice REJECT still waits on Fix copy.
   - **Never auto-push. Never auto-deploy.**
   - Unchecked: today's wait-on-plan + permission card + Commit click.

3. **T2 and T3 both use the plan phase.** T0/T1 still skip plan. T3 plan effort is Grok **xhigh**. T2 plan stays Grok high (xhigh only after an Opus plan, as Slice 2).

4. **T3 slices.** T3 plan brief asks for a last JSON object `{"slices":[{"title":"...","files":["rel/path.ts"]}]}` (repo-relative). `parseSlices(text)` reads that. Empty/invalid → one slice "whole task" (1 worker). `scheduleSlices(slices)` builds waves of at most 3 with pairwise disjoint file sets; overlapping slices go sequential. Each worker: own ACP tab `factory-<id>-w<n>`, same pool, same `runThrough`, brief includes that slice's files. After each wave, one combined git audit + tripwire. Close worker tabs on done/abandon.

5. **T3 tripwire.** `TIER_LIMITS.T3 = { files: 40, lines: 2500 }`. Suggest can be `'T3'`. Over T3, lockfile, or schema → `suggest: null`. Move to T3 from a T2 tripwire skips the plan (work already exists), same as Move to T2 today.

6. **Verify T3.** `typecheck` + `test` + profile e2e + a **full e2e** row: `e2e:full` script if present, else a second run of `e2e` / `test:e2e` labeled `e2e:full` when T3 (if only one e2e script exists, one row is enough and a skipped `e2e:full` is fine). Save combined verify stdout to `userData/factory/runs/<id>.verify.txt` (artifact). Missing scripts still skipped.

7. **Review T3.** `strictNeeded` is true for T3. Opus spawn is always `--effort medium` (Joe 2026-09-27; same as the Kennel merge gate). Claude has no xhigh. Still plan permission mode, skill by path, max 2 FAIL.

8. **Deploy.** Not the model. After Push, a Deploy button. `gates.deploy(workRepo, cmd)` runs `profile.deploy.cmd` with **no shims**, `GIT_TERMINAL_PROMPT=0`. No cmd → disabled "No deploy command on this repo." Kennel path (`/mykennel/i`) always refused. Cmd is stored in the userData profile only, never logged. Tests stub spawn. Do not invent a token or call Vercel.

9. **1 worker for T2.** Parallel only when `tier === 'T3'` and more than one scheduled slice.

10. **No work-repo picker.** Intake has the task, **Approve in advance**, and Start. Remove the Work repo field and Choose folder. `startRun` takes optional `workRepo`; main resolves it:
    - Paths in the task (`/Users/…`, `~/…`) whose `gitTop` is a git repo **other than** `brainPath`.
    - A `~/Projects/<name>` folder whose name (or last path segment) appears as a token in the task (`brain-app`, `mykennel`, `lotline`, …). Tests inject `projectsDir`.
    - Else the last Factory work repo in userData prefs, if it is still a git repo and not the brain.
    - Still refuse when the resolved repo **is** the brain (Factory does not use the brain as the work repo; auto-sync).
    - If none of those hit: Start fails with “Name the code repo in the task (a path or the Projects folder name). Factory does not edit the brain.”
    Show a read-only “Work repo: …” line as they type (resolve IPC), including last-repo fallback. Voice check binds to the resolved repo. Remember lastRepo on successful Start. `workRepo` on the run card stays.

## File list

Create
- `src/main/factory/slices.ts`: `parseSlices`, `scheduleSlices`, tests.
- `src/main/factory/resolve-repo.ts`: `resolveWorkRepo`, tests (fake `projectsDir` / exists / gitTop).
- `src/main/factory/deploy.ts` or fold into `gates.ts`: `deployBlock`, `deploy`.

Edit
- `src/shared/factory.ts`: `Tier` adds `'T3'`; `runThrough?: boolean`; `slices?: { title: string; files: string[] }[]`; `deploy?: { cmd?: string }` on profile; `deployed?` / `deployError?`.
- `triage.ts`: drop T3 cap.
- `tripwire.ts`: T3 limits; suggest `'T1'|'T2'|'T3'|null`.
- `brief.ts`: `LIMIT_LINE.T3`; T3 plan phase line names the JSON slices shape; worker build note can name files.
- `controller.ts`: `runThrough`; after `planStep`/`opusPlan` if `runThrough && plan.text` then approve+build; T3 `buildSlices`; auto-upgrade; auto-commit on clean `finishReview`; `asTier` includes T3; verify T3 + artifact; workers.
- `gates.ts`: deploy helpers; `factoryEnv` unchanged.
- `profile.ts`: optional `deploy.cmd`.
- `opus.ts`: `opusArgs(prompt, effort?: 'medium'|'high')`.
- `acp-session.ts`: `tab.factory.runThrough`; permission auto-allow when runThrough after filter; `factoryWarm` takes `runThrough`.
- `ipc.ts` / preload / FactoryPane: `runThrough` checkbox (default on), no work-repo field/Choose folder, live resolved Work repo line, T3 copy, Deploy button, cap warning gone for T3. `start` workRepo optional.
- `scripts/check-factory.ts`: T3 + run-through cases. Slice 1/2 regression stays.
- Tests: `slices.test.ts`, triage/tripwire/brief/gates/controller via check-factory.
- `GOAL.md` Inbox Slice 3 line when implementing. Check off `todo/deferred-backlog.md` `brain-app-factory-slice-3`.
- Spec Slice 3 heading points here.

Not touched: `chat-reach.ts`, Chat RULES, files.ts explorer, Phone, first-run, Settings chrome, pack, version.

## Test map (no live CLI)

1. Rules: T3 ask is `size: 'T3', capped: false`; under 200 ms.
2. `runThrough: true` T2: lands in plan then auto-reaches build without `approve-plan` IPC; plan sidecar exists; work files get written.
3. `runThrough: false` T2: still waits in plan until Approve.
4. runThrough Factory ask (ordinary edit): auto-allow; `git push` still reject_once.
5. T3 two disjoint slices: two worker tabIds, both write, then verify.
6. Overlapping slices: sequential (second prompt after first settles).
7. Tripwire T2 over T3 limits suggests T3; lockfile suggests null; runThrough auto-upgrades a T1→T2 suggest.
8. T3 verify writes `<id>.verify.txt` under userData; work repo git status clean of that file.
9. Auto-commit on runThrough clean review; voice REJECT does not auto-commit; Push not called.
10. Deploy with no cmd refused; kennel path refused; stubbed cmd spawn has no shims on PATH.
11. Opus T2 and T3 review argv includes `--effort medium` (never high).
12. Slice 1/2 FACTORY_PASS items still pass. typecheck, SLASH_SKILLS_PASS, CHAT_REACH_PASS.
13. Resolve: task with `/tmp/work/src/a.ts` (git top `/tmp/work`, brain elsewhere) → that repo. Task `fix footer in brain-app` with `projectsDir/brain-app` git → that repo. No path, lastRepo set → lastRepo. Same as brain → refuse. Empty task tokens and no lastRepo → the name-the-repo error. Start with only `{ task, brainPath, runThrough }` succeeds when lastRepo or a path resolves.

## Verification

typecheck; factory unit tests; `check-factory.ts` FACTORY_PASS; slash + chat-reach. No pack.
