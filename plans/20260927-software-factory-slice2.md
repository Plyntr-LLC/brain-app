# Software factory Slice 2: implementation plan

## Context

`plans/20260927-software-factory-spec.md` Slice 2: **LLM triage, T2 plan + human gate, repo profiles, Opus strict by path, publish buttons, voice check.** T2 column: plan + human gate; Opus strict (fresh `claude -p`); + targeted e2e; 1 worker. Slice 1 is live at 0.1.79: `src/main/factory/{triage,tripwire,brief,gates,git-audit,run-store,controller,ipc,paths}.ts`, `src/shared/factory.ts`, `src/renderer/src/FactoryPane.tsx`, `window.brain.factory.*` in `src/preload/index.ts`, `scripts/check-factory.ts` (`FACTORY_PASS`). Today every tier type is `'T0' | 'T1'`, `triage()` caps T2/T3 at T1, `decideRun('upgrade')` throws unless T0 to T1, review is diff (T0) or one self-check turn (T1), and `commitRunNow` ends at `done` with no push. This plan widens that to T2, adds the plan gate, the Opus reviewer, profiles, voice, and a Push click. T3 stays capped at T2. No pack, no version bump (stays 0.1.79).

Decisions this plan makes (the spec and the locked list leave them open):
- **LLM triage runs inside the run, not inside `startRun`.** `startRun` stays sync (the `factory:start` IPC returns it directly). It runs rules triage, lands the run in `triage`, and `track(state, triageStep(state))` does the Grok one-shot (8 s), merges raise-only, then goes to `plan` (T2) or `build` (T0/T1). The tab shows the run at once.
- **LLM raising risk to critical after Start** parks the run in `triage` with `needsProceed: true` and a "Proceed at <tier>" button (new `Decision` `'proceed'`). Rules-critical still refuses Start until the Proceed click, as today.
- **Grok one-shot for triage spawns directly** with `resolveBin('grok')` and the Factory env (shims first, Anthropic keys gone), not `ai-cli.ts` `runCli` (that uses Chat's `binEnv()` and a tab map). Args: `-p <prompt> --effort low --output-format streaming-json`, no `--always-approve`, cwd = brainPath. Grok CLI default model is 4.7; one constant `TRIAGE_MODEL` adds `-m` if the CLI default ever moves. `parseGrokLine` in `ai-cli.ts` becomes an export (no behavior change) so the text is read the same way Chat reads it.
- **Plan effort ladder.** Plan turn 1 and the fix-plan turn: builder Grok at `high` (session effort set with a new exported `factorySetEffort`). Second reject: Opus 5.5 medium writes the plan. When Joe approves an Opus plan (the "after two rejects" case), build turns for that run run at Grok `xhigh`. Third reject, or `claude` missing at the second reject: `paused` with the reason. This is how "xhigh only after two plan rejects" and "second reject goes to Opus" both hold.
- **Long text lives beside the run record, not in the brief.** Plan text and the last strict FAIL text are written to `userData/factory/runs/<id>.plan.md` and `<id>.review.md` (run-store sidecars, same atomic write). The build or fix brief gets one rules line "Approved plan: <abs path>. Read it first." / "Reviewer notes: <abs path>. Fix what it names." Rules lines are never cut, so the 1,200 cap still truncates only the task. `RunRecord.plan.text` keeps up to 8,000 chars for the UI.
- **Plan turns do not go through `afterTurn`.** `afterTurn` fails a turn that changed no work files; a plan turn changes none by design. `planStep` snapshots brain porcelain, runs the turn, audits the brain (red list as usual), and if the work repo changed during a plan turn it shows "The plan turn changed files" in the audit box. Approve stays Joe's call.
- **Move to T2 from a tripwire skips the plan gate** (the code already exists; a plan now would describe work that is done). It switches verify to the T2 scripts and review to Opus strict. Stated in the tripwire box.
- **T2 limit** for the tripwire: 10 files / 600 changed lines, no lockfile, no schema. T0 and T1 limits unchanged.
- **Review pipeline, in order, one place (`reviewStep`)**: verify, then T1 self-check when it applies (T1 only, never T2), then Opus strict when required, then voice when on, then `finishReview` (diff + Commit).
- **Strict FAIL is Joe's call; voice REJECT holds.** After the second FAIL the run sits in `review` with the FAIL text in red and the button reads "Commit anyway". A voice REJECT disables Commit with one sentence and offers "Fix copy" (one builder turn with the Jev reasons, then the pipeline again). Voice is opt-in per repo, so a hard hold is what Joe asked for when he ticked it; strict is a judgment call by spec.
- **Missing reviewer is not a fail.** No `claude` binary: strict row "Opus reviewer not found (claude CLI). Commit is your call." and Commit stays. Missing `check.cjs` or `doppler`: voice row `skipped`.
- **Profiles key on `lockKey(repo)`** (sha1 of `realish(repo)`, already in `run-store.ts`) and are snapshotted onto the run at Start, so verify and voice use what Joe saw at intake even if the profile file changes mid-run.
- **Push is refused when HEAD moved.** `publish` requires `HEAD === run.commitSha` and the branch recorded at commit time. Otherwise: "This branch moved since Factory committed. Push from Terminal."
- **Copy files for voice**: changed paths ending `.md .mdx .txt .html .htm` in the run diff. Only added lines go into the tmp file (Jev scores the new copy, not the old). None in the diff: voice row `skipped` ("no copy files").

## 1. Behavior true when Slice 2 is done

Triage
- `triage.ts` rules: T2 is no longer capped. T3 caps at T2 with `capped: true`, `original: 'T3'`, reason "Triage says T3. This version caps at T2: doing the smallest safe slice." Still under 200 ms; the intake debounce still calls rules only.
- At Start, `triageStep` calls Grok low one-shot with the task and the rules result. Output parsed as the last JSON object `{ "size": "T0".."T3", "risk": "none"|"elevated"|"critical", "reason": "..." }`. `mergeTriage(rules, llm)` takes the higher size and the higher risk, never lower; T3 caps at T2. Timeout (8 s), non-zero exit, missing binary, or parse failure keeps the rules result with reason "Model triage skipped: <why>." The run record keeps `triage.llm` (raw size/risk/reason or the skip reason).
- If the merged tier differs from the rules tier, `run.tier` takes the merged tier (the only tier change without a click, and only upward, before any build).
- Critical still needs a Proceed click before plan or build.

Plan (T2 only)
- Phases: `intake -> triage -> plan (T2) -> build -> verify -> review -> commit -> done`, plus `paused`, `upgrade`, `failed`, `abandoned`. T0/T1 go `triage -> build` as today.
- `planStep`: warm the Factory ACP session (same `factoryWarm`), `factorySetEffort(tab, 'high')`, prompt `buildBrief({ role: 'planner', phase: 'plan', tier: 'T2', ... })`. The returned text is the plan (saved to sidecar and `run.plan`). Phase stays `plan` with `plan.status: 'waiting'`. No build starts until Approve.
- Approve plan: `decideRun(id, 'approve-plan')` sets `plan.status: 'approved'`, `plan.approvedAt`, then `buildStep(state, 'build')` with the plan path line in the brief.
- Reject (optional one-line reason): `plan.rejects += 1`. Reject 1: one fix-plan turn on the builder (Grok high, brief phase `plan`, note = reason, "Previous plan: <path>"). Reject 2: `runOpus` in plan mode writes the plan, `plan.by: 'opus'`. Reject 3, or Opus missing/timeout/exit non-zero at reject 2: `paused` with `resumePhase: 'plan'` and the reason.
- Opus plan spawn: `resolveBin('claude')`, argv `['-p', <prompt>, '--model', 'opus', '--effort', 'medium', '--permission-mode', 'plan', '--output-format', 'text']`, cwd = workRepo, env = Factory env (no `ANTHROPIC_API_KEY`, no `ANTHROPIC_TRANSLATOR_API_KEY`), stdin `'ignore'`, `shell: false`, never `--bare`, never an HTTP call.

Tripwire
- `checkTripwire(tier, rows)` for T0, T1, T2. `suggest`: T0 over but inside T1 (no lockfile/schema) is `'T1'`; T1 over but inside T2 (no lockfile/schema) is `'T2'`; T0 over T1 but inside T2 is `'T2'`; over T2, or any lockfile or schema change, is `null` (Trim / Stop only, "T3 comes in a later version").
- `decideRun('upgrade')` moves `run.tier` to `tripwire.suggest` only, re-checks at the new tier, then goes to verify. Tier never changes without the click.

Profiles
- `userData/factory/profiles/<lockKey(repo)>.json`: `{ repo, scripts: { typecheck?, test?, e2e? }, voice: { on: false, register?, audience? }, publish: { remote: 'origin' }, updatedAt }`. Never written in the brain or the work repo (`assertStoreOutside` guards it).
- `detectProfile(repo)` reads `package.json` scripts: `typecheck` if present, `test` if present, `e2e` if present else `test:e2e` if present. Saved values win over detection for script names; missing file = detection.
- Intake shows "This repo: typecheck · test · test:e2e" (or "no scripts found") and a "Voice check" checkbox, off by default. Ticking it saves `voice.on: true` for that repo.
- Start snapshots the profile onto `run.profile`.

Verify
- T0: `typecheck`. T1: `typecheck`, `test`. T2: `typecheck`, `test`, profile e2e. Names come from `run.profile.scripts`; T0/T1 still use `typecheck`/`test` names exactly as Slice 1 (profile only renames when the file says so). Missing script = `skipped`.

Review
- Opus strict required when `run.tier === 'T2'`, or `run.risk` is `elevated` or `critical`, or `/mypuppies/i.test(run.workRepo)`.
- T0 without strict: diff only (unchanged). T1 without strict: self-check then diff (unchanged). T1 with strict: self-check, then strict. T2: strict only.
- `runOpus` for review: same argv shape as plan (plan permission mode, so the reviewer cannot edit), fresh process every time, cwd = workRepo, prompt names `/Users/joewine/Projects/agency-brain/.claude/skills/strict-code-review/SKILL.md` by path, gives task, tier, risk, base sha, and `diffText(workRepo, base)` (60k cap, with "run `git diff <base>` for the rest"), and ends "Your last line must be exactly PASS or FAIL." The skill body is never read into the prompt.
- Last non-empty line `PASS`: strict row pass, pipeline goes on. `FAIL`: `reviewCycles += 1`; if cycles < 2, sidecar `<id>.review.md`, one builder fix turn (brief phase `fix`), then `afterTurn` (audit, tripwire, verify) and strict again. Second FAIL: stay in `review` with FAIL text shown, "Commit anyway". Anything else (no PASS/FAIL line, timeout 10 min, exit non-zero): counts as FAIL text "Reviewer did not end with PASS or FAIL."
- Voice when `run.profile.voice.on`: copy files in the diff to `userData/factory/tmp/<id>-voice.txt`, spawn `doppler run -p team-brain -c dev -- node /Users/joewine/Projects/agency-brain/code/typesafe/voice-check/check.cjs --file=<tmp> --register=<r or email> --audience=<a or client>`, PATH with `/opt/homebrew/bin` and `/usr/local/bin`. Exit 0 APPROVE (pass), 2 REJECT (hold), anything else or missing script/doppler = skipped with the reason. The tmp file is deleted after. Output tail is shown, never env.

Publish
- `done` shows "Committed abc1234 on <branch>. Not pushed." and a Push button.
- Push click: `factory:publish` -> `publishRun(id)` -> `gates.publish(workRepo, { remote: run.profile.publish.remote, branch: run.branch, sha: run.commitSha })`: `spawn(realGit(), ['push', remote, branch])` in workRepo, env with `GIT_TERMINAL_PROMPT=0`, 90 s timeout, never the shim dir on PATH.
- Disabled Push with one sentence: branch is `main`/`master`/`staging`/`prod`/`production` ("Brain does not push to <branch>. Push it from Terminal after review."); detached HEAD; no such remote; HEAD moved since commit; already pushed.
- Result recorded on the run: `pushed: { remote, branch, sha, at }` or `pushError`. No deploy, no `gh`, no PR (Slice 3).
- The model still cannot push: shims and `filterFactoryPermission` unchanged.

Unchanged
- 1 worker. Factory pool, leader socket, no `--always-approve`, no `yoloMode`, `factoryWriteBlock`, `projectBinEnv` base for Factory env, shims first. `src/shared/chat-reach.ts`, Chat RULES, Chat/Skin ACP reach untouched.

## 2. Failure modes the checks must catch

- T2 still capped at T1, or T3 runs at T3; triage over 200 ms.
- LLM triage lowers size or risk; LLM timeout or junk output changes the result or blocks Start longer than 8 s; LLM raise to critical builds without a Proceed click.
- Triage one-shot uses the Factory ACP session, `--always-approve`, or an env with `ANTHROPIC_API_KEY`.
- T2 run reaches `build` before Approve; a pause/resume in `plan` starts a build; reject counter lost across restart.
- Opus spawn missing `--permission-mode plan`, wrong model/effort, has `--bare`, prompt sent on stdin, env still has `ANTHROPIC_API_KEY` or `ANTHROPIC_TRANSLATOR_API_KEY`, or run through a shell string.
- Third reject or missing `claude` does anything but pause.
- A plan turn with no work changes is marked `failed` (it went through `afterTurn`).
- Tripwire changes tier without the click; T1 over T2 or with a lockfile suggests T2; T2 over limit suggests T3.
- Profile file written in the work repo or brain; work repo `git status` not empty after profile save; voice defaults on.
- Strict review skipped for T2, elevated, critical, or a MyPuppies path; run for T0 risk none or T1 risk none non-MyPuppies; reused a session; skill body pasted into the prompt; PASS does not reach Commit; FAIL loops more than twice; `reviewCycles` lost on restart.
- Voice runs when off; live TypeSafe or Doppler called in tests; key printed; REJECT lets Commit through; missing script fails the run.
- Push runs through the shim, pushes a protected branch, pushes after HEAD moved, or `git push` from the Factory env starts working.
- Brief over 1,200 characters, or the plan/review path line cut.
- Slice 1 T0/T1 flow changes (typo T0 through commit, self-check, upgrade T0 to T1).
- Typecheck red; `SLASH_SKILLS_PASS` or `CHAT_REACH_PASS` lost.

## 3. File list

Create
- `src/main/factory/triage-llm.ts`: `TRIAGE_TIMEOUT_MS = 8000`, `triagePrompt(task, rules)`, `grokTriageArgs(prompt)`, `parseLlmTriage(text) -> { size, risk, reason } | null`, `mergeTriage(rules, llm | null, why?) -> Triage` (raise-only, T3 caps at T2), `llmTriage({ task, rules, cwd, env, bin?, timeoutMs? }) -> Promise<{ llm, why }>` (spawn, collect text with `parseGrokLine`, kill on timeout).
- `src/main/factory/profile.ts`: `profilesDir()` = `factoryDir()/profiles`, `detectProfile(repo)`, `readProfile(repo)`, `saveProfile(repo, patch)` (atomic, `assertStoreOutside(repo)`), `profileLine(p)` for the intake text.
- `src/main/factory/opus.ts`: `STRICT_SKILL_PATH`, `opusArgs(prompt)`, `opusEnv(base)` (delete both Anthropic keys), `runOpus({ cwd, prompt, env, bin?, timeoutMs }) -> Promise<{ found, code, text, last }>` (`spawn(bin, argv, { stdio: ['ignore','pipe','pipe'], shell: false })`), `strictNeeded(run)`, `strictPrompt({ task, tier, risk, base, diff, workRepo })`, `planPrompt({ task, workRepo, plans, reasons })`, `verdict(text) -> 'PASS' | 'FAIL' | null`.
- `src/main/factory/voice.ts`: `VOICE_CHECK = '/Users/joewine/Projects/agency-brain/code/typesafe/voice-check/check.cjs'`, `COPY_RE`, `copyAdds(diff) -> string`, `voiceArgs(file, register, audience)`, `runVoice({ runId, diff, profile, spawnFn? }) -> Promise<VerifyRow>` (row script `voice`).
- Tests: `triage-llm.test.ts`, `profile.test.ts`, `opus.test.ts`, `voice.test.ts` under `src/main/factory/`.

Edit
- `src/shared/factory.ts`: `Tier = 'T0' | 'T1' | 'T2'`; `RunPhase` adds `'plan'`; `RunRecord.tier: Tier`; `triage.llm?`; `needsProceed?`; `plan?: { text, by: 'grok' | 'opus', status: 'waiting' | 'approved', rejects, reasons: string[], approvedAt? }`; `profile?: RepoProfile`; `reviewCycles?`; `strict?: { status: 'pass' | 'fail' | 'missing', text }`; `voice?: VerifyRow`; `branch?`; `pushed?`; `pushError?`; `tripwire.suggest: 'T1' | 'T2' | null`; export `RepoProfile`.
- `src/main/factory/triage.ts`: cap block becomes `original === 'T3'` caps to `'T2'`; header comment and reason text updated.
- `src/main/factory/tripwire.ts`: `TIER_LIMITS.T2 = { files: 10, lines: 600 }`; `checkTripwire(tier: Tier, rows)`; `suggest` = smallest tier above the current one that fits with no lockfile/schema, capped at T2.
- `src/main/factory/brief.ts`: `tier: Tier`; `BriefPhase` adds `'plan' | 'fix'`; role adds `'planner'`; `LIMIT_LINE.T2`; `PHASE_LINE.plan` ("Write a short plan: files, steps, tests. Do not edit files."), `PHASE_LINE.fix` ("Fix what the reviewer names, then stop."); optional `planPath` / `reviewPath` become rules lines.
- `src/main/factory/controller.ts`: `startRun` uses `t.size` for tier, snapshots profile, lands in `triage` and tracks `triageStep`; new `triageStep`, `planStep`, `reviewStep` (self-check, strict, voice), `opusPlan`; `Decision` adds `'approve-plan' | 'reject-plan' | 'proceed' | 'fix-copy'` (reject carries an optional reason); `decideRun('upgrade')` uses `tripwire.suggest`; `pauseRun`/`resumeRun`/`restoreRun` map `plan` and `triage` (triage resumes to `triageStep`, plan resumes to the waiting plan or re-runs the plan turn); `verifyStep` picks scripts by tier and profile; `commitRunNow` records `branch`; new `publishRun(id)`; `FactoryDeps` adds `claudeBin?`, `grokBin?`, `spawnOpus?`, `spawnTriage?`, `spawnVoice?`, `publish?` for fixtures.
- `src/main/factory/gates.ts`: `factoryEnv` also deletes `ANTHROPIC_TRANSLATOR_API_KEY`; `PROTECTED_BRANCHES`; `publishBlock({ repo, remote, branch, sha }) -> string | null`; `publish(workRepo, { remote, branch, sha }) -> Promise<{ ok, out }>` with real git. `DENY_CMD_RE`, shims, `filterFactoryPermission` unchanged.
- `src/main/factory/git-audit.ts`: `currentBranch(repo)` (null on detached), `hasRemote(repo, name)`.
- `src/main/factory/run-store.ts`: `saveRunText(id, kind: 'plan' | 'review', text) -> abs path`, `runTextPath(id, kind)`; `factoryTmpDir()`.
- `src/main/factory/ipc.ts`: wire real deps (`opusEnv(factoryEnv(...))`); add `factory:profile` (get), `factory:saveProfile`, `factory:publish`; `factory:decide` accepts the new decisions and `{ reason }`.
- `src/main/acp-session.ts`: export `factorySetEffort(tabId, effort)` calling the existing `setOption(rpc, sid, 'reasoning_effort', effort)` on the factory pool only (the same non-Cursor branch the Chat effort path uses; the `effort` id is Cursor-only) and updating `tab.effort`. Nothing else.
- `src/main/ai-cli.ts`: `export` on `parseGrokLine`. No other change.
- `src/preload/index.ts`: `factory.profile(repo)`, `factory.saveProfile(repo, patch)`, `factory.publish(id)`, `decide(id, choice, reason?)` type widened.
- `src/renderer/src/FactoryPane.tsx`: see section 5.
- `src/renderer/src/styles/shell.css`: `.factory-plan` and `.factory-repo-line` only, existing tokens.
- `scripts/check-factory.ts`: per-prompt fake grok steps, fake `claude`, fake voice spawn, Slice 2 checks (Test map). Brief regex `/Tier: T[012]/`.
- Existing tests: `triage.test.ts` (cap test rewritten: T2 uncapped, T3 caps at T2), `tripwire.test.ts` (T1 over into T2 suggests `'T2'`; over T2 suggests null), `brief.test.ts` (T2, plan, path lines survive the cap), `gates.test.ts` (translator key gone, publish block).
- `plans/20260927-software-factory-spec.md`: Slice 2 heading points here.

Not touched
- `src/shared/chat-reach.ts`, `files.ts`, `write-guard.ts`, Chat `RULES`, `grok-args.ts`, `grok-leader.ts`, `persist.ts`, `phone-lib.ts`, `skin/typesafe.ts`, `claude-stream.ts`, `TerminalWorkspace.tsx`, Settings, first-run, Phone UI, `package.json` (version stays 0.1.79), `out/`. `GOAL.md` Inbox gets its checked Slice 2 line when this is implemented, not now.

## 4. How T0/T1 vs T2 differ

| | T0 | T1 | T2 |
| --- | --- | --- | --- |
| Triage | rules + LLM raise-only | same | same (T3 caps here) |
| Plan | none | none (inline in build) | Grok high plan, Approve / Reject; reject 2 = Opus medium plan; reject 3 = pause |
| Build effort | session default | session default | high; xhigh when the approved plan came from Opus |
| Limit | 1 file / 20 lines | 3 / 150 | 10 / 600 |
| Tripwire suggest | T1 or T2 | T2 | none (Trim / Stop) |
| Verify | typecheck | + test | + e2e (profile) |
| Review | diff; Opus strict if risk elevated+ or MyPuppies | self-check; + Opus strict if risk elevated+ or MyPuppies | Opus strict, no self-check |
| Voice | when profile on | when profile on | when profile on |
| After commit | Push click | Push click | Push click |
| Workers | 1 | 1 | 1 |

## 5. Minimal UI

WP13: existing FactoryPane layout stays. Chat, Skin, Settings, Phone, and first-run are not restyled. Plan and Push go inside the current Factory pane.

- Intake: under the Work repo field, one `tiny` line "This repo: typecheck · test · test:e2e" from `factory.profile(repo)` and a "Voice check" checkbox (off). Triage block text: T3 shows "Capped at T2 in this version. Brain does the smallest safe slice." The critical button reads "Proceed at <tier>".
- PhaseRail: `Triage · Plan · Build · Verify · Review · Commit`. Plan pill carries `past` styling with no highlight for T0/T1 (skipped). `railIndex` and `STATUS_WORD` gain `plan`.
- Triage wait: while `triage` runs, the activity line says "Checking size with Grok (up to 8 s)". `needsProceed` shows the Proceed button in the same box style as the tripwire.
- Plan box (phase `plan`, `plan.status === 'waiting'`): "Plan by Grok" or "Plan by Opus", `<pre>` plan text, one-line reason input, Approve plan (primary), Reject (ghost). Under it: "Rejects: n of 3".
- Tripwire box: "Move to T1" or "Move to T2" by `suggest`; with null: "T3 comes in a later version. Trim the change or stop."
- Verify rows: existing `verify-row` markup; new rows `strict` ("Opus strict review") and `voice` with pass / fail / skipped; FAIL text as the existing fail `<pre>`.
- Footer: Commit (or "Commit anyway" after a second FAIL; disabled with the sentence on voice REJECT, plus "Fix copy"). On `done`: existing sha line plus branch, Push button, or disabled Push with its sentence; after push "Pushed to origin/<branch>."
- Events unchanged: `factory:event` `run` and `stream`.

## Test map

Run: `node --test --experimental-strip-types src/main/factory/*.test.ts src/main/grok-leader.test.ts src/main/write-guard.test.ts` and `node --experimental-strip-types scripts/check-factory.ts`. No live Grok, no live Claude Max, no live Jev, no Doppler, no named tunnel.

1. `triage.test.ts`: BIG fixtures with T2 signals return `size: 'T2', capped: false`; "Rewrite the whole app in Svelte" returns `size: 'T2', original: 'T3', capped: true`; every call under 200 ms; T0/T1 fixtures unchanged.
2. `triage-llm.test.ts`: `mergeTriage` rules T1/none + llm T0/none stays T1/none; + llm T2/critical becomes T2/critical; + llm T3 becomes T2 capped; `null` llm keeps rules with a skip reason. `llmTriage` with a fake grok that sleeps 20 s resolves by `timeoutMs` with rules kept; junk output keeps rules; argv has `--effort low`, no `--always-approve`; env has no `ANTHROPIC_API_KEY`.
3. `check-factory.ts` T2: task "Add a new page for team settings with a new route and shared types" starts in `triage` then lands in `plan` with `plan.status: 'waiting'`; no fake-grok write step ran and the work repo is clean; `resumeRun` after `dropMemory` stays in `plan`; `approve-plan` starts build and the build brief contains `Approved plan: <runs/<id>.plan.md>`.
4. `check-factory.ts` rejects: reject 1 sends one Grok plan turn (brief `Phase: plan` with the reason); reject 2 spawns fake `claude`. The fake logs argv, stdin bytes, and env. Assert argv includes `-p`, `--model opus`, `--effort medium`, `--permission-mode plan`, `--output-format text`, not `--bare`; the prompt is argv[1]; stdin read 0 bytes; `ANTHROPIC_API_KEY` and `ANTHROPIC_TRANSLATOR_API_KEY` absent; cwd = workRepo. `plan.by === 'opus'`. Reject 3 gives `paused`, `resumePhase: 'plan'`. With no fake `claude`, reject 2 gives `paused`.
5. `tripwire.test.ts` + `check-factory.ts`: T1 with 5 files / 200 lines suggests `'T2'`; T1 with a lockfile suggests null; T2 with 11 files suggests null. Controller: tier stays T1 after the trip until `decide('upgrade')`, then T2 and verify runs the e2e row.
6. `profile.test.ts`: tmp repo with `typecheck`, `test`, `test:e2e`; `detectProfile` finds all three with e2e = `test:e2e`; voice off; remote `origin`. `saveProfile` writes under `userData/factory/profiles/<lockKey>.json`; work repo `git status --porcelain` empty; userData inside the repo throws.
7. `opus.test.ts`: `strictNeeded` true for T2, elevated, critical, `/x/MyPuppies-site`; false for T0/none and T1/none elsewhere. `strictPrompt` contains `STRICT_SKILL_PATH` and does not contain the first 200 chars of that SKILL.md (read in the test only when the file exists). `verdict` reads the last non-empty line.
8. `check-factory.ts` strict: T1 elevated run (task "fix the API error message") goes self-check, then fake `claude` prints `...\nPASS`, then review with Commit; T2 FAIL, fix turn (brief `Phase: fix`, `Reviewer notes:` path), FAIL again: stays `review`, `reviewCycles === 2`, exactly 2 fake `claude` review spawns; each spawn is a new process (distinct pids logged).
9. `gates.test.ts` + `check-factory.ts` publish: bare tmp remote as `origin`, branch `factory/x`: `publishRun` pushes and the remote has `commitSha`. Branch `main` or `staging`: refused, remote unchanged. HEAD moved after commit: refused. Shim `git push origin factory/x` in the Factory env still exits 1. `factoryEnv` drops both Anthropic keys.
10. `voice.test.ts` + `check-factory.ts`: default profile never calls the voice spawn stub. With `voice.on`, a diff touching `README.md` calls the stub with `doppler run -p team-brain -c dev -- node <VOICE_CHECK> --file=<tmp> --register=email --audience=client`; stub exit 2 gives voice fail, Commit refused by `commitRunNow` with the hold sentence; stub exit 0 passes; `VOICE_CHECK` missing gives skipped. No real `doppler` invoked (stub asserts); tmp file deleted.
11. Slice 1 regression: all existing `check-factory.ts` checks (items 2 to 10, 12) still pass with the fake grok on the typo T0 run through commit, self-check, T0 to T1 upgrade, resume, lock. `FACTORY_PASS` only if every Slice 1 and Slice 2 check passes.
12. `brief.test.ts`: T2 plan brief and a fix brief with a 5,000-char task stay at 1,200 and keep the plan/review path lines.
13. `npm run typecheck`; `node --experimental-strip-types scripts/check-slash-skills.ts` prints `SLASH_SKILLS_PASS`; `node --experimental-strip-types scripts/check-chat-reach.ts` prints `CHAT_REACH_PASS`.

Fixture changes in `check-factory.ts`: `FAKE_GROK_PLAN` becomes `{ match: string, steps: [...] }[]`, picked by the first regex that matches the prompt text (`Phase: plan` gives text only, `Phase: build` gives writes); a fake `claude` in `home/.local/bin` (found by `resolveBin`) that logs `{ argv, pid, stdinBytes, cwd, anthropic, translator }` and prints the next line from `FAKE_CLAUDE_PLAN`; `FactoryDeps.spawnVoice` stub; a bare git repo for the publish remote.

## Verification

1. `npm run typecheck` green.
2. Both Test map commands pass; `FACTORY_PASS`, `SLASH_SKILLS_PASS`, `CHAT_REACH_PASS` printed.
3. `npm run dev`: `+` Factory, type a T2 task: "T2 · risk ..." with no cap note; "This repo" line and Voice check (off) show. Chat, Skin, Settings, Phone, first-run look unchanged. No live Grok plan turn required.
4. `git status` in brain-app shows only the intended source and test changes; nothing under `out/`; version still 0.1.79.
5. Rewrite GOAL.md Inbox (checked Slice 2 line) and Now when landed. No pack, no push. Independent review gate per GOAL.md before any pack.
