# Factory evals, usage, code-stays-home, brain record, shadow ledger (brain-app)

Repo: brain-app, worktree `/Users/joewine/Projects/brain-app-factory-evals`, branch `factory-evals` from origin/main b0045c8. Program plan (context): Factory evals + hillclimb per Anthropic's build-eval/hillclimb method, run through the signed-in CLIs only (Claude Max `claude -p`, Grok CLI), never model APIs.

Phase 0 probe already done: `claude -p --output-format json` returns `usage`, `modelUsage.<id>`, `total_cost_usd` (list-price equivalent), `duration_ms`, `num_turns`, `result`. Grok `--output-format streaming-json` ends with `{"type":"end", usage, total_cost_usd, modelUsage.<id>}`. Triage today is served by `grok-4.6-build` (comment in triage-llm.ts says 4.7).

## 1. Behavior when done

A. **Usage per model call.** Every Factory model call records one row on the run: `{phase, cli, model (from the response), effort, inTokens, outTokens, cacheRead, cacheWrite, costEq, ms, turns, ok}`. The calls are Opus plan, Opus strict review, Opus build turn, and Grok triage. Grok/Cursor ACP build turns record `ms` and turns, plus tokens when ACP reports them. The Factory pane shows one line per run with total tokens and time. Opus calls switch to `--output-format json`. The verdict (PASS/FAIL, GAPS, OUTSIDE) is read from the JSON `result` exactly as today's plain text was. JSON mode keeps all of stdout up to a cap `OPUS_JSON_MAX` (16 MB, injectable for tests) instead of the 400k tail slice. (1) stdout within the cap parses as the envelope, so the text is `result`, and the row is `ok:true` with the envelope's counts. (2) stdout over the cap, or not parseable, is never read for a verdict. strictStep treats it as NO_VERDICT (a fail: never commits, never ships), the plan step as no plan, and the builder step as a failed turn. The row is `ok:false` with zero tokens. (3) Non-JSON stdout (the CLI printed a plain error) is also NO_VERDICT. The review text shown is the raw tail, for the human only. A verdict is never taken from a truncated or guessed envelope. Timeout (124), non-zero exit, and a missing binary each still write a row: `ok:false`, `ms`, the model from the response if any came, else `''` (never the configured name). ACP build turns (Grok/Cursor) write a row with `ms` and turns, plus tokens when the ACP prompt result carries usage. `opusBuildArgs` also switches to `--output-format json` and stays `bypassPermissions`.

B. **Model and effort are parameters with today's defaults.** `opusArgs(prompt, o?)` and `grokTriageArgs(prompt, o?)` take optional `{model, effort}`. Called with no options, they return today's production argv exactly, except the Opus output format (see A). Production call sites pass nothing.

C. **Project code never stored in Brain.app.** The run JSON in userData keeps metadata only. The code-bearing fields move to a store inside the work repo's own git dir, `<git-common-dir>/brain-factory/<runId>/`: `diff`, `strict.text`, `plan.text`, `verify[].tail`, `voice.tail`, `note` (fix notes copy verify and voice tails), and the multi-line `error`, `pushError`, `deployError` (userData keeps only their first line, capped at 200 chars), and the plan/review/verify text files (T3 `.verify.txt` is the full script output). That store is untracked, never in `git status`, and works for linked worktrees. `loadRun`/restore re-hydrates all of them (diff, strict.text, plan.text, verify tails, voice tail, note) from the repo store for the UI and the briefs. planPath, reviewPath and verifyArtifact point into the repo store. If the repo store is missing, the fields come back empty and nothing crashes. Existing run files in userData are migrated once on load: code fields and the `.plan.md`/`.review.md`/`.verify.txt` files move to the repo store if the work repo exists and is a git repo. Otherwise they are deleted and the fields come back empty. Load never throws on a missing repo.

D. **Brain record.** Every persist of a run whose phase is `done` or `abandoned` (so the transition in, a second settle, Push, and Deploy all count) makes the controller (not a model) upsert one entry, keyed by run id, into `<brainPath>/<folder>/factory-log.md`. Folder resolution: the repo profile's `brainFolder` if set (a brain-relative path; absolute paths, `..` segments, and anything resolving outside the brain are rejected and fall through), then `clients/<basename>` if it exists, then `projects/<basename>` if it exists, else `projects/<basename>/` is created. The entry holds date, one-line title, work repo path, tier/risk, triage (rules vs model), phases with model+effort, strict verdict and cycles, verify rows (status only), branch, commit SHA, pushed/deployed, usage totals, the shadow row (E), and follow-ups. No diff, no code, no review body. A second settle or a resume-then-done updates the same entry, never duplicates it. The git audit ignores only paths whose last segment is exactly `factory-log.md` in the brain, so a concurrent run on another repo never flags it as a stray write. Every other brain write is still flagged.

E. **Shadow ledger.** The unit is a *judgment*: one human decision made against one gate. It is not a run.
- **gate** is written every time finishReview runs. It is the loop's own ship recommendation, independent of the checkboxes: `wouldShip = strict pass (reviewAccept) AND no voice hold AND no verify fail naming a changed file`. When strict is not needed and none ran: `wouldShip = no voice hold AND no our-fail`. Stored as `shadow.gate = {id, wouldShip, strict: 'pass'|'held'|'missing'|'none', model, at}`. A new finishReview replaces the gate with a new id. Fail cycles below REVIEW_MAX never reach finishReview, so a fail that later passes has a pass gate.
- **A judgment is appended** (`shadow.judgments[]`) when Joe acts by click while a gate exists and that gate has no judgment yet:
  - **commit**: Commit (`commitRunNow` from IPC), including Commit anyway on a held fail.
  - **push**: Push (`publishRun` from IPC) that actually pushes (a new `run.pushed` is set by this call), only when the commit before it was automatic, so that gate has no judgment yet.
  - **guide**: `guideRun` while the phase is `review`, `diff` is set, and a gate exists. The controller always starts a fix turn on that path (the review-with-diff branch of guideRoute), whatever `guideRoute` returns, so the rule keys on phase + diff + gate, not on the return value.
  - **abandon**: Abandon (IPC).
- **Never a judgment:**
  - an automatic ship from finishReview (it adds 1 to `shadow.auto` once per gate, whether it auto-committed, auto-pushed, or both)
  - notes sent when no gate exists or the phase is not `review` (queued or in-flight notes)
  - abandons with no gate (e.g. during triage, counted as `noGate`)
  - a Push click on a run that is already pushed (`publishRun` returns early, nothing is pushed)
  - a Push click that is refused or fails (publishBlock, git error), since nothing shipped
- **agree** is `(wouldShip AND action ∈ {commit, push}) OR (!wouldShip AND action ∈ {guide, abandon})`. It is stored on the judgment with the gate id. A Guide after a pass is a disagreement: the loop would have shipped something Joe wanted changed.
- `npm run eval:factory -- agreement [--repo <path>]` reads userData run metadata. Judgments are ordered by time across all runs of a repo. It prints, per repo, `agree A/J, streak S, auto N, noGate M`, where S counts consecutive agrees back from the newest judgment.

F. **Eval runner (no production behavior).** `npm run eval:factory -- <job> [--repo <path>] [--config <name,...>] [--split train|holdout] [--repeats n] [--limit n (per config)] [--dry]`.
- Jobs: `triage`, `review`, `probe`, `agreement`.
- Configs are a registry (`src/main/factory/eval/configs.ts`). Triage configs: `rules`, `grok-default-low` (today), `grok-default-medium`, `grok-4.7-low`, `grok-low-emptycwd` (same argv, cwd an empty tmp dir, timeout raised to 60 s for measurement). Review configs: `opus-medium` (today), `opus-low`, `sonnet-high`, `sonnet-medium`.
- Each case runs through the same `triagePrompt`/`strictPrompt` and arg builders production uses, with `opusEnv` applied. The runner refuses to start if any of `ANTHROPIC_API_KEY`, `ANTHROPIC_TRANSLATOR_API_KEY`, `XAI_API_KEY`, `GROK_API_KEY` is set (non-empty) in its env (Doppler guard). It exits non-zero before any spawn, with an error that says to run outside `doppler run`. `--dry` prints, per config, the exact argv it would spawn and spawns nothing. `rules` prints `no spawn`. The report ends with `EVAL_OK` or `EVAL_FAIL`, and the exit code is non-zero on a runner error (grades are data, not failures).
- Cases live in each project's own repo at `<repo>/evals/factory/{triage,review}.jsonl`, never in brain-app except brain-app's own. Triage case: `{id, sha, task, expect:{size, risk}, source}`. Review case: `{id, base, head | patch, expect:{verdict, bugs:[{file, symbol?, line?, severity}]}, source}`.
- The split is deterministic: sha1(id) mod 5 == 0 is holdout. `--split holdout` requires `--confirm`.
- Review cases run in a temp `git worktree` of the case repo at `head` (or `base` + `patch` applied), created under os.tmpdir and removed after, pass or fail. The case repo's own working tree and branches are never touched.
- Grading. Triage: exact size and exact risk, plus weighted error (under-size = 3 × steps, over-size = 1 × steps). Review: verdict via `reviewAccept`, plus bug named (file match AND (symbol or ±5 line) in the review text), plus false-reject count.
- Output: a metadata-only JSON plus a markdown report in `<brain>/projects/factory-evals/results/<date>-<job>-<config>.{json,md}`. They hold case id, repo, sha, config, served model id, pass/fail, weighted error, usage, and ms. Never review text, diff, or task body beyond the case id. Raw reviewer text for review cases goes to `<case-repo git-common-dir>/brain-factory/evals/<date>/`.
- `--repeats` gives the noise bar (per-config spread across repeats in the report).

G. **Case builder.** `npm run eval:factory -- cases-triage --repo <path> [--since <date>] [--max n]` writes `<repo>/evals/factory/triage.jsonl` from that repo's own git log. Task = commit subject + body (merges skipped). size = from `git show --numstat` of that commit (files changed, lines changed) mapped with the same thresholds as `LIMIT_LINE` in brief.ts (T0 ≤1 file/20 lines, T1 ≤3/150 with no new deps or migrations, T2 ≤10/600, else T3). risk = from paths touched (auth/payment/migration/schema/secret/.env → critical; api/config/package.json/deps → elevated; else none). It never reads triage.ts rules. The file is proposed for Joe to relabel. Existing ids are kept (idempotent re-run).

## 2. Ways this can fail (checks must catch each)

1. JSON switch breaks the verdict, or a verdict is read from a truncated or guessed envelope. A PASS review read as FAIL (auto-fix loops burn usage), or a FAIL read as PASS (ships a bug).
2. JSON parse fails on truncated or odd stdout (timeout, over the cap, stderr only, plain text). The verdict path must never read a verdict from raw or partial text. It must return NO_VERDICT (never commit, never ship), not throw, and still write an `ok:false` usage row.
3. The usage row is missing or wrong when the CLI times out, exits non-zero, or is not found. The model id comes from config instead of the response.
4. Default argv drifts. `opusArgs(p)`/`grokTriageArgs(p)` with no options differ from today (other than the Opus output format).
5. A code-bearing field still lands in userData. Candidates are diff, strict.text, plan.text, verify tails, voice tail, error strings that embed diff output, and the `.review.md`/`.plan.md`/`.verify.txt` files.
6. The repo store lands inside the tracked tree (shows in git status, gets committed) or breaks on a linked worktree (`.git` is a file).
7. After restart, restore does not re-hydrate. The UI shows an empty review, or a fix brief gets a reviewPath that does not exist, so the fix turn is blind.
8. The migration of old runs crashes on a repo that no longer exists, or leaves the old text files in userData.
9. The brain log duplicates on resume, second settle, or re-done. It includes code or review body. It writes to the wrong folder. Or a concurrent run's git audit flags it as a stray brain write.
10. The shadow ledger misattributes. A Guide after a passing gate is not recorded as a disagreement. An auto-commit counts as Joe's judgment. An abandon with no gate is counted. A judgment is keyed to a stale gate instead of the gate current at the click. Two judgments land on one gate.
11. The eval runner bills an API (key in env) or silently uses a different model than configured.
12. The eval runner leaves temp worktrees, changes the case repo's checkout or branches, or leaks the case repo's code into brain-app or the brain results.
13. Grader leakage. The triage expected label is derived from triage.ts itself, so `rules` wins by construction.
14. Holdout contamination. The split is not deterministic, or holdout runs without `--confirm`.
15. The Kennel refusal or the protected-branch push refusal changes. Ship in advance semantics change.

## 3. End-to-end check (medium case) and artifact

Three parts, all rerunnable. Every marker below is a unique string `CODEMARK_<n>` planted in the work repo's changed files and in the fake reviewer, verify, and voice outputs.

**Part 1: `scripts/check-factory.ts` extended.** Existing checks still pass. The S2 4 argv assertion and `opus.test.ts` are updated from `text` to `json`, and nothing else in them changes. New named checks:

- **a. JSON verdicts (fake claude prints a Claude-shaped envelope when `--output-format json`).**
  - A full envelope whose `result` ends `GAPS: 0\nPASS` commits (Approve in advance on). Its row is `ok:true` with the fake's token counts and served model `claude-fake-served` (config says `opus`).
  - An envelope with 500k of padding inside `result` before `GAPS: 0\nPASS` (over the old 400k slice, under the cap) commits, which proves the slice is gone.
  - With `OPUS_JSON_MAX` shrunk to 100k for the test, the same 500k envelope does not commit. strict is fail with NO_VERDICT, the run takes a fix turn, and the row is `ok:false`.
  - A full envelope whose `result` ends `GAPS: 2\nFAIL` starts a fix turn and does not commit.
  - Plain non-JSON stdout ending in `PASS` does not commit (NO_VERDICT).
  - Timeout (fake sleeps past a shortened timeout), exit 3, and a missing binary each leave a row with `ok:false`, the right `ms`, and `model:''`.
  - The fake grok triage emits an `end` event with modelUsage `grok-fake-served`, and the triage row carries that id.
  - One ACP build row has `ms` and turns with 0 tokens (no usage in the result). One has tokens (the fake driver returns usage).
- **b. Code stays home (T1 on a tmp repo, and a T3 run).**
  - Markers go into a multi-line `error` (the fake driver's build turn throws an Error whose message has the marker on line 2, so the run fails via track()), a multi-line `deployError` (fake deploy prints the marker on line 3), a multi-line `pushError` (fake publish), the diff, a failing verify tail, a voice tail (voice REJECT), the fix note that copies the tail, the Opus plan text (T2), the strict FAIL text, and the T3 `.verify.txt`.
  - After done: `grep -r CODEMARK userData` has zero hits. `<git-common-dir>/brain-factory/<runId>/` holds every marker. `git status --porcelain` in the work repo is clean.
- **c. Linked worktree.** Same as b with the work repo a `git worktree`. The store lives under the common dir, and the worktree status is clean.
- **d. Restart.** `dropMemory()` then `restoreRun()`. The diff, strict text, plan text, verify tails, voice tail, and note all come back. A resumed build brief's `planPath` and a fix brief's `reviewPath` exist on disk.
- **e. Migration.** An old-format run (diff, plan.text, strict.text, tails, note, and multi-line error/pushError/deployError with markers on line 2 in JSON, plus `.plan.md`/`.review.md`/`.verify.txt` in userData). Repo exists: after `loadRun`, userData has zero markers and the repo store has them. Repo deleted: `loadRun` does not throw, userData has zero markers and none of the three text files, and the fields are empty.
- **f. Brain log.**
  - Resolution for three layouts. (1) profile `brainFolder: 'clients/acme'` is used. (2) `brainFolder: '../evil'` and `/tmp/x` are rejected and fall through. (3) An existing `clients/<basename>/` is used. (4) No folder creates `projects/<basename>/factory-log.md`.
  - One run driven through pause, resume, done, a second `settle`, and a Push appears exactly once, updated with the push SHA. The entry has the commit SHA and zero markers.
  - Negative control: during another run's build turn, the brain gets both a factory-log.md upsert at `projects/<basename>/factory-log.md` and a second file `projects/<basename>/stray.md` in the SAME folder. That run's `audit.brain` lists `projects/<basename>/stray.md` and does not list factory-log.md. A second stray at `notes/stray.md` is also listed.
- **g. Shadow (checkboxes OFF unless noted).** Runs in order on one repo:
  - A: gate pass, Commit. Agree.
  - B: gate pass, Guide (a fix turn starts), new gate pass, Commit. Disagree, then agree (two judgments, two gate ids).
  - C: held fail at REVIEW_MAX, Commit anyway. Disagree.
  - D: voice hold gate (wouldShip false), Abandon. Agree.
  - E: Abandon during triage. No judgment, noGate 1.
  - F: strict fail cycle then pass, Commit. Agree, gate strict `pass`.
  - G: a note sent during build (queued, no gate), then gate pass, Commit. One judgment, agree.
  - H (Approve in advance ON, Ship in advance OFF): auto-commit, then Joe clicks Push, which really pushes to the bare remote. `auto` 1 and one push judgment, agree.
  - I (both ON, a separate repo so repo 1's numbers are unchanged): auto-commit + auto-push on one gate gives `auto` 1 and zero judgments. Joe's later Push click is a no-op (already pushed) and adds no judgment.
  - Expected print: `agree 6/8, streak 4, auto 1, noGate 1`. Judgments in order: A✓ B1✗ B2✓ C✗ D✓ F✓ G✓ H✓. The trailing streak is D, F, G, H.
  - Also asserted: a second click on the same gate adds no second judgment.
- **h. Argv pins.**
  - `opusArgs(p)` = `[-p,p,--model,opus,--effort,medium,--permission-mode,plan,--output-format,json]`.
  - `opusBuildArgs(p)` = the same with `bypassPermissions`.
  - `grokTriageArgs(p)` = today's exact array.
  - With options, `grokTriageArgs(p,{model:'grok-4.7'})` includes `-m grok-4.7`. `opusArgs(p,{model:'sonnet',effort:'high'})` has `sonnet`/`high`.
  - FactoryPane.tsx still has `useState(true)` for runThrough and shipThrough.

**Part 2: runner checks, no live model (`scripts/check-eval-factory.ts`, prints `EVAL_CHECK_PASS`).**
- **Doppler guard.** With each of the four keys set to a dummy in turn, the runner exits non-zero, no fake binary was spawned (spawn log empty), and stderr names `doppler run`.
- **`--dry`** for every registry config: `rules` prints `no spawn`, `grok-4.7-low` includes `-m grok-4.7`, `sonnet-high` has `--model sonnet --effort high`, and `opus-medium` equals the production pin.
- **Grader fixtures.**
  - Weights: under-size (answer smaller than expected) costs 3 per step, over-size costs 1 per step. Expected T0, got T2 (over by 2): 2. Expected T3, got T1 (under by 2): 6. Expected T1, got T2: 1. Expected T2, got T2: 0.
  - `PASS` with `GAPS: 1` is graded fail through `reviewAccept`.
  - A bug at line L is named when the review cites `file:L+5`, not `file:L+6`, and is named on a symbol match.
- **Case builder on a fixture repo.** A commit "fix typo" touching 5 files incl `src/auth/session.ts` is stored as T2/critical (numstat + path), even though `triage()` says T0.
- **Split.** `--split holdout` without `--confirm` exits non-zero. The same id lands in the same split across two runs and the two orderings.
- **Review job with the fake claude on a fixture case repo.** Before and after: HEAD, branch, and `git status --porcelain` are identical. `git worktree list` has no entry under os.tmpdir. The results JSON and md have zero `CODEMARK` markers, and neither contains `diff --git` or a line starting `@@ `.

**Part 3: live smoke on brain-app itself (real CLIs, small).**
- The env is checked clean.
- `cases-triage --repo <worktree> --max 40`.
- `triage --config rules,grok-default-low,grok-low-emptycwd --limit 6`. `--limit` is per config, so this is 12 live Grok calls (rules spawns nothing). Each config keeps its own timeout and cwd: `grok-default-low` is today's call exactly (brain cwd, 8 s, so it measures today's timeouts), and `grok-low-emptycwd` has an empty tmp cwd and 60 s. The `grok-low-emptycwd` config runs triage with cwd = an empty tmp dir, per today's finding that triage loads ~36k tokens of brain context and times out at 8 s.
- `review --config opus-medium --limit 2` (planted-bug patches against brain-app's own files).
- Artifact: results JSON and md in `<brain>/projects/factory-evals/results/` with served model ids, a grep showing no markers or diff lines there, plus the Part 1 and Part 2 outputs.

## 4. Files

brain-app, new:
- `src/main/factory/usage.ts` (parse Claude JSON and Grok stream end → UsageRow)
- `src/main/factory/repo-store.ts` (git-common-dir store: save/load/migrate)
- `src/main/factory/brain-log.ts` (folder resolve, render, upsert by run id)
- `src/main/factory/shadow.ts` (ledger + agreement)
- `src/main/factory/eval/{configs,cases,grade,split,runner}.ts` + tests
- `scripts/eval-factory.ts`, `scripts/check-eval-factory.ts`
- `evals/factory/{triage,review}.jsonl`, `evals/factory/patches/*.patch` (brain-app's own cases)

brain-app, changed:
- `src/main/factory/opus.ts`, `src/main/factory/triage-llm.ts` (options, JSON, usage)
- `src/main/factory/run-store.ts` (strip code fields on save, hydrate on load)
- `src/main/factory/controller.ts` (usage rows, repo store paths, brain log at done/abandoned, shadow)
- `src/main/factory/git-audit.ts` (ignore */factory-log.md in the brain)
- `src/main/factory/profile.ts` (optional brainFolder)
- `src/shared/factory.ts` (UsageRow, shadow, brainFolder types)
- `src/renderer/src/FactoryPane.tsx` (one usage line in the existing run header; no layout change)
- `scripts/check-factory.ts` (fake claude JSON, fake grok end event + checks a–h; S2 4 pin text→json)
- `src/main/factory/opus.test.ts` (pin text→json)
- `src/main/acp-session.ts` or the Factory driver (surface per-turn ms, turns, usage if ACP reports it)
- `package.json` (`eval:factory` script)

agency-brain: `projects/factory-evals/{README.md,status.md}`, results folder written by the runner. The pointer plan and backlog entries are brain notes (no code).

Out of this pass (deferred-backlog): the builder effort ladder, the planner eval, the plan-gate/merge-gate model eval runs (the runner supports a `review` job with any prompt, so gate cases become data later), graduation gating of Ship in advance by streak, auto-merge to protected branches, and the strict-skill trim.
