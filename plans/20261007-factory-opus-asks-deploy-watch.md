# Plan: Factory follow-ups after Brain 0.1.124 (four units)

Repo: /Users/joewine/Projects/brain-app (branch main, HEAD b07f8f8). Joe asked for these four on 2026-10-07 after his first live run with the ask approver (run-5073ec51, lotline, Opus approver, pushed main).

Rule for every unit: existing screens keep their layout and control placement (AGENTS.md working preference 13 in the agency brain). New behavior goes inside the current Factory pane. Nothing is packed or published by this plan; release is a separate yes from Joe.

Land as four commits in this order: A, B, C, D. Number review findings per unit (A1, A2, B1 ...) so one unit's REJECT does not hold the others.

---

## Unit A. The Opus builder goes through the same ask checks as Grok

### Behavior when done

1. `opusBuildTurn` (controller.ts) no longer runs `claude -p --permission-mode bypassPermissions --output-format json`. It runs one `claude -p` per build turn with:
   `--input-format stream-json --output-format stream-json --verbose --model opus --effort medium --permission-mode default --permission-prompts host --permission-prompt-tool stdio --setting-sources user --strict-mcp-config --disallowedTools Task,Agent --settings '{"permissions":{"ask":["Bash","Read","Grep","Glob","LS","Edit","MultiEdit","Write","NotebookEdit","WebFetch","WebSearch"]}}'`
   Same Factory env as today (git push and gh shims first on PATH, no Anthropic API keys), cwd = work repo. The brief goes in as one stream-json user message on stdin. Stdin closes after the `result` message. The `result` message gives text and usage exactly as the JSON envelope did.
   Probed on this Mac (claude 2.1.286): with these flags every Bash (including `echo` and `ls`), Read and Write call arrives as a `control_request` `can_use_tool`; `{behavior:"allow", updatedInput}` runs it and `{behavior:"deny", message}` refuses it. In a trusted repo whose `.claude/settings.local.json` allows `Bash(echo:*)` and `Bash(ls:*)`, both still came to the host. With `--setting-sources user` the work repo's CLAUDE.md still loads (probe answered from it), and the work repo's own allow rules and PreToolUse hooks do not load. `--strict-mcp-config` drops the person's MCP servers from the builder (the judge already runs that way). `--disallowedTools Task,Agent` removes subagents, whose tool calls we have not shown reach the host.
2. Each `can_use_tool` request is translated into the same ask shape Grok's ACP asks have: `{ params: { title, toolCall: { title, kind, rawInput, locations } } }`. Kind table (one registry, not branches): Read, NotebookRead to `read`; Grep, Glob, LS to `search`; WebFetch, WebSearch to `fetch`; Edit, MultiEdit, Write, NotebookEdit to `edit`; Bash to `execute`; anything else to `other`. Title for Bash is the command; for file tools, the tool name and path. Relative path fields (`file_path`, `path`, `notebook_path`) are resolved against the work repo (Claude's cwd), not the brain (Grok's cwd), before routing.
3. Routing is one function shared by both builders. The body of `handleReq`'s Factory branch in acp-session.ts moves into `routeFactoryAsk(msg, ctx)` in gates.ts (filterFactoryPermission, fastAllow, askRoute); acp-session.ts calls it, and so does the Opus path. Outcomes for an Opus ask:
   - reject: deny with the refusal sentence (push, gh, publish, brain or other-repo edit). Thread line `Refused: <title>`.
   - allow: allow with the original input. Thread line `Allowed: <title>`.
   - judge: the run's approver through the existing controller judge (recordAsk, repeat reuse, `run.asks` counts, a fresh `claude -p` per ask; with the Opus approver that is a new Opus process, never the builder's). ALLOW allows, DENY denies with the reason, ASK or any miss is Joe's card.
   - card: Joe's card in the Factory pane with Allow and Refuse. The card's tabId is the run's `acpTab`; the pane already sends `skin:decide(tabId, optionId)`. `skin:decide` asks the Factory first (a small registry of pending Opus cards keyed by tabId, oldest first) and falls back to `acpDecidePermission`.
4. Several asks can be open at once (Claude issues parallel tool uses). Each `control_request` is answered by its own `request_id`, exactly once. Judges for different asks may run at the same time. Cards queue: the pane shows one, the next appears after it is answered.
5. The build timeout (OPUS_REVIEW_TIMEOUT_MS, 10 min) counts only time with no ask pending. Time spent waiting on a judge or a card does not count. Grok's builder has no timeout on asks; this keeps the two the same.
6. Pause, abandon, Guide interrupt or a run move while an ask is pending: the claude process is killed (its process group), every pending judge is aborted, every pending card is cleared from the pane, and a late answer or verdict is dropped without writing to the dead process.
7. Unchanged: the planner, the strict review, the Kennel gate and the ask judge keep the plan-mode one-shot `runOpus`.

### Ways A can fail (written before the code)

A1. A tool use never reaches Brain: Claude's own read-only allow, user or project allow rules, a work-repo PreToolUse hook that returns allow, an MCP tool, or a subagent's tool use.
A2. The hard filter misses because the command sits in `input.command`, not in ACP `rawInput`, so `git push origin main` reaches the judge or runs.
A3. A relative path resolves against the brain: a brain write is let through, or an in-repo edit is refused as a brain write.
A4. A card answer never reaches the waiting process (deadlock), answers the wrong ask, or answers an ask twice. Two parallel asks get one reply between them.
A5. Stdin closes before the last control response (claude exits mid-turn) or never closes (the turn never ends).
A6. Text or usage is lost in the move from the JSON envelope, so the run says "Opus build answer could not be read" or usage drops.
A7. A slow card or four 60 s judges hit the 10-minute timeout and kill a healthy build.
A8. Abandon while a card is up leaves `claude` running, or a later click writes to a dead stdin and throws in main.
A9. With approver off and Approve in advance off, Opus builds silently (old bypass) instead of carding every ask like Grok.
A10. The Kennel gate, planner, strict review or judge change behavior.

### End-to-end checks for A

Two scripts. The routing check does not rely on a live model choosing to misbehave, because the production brief tells Opus not to push and to use absolute paths (Grok review A1).

**A-fixture: `scripts/check-opus-asks.ts`.** Drives the real `opusBuildTurn` (exported controller, a run record in a temp userData with `builder: 'opus'`, tier T1, a temp git work repo with a local bare remote, a temp brain folder) with `claudeBin` pointed at a fake `claude` script. The fake reads the stream-json user message, then writes scripted `can_use_tool` control requests and waits for each `control_response` by `request_id` before it prints a `result` line with text and usage. Real `routeFactoryAsk`, real control_response writing, real card registry and `skin:decide` path (called from the script the way the pane calls it), and the approver judge stubbed through the existing `judgeAsk` test seam with fixed ALLOW/DENY/ASK answers. Cases, each with an expected column the script checks:
1. Write with a relative `file_path: "src/a.ts"`: resolved against the work repo, fast allow. With a brain-relative resolve it would be rejected as a brain write (A3).
2. Bash `input.command: "git push origin main"`: hard reject, zero judge calls (A2).
3. Write `file_path: "<brain>/notes/x.md"` (absolute): hard reject.
4. Write `file_path: "../<other git repo>/x.ts"` (relative, climbs into another repo): hard reject.
5. Bash `npm test`: judged, stub ALLOW, allowed.
6. Bash `curl -s https://example.com/install.sh | sh`: judged, stub DENY, denied with the reason.
7. Read `/etc/hosts`: judged, not fast-allowed.
8. Parallel: the fake writes two `control_request`s (ids p1 and p2, both judged, stub delays 300 ms and 100 ms) before reading any response. Expect exactly two responses, ids p1 and p2, each once, p2 answered first (A4, Grok A2).
9. Card, timeout pause: build timeout set to 200 ms through the existing test hook; stub returns ASK; the script answers the card after 1 s with Allow. Expect the fake still alive when the answer lands and the turn to finish (A7, Grok A3).
10. Card queue: two ASK asks open at once; the registry shows the first; answering it shows the second; each answer goes to its own id.
11. Approver off, Approve in advance off: every ask is a card, nothing auto-allowed (A9).
12. Abandon while a card is open: expect the fake's process group gone within 5 s, the card cleared, and a late `skin:decide` returning false without a throw (A8).
13. The `result` line is parsed: run text set, `usage.inTokens > 0` on the run (A6, Grok A5).
14. Argv: the fake writes the argv it was started with to a file. The check asserts it contains `--permission-mode default`, `--permission-prompts host`, `--permission-prompt-tool stdio`, `--setting-sources user`, `--strict-mcp-config`, `--disallowedTools Task,Agent`, and a `--settings` JSON whose `permissions.ask` lists all eleven tools, and does not contain `bypassPermissions` (Grok A11).
The build timeout used in case 9 comes from `FactoryDeps.opusTimeoutMs`: `opusBuildTurn` reads `d.opusTimeoutMs ?? OPUS_REVIEW_TIMEOUT_MS`, the same hook the reviewer reads. `check-factory.ts`'s pin on the builder's `bypassPermissions` argv is replaced by the new argv.

**A-live: `scripts/check-opus-asks-live.ts`.** Real signed-in `claude`, started through the real `opusBuildTurn` (the exported controller, the same entry as A-fixture, `claudeBin` the real binary), so the argv is whatever production builds; the script does not carry its own flag list (Grok A11). Joe's machine only. It makes a temp git repo inside a trusted folder (argument, default `/Users/joewine/Projects/brain/brain`; probed today: a subfolder of a trusted project is trusted, so its settings load) with `.claude/settings.local.json` that allows `Bash(echo:*)` and a PreToolUse hook that returns `allow` and touches a marker file. The brief asks Opus to run `echo live-ok`, read `README.md`, and write `out.txt`. Expect: all three arrive as `can_use_tool` (Bash, Read, Write); the marker file does not exist (the project hook never ran, proving `--setting-sources user`); `out.txt` exists after Brain allows it; usage parsed. Dropping the ask rules makes `echo` skip the host (probed); dropping `--setting-sources user` makes the hook run (probed). The temp folder is removed at the end.

Artifact: `plans/20261007-opus-asks-check.txt` with one line per case (tool, kind, route, verdict, who, response id) and the live probe's three lines plus the marker result. Both scripts exit 1 on any mismatch.

### Files for A

src/main/factory/opus.ts, src/main/factory/controller.ts, src/main/factory/gates.ts, src/main/acp-session.ts, src/main/skin/ipc.ts, scripts/check-opus-asks.ts, scripts/check-opus-asks-live.ts, scripts/check-factory.ts.

---

## Unit B. After a push, Brain watches the host and offers Deploy when nothing started

### Behavior when done

1. After any successful push of a run's commit (Push, Push anyway, Ship in advance, and the "Let's get this live" door), Brain watches GitHub for that exact commit sha with the person's own `gh` login. It calls the real `gh` (PATH without the Factory shim dir, `GH_PROMPT_DISABLED=1`). It does not depend on `hostDeploy`: a host that reports to GitHub shows up even with no local link file.
   Signals, read every 10 s: `repos/{o}/{r}/deployments?sha=` with each deployment's newest status; `commits/{sha}/status` statuses; `commits/{sha}/check-runs`. A deployment, or a status or check whose context or app names a host (vercel, netlify, railway, render, cloudflare, fly), counts.
   Verified today on two real Vercel repos: arc-marketplace main and lotline 8fe5f16 (Joe's run-5073ec51 push) both show a `Production` deployment by `vercel[bot]` with a success status and a `Vercel` commit status with the URL. Netlify and Railway are assumed to report the same way; when they do not, the honest fallback below applies.
2. The run gets one field, a tagged union (shared/factory.ts):
   `deployWatch?: { state: 'watching', since } | { state: 'building', host, env?, url?, since } | { state: 'live', host, env?, url?, at } | { state: 'failed', host, env?, url?, at } | { state: 'none', at } | { state: 'unknown', why, at }`
   A pure reducer turns the three GitHub responses into the next state. No signal for 3 minutes after the push gives `none`. Building for more than 20 minutes gives `unknown` ("still building after 20 minutes, check the host"). No `gh`, `gh` not signed in, or a remote that is not github.com (https, git@, ssh:// forms parsed) gives `unknown` with that reason, at once.
3. The existing ship block (FactoryPane, `factory-ship`) shows one line from that state, in the place the `deployHint` line sits today: "Watching for a deploy...", "Vercel is building production...", "Live on Vercel: <url>", "Vercel deploy failed: <url>", "No deploy started in the 3 minutes after the push.", "Brain can't watch this host: <why>". The run thread gets the same lines as events, and the watcher card (Unit C) carries the state.
4. Deploy button (already in the ship block after a push): disabled with the reason while `watching` or `building` and once `live`; enabled on `none`, `failed` or `unknown`. Command: the repo's saved deploy command when there is one, else the linked host's standard command: Vercel `vercel deploy --prod --yes` on main or master, else `vercel deploy --yes`; Netlify `netlify deploy --build --prod` or `--build`; Railway `railway up --detach`. The standard command is only offered when the work tree is clean (`git status --porcelain` empty) and HEAD is the pushed sha, because these CLIs upload the folder, not the commit; otherwise the button says why it is off. The click confirms with the exact command. Kennel stays refused (KENNEL_DEPLOY_REFUSAL).
5. "Let's get this live" (shipRun): commit, push, start the watch, and return as soon as the watch has started, so the conductor answers at once. What happens when the watch settles:
   - `none` (nothing started in 3 minutes): Brain runs `deployRun`.
   - `unknown` because Brain cannot watch (no `gh`, `gh` signed out, or a remote that is not github.com): Brain runs `deployRun` straight away, the same as today's ship. These repos keep deploying.
   - `unknown` because it was still building after 20 minutes: no deploy.
   - `building` or `live`: no deploy (the host is doing it).
   - `failed`: no automatic deploy. The line says the host's deploy failed and the Deploy button is on for Joe.
   `deployRun` still refuses Kennel and a missing command exactly as today.
6. A watch that was running when the app quit is not resumed on its own. The ship block shows "Check deploy again" for a `watching` or `building` state with no live poller; the click runs one watch. Abandoning the run stops its watch.

### Ways B can fail

B1. The Factory gh shim answers the watch's `gh` calls, so the watch always says it cannot watch.
B2. A deployment for another sha, or another environment, is read as this push being live.
B3. The watch says `none` because the host is slow, Joe clicks Deploy, and the host also deploys (double deploy).
B4. The standard command ships uncommitted or untracked files, or a commit other than the pushed one.
B5. Polling never stops: after the app quits, after `live`, or after abandon.
B6. A non-GitHub or SSH-alias remote crashes the parser or watches the wrong repo.
B7. `shipRun` blocks the conductor for minutes, or double-deploys when the host started one.
B8. The Deploy button is enabled while the host is building, or stays disabled after `none`.
B9. Push and Deploy themselves change (refusals, Kennel, protected branches) beyond the watch.

### End-to-end checks for B

**B-flow: `scripts/check-deploy-watch.ts`.** Every case starts the watch through the real `publishRun` or `shipRun` on a run record (temp userData, temp git work repo, local bare remote as the push target), never by calling the reducer directly (Grok B1). The work repo's `origin` has `url = https://github.com/acme/site.git` and `pushurl = <local bare path>`, so the push is local and the watch parses a GitHub repo. A fake `gh` on PATH (and the Factory shim dir first on PATH, as in the Factory env) answers from a scripted timeline per case and logs every call with its arguments. Poll interval and windows are shortened through test hooks.
1. Push, then the fake returns: nothing, then this sha `in_progress` (Production), then `success` with a URL. Expect `watching`, `building`, `live` with host, env and URL; the fake gh, not the shim, answered (B1 shim case); every deployments call carried `sha=<pushed sha>`; no gh call after `live` (B5).
2. Wrong sha: the fake returns two deployments, this sha `in_progress` and another sha `success` (and returns both even when asked with `sha=`). Expect `building`, never `live` (Grok B4).
3. No signal for the shortened window: `none`; `deployBlockFor` null (Deploy on); with no saved command and a linked `.vercel/project.json`, the standard command is `vercel deploy --prod --yes` on main.
4. Standard command gates: dirty tree gives the dirty-tree refusal; clean tree with HEAD not the pushed sha gives the moved-HEAD refusal (Grok B5).
5. Abandon during `building`: no gh call after abandon (Grok B3). Also after `live` and after `none`.
6. Not GitHub: `pushurl` and `url` both local. Expect `unknown` with the reason at once, no gh call.
7. `gh` missing from PATH: `unknown` ("GitHub CLI") at once.
8. shipRun, host deploys: fake returns `building`. Expect `shipRun` to resolve before the watch settles (the promise resolves while the fake is still at `watching`), and the deploy spy to stay at 0 after `live` (Grok B2, B7).
9. shipRun, nothing started: `none`, then the deploy spy is called exactly once.
10. shipRun, cannot watch (case 6 remote): deploy spy called once, at once.
11. shipRun, host `failed`: deploy spy 0; Deploy button on.
11b. shipRun, stuck build: the fake holds this sha at `in_progress` past the shortened 20-minute window. Expect `unknown` ("still building"), deploy spy 0, Deploy button on (Grok B10).
11c. shipRun with `gh` missing from PATH: `unknown` ("GitHub CLI") at once and deploy spy called exactly once, at once (Grok B10).
12. Deploy button state per watch state: `watching` and `building` and `live` disabled with their sentences; `none`, `failed`, `unknown` enabled (B8).
13. Live read, real `gh`: lotline sha 8fe5f16 (Joe's own push) reads `live`, host Vercel, env Production, with the URL, on the first poll.
`conductor.test.ts`'s ship test (local bare remote, `deploys === 1`) is updated to wait for the async deploy; it stays one deploy.

Artifact: `plans/20261007-deploy-watch-check.txt`, one line per case with the states seen, gh call count after the end state, the deploy spy count, and `deployBlockFor`. Exits 1 on any mismatch. Plus `render-ui factory` frames for the six states, each asserting the line text and whether Deploy is enabled.

### Files for B

src/main/factory/deploy-watch.ts (new: remote parse, gh calls, reducer), src/main/factory/controller.ts (publishRun, shipRun, deployBlockFor, deployRun, abandonRun), src/main/factory/gates.ts (standard host command, clean-tree check), src/main/factory/ipc.ts and src/preload/index.ts (Check deploy again), src/shared/factory.ts, src/renderer/src/FactoryPane.tsx (the ship block line and button state only), src/renderer/src/factory-thread.ts, scripts/check-deploy-watch.ts, scripts/render-ui/factory.tsx.

---

## Unit C. The Grok watcher stays available after the run ends

### Behavior when done

1. On a `done` or `abandoned` run the composer stays where it is, with the placeholder "Ask about this run". Pause and Abandon stay hidden on finished runs.
2. `conduct` on a finished run checks the phase before anything else (before `conductorIntent`, before `queueInject`, before `runDoor`) and treats every sentence as a question to the run's Grok watcher (the `-orch` tab, watch-only: reads allowed, everything else refused, as today). Doors (pause, resume, ship, overrides, add-to-the-run) do not act on a finished run. A `FACTORY_TELL` line from the model is dropped and the answer ends "This run is over, so nothing was sent. Start a new run for that." The run's phase, guide list and work repo do not change, except the Q and A note appended to the thread.
3. The card for a finished run adds what happened, each part capped: commit sha and branch, push, deploy watch state, files changed (audit, up to 40 rows), verify rows, strict review status and the first 1500 characters of its text, ask counts and the last 10 asks, the plan's first 1500 characters, and the last 40 events. The prompt line "Do not run commands or open files" becomes, for finished runs only, "You may read files in the work repo to answer. Do not edit or run commands."
4. After an app restart the watcher warms on the first send (the existing `talk()` path).

### Ways C can fail

C1. "Add a dark mode toggle" on a done run guides, resumes, or re-opens the run.
C2. The composer shows but sends fail with "This run is over".
C3. The orch tab is dead after a restart and the send hangs.
C4. The card grows past what a prompt can carry (an unbounded diff or event list).
C5. Pause or Abandon reappear on a finished run.

### End-to-end checks for C

**C-fixture (node test, fake driver as in conductor.test.ts):** on a `done` run and an `abandoned` run, send "add this to the run" (the inject phrase), "Let's get this live", "Pause this run.", "Resume this run." and "Add a dark mode toggle" with the fake model returning a `FACTORY_TELL:` line. For each, expect: phase unchanged, no guide item added or marked sent (only the Q and A note), no queued inject, no commit, push or deploy call, work repo `git status` and HEAD unchanged, and the reply ending with the nothing-was-sent sentence (Grok C2).
**C-size (node test):** `conductorPrompt` for a done run with 41 audit rows, a 20,000-character strict review, a 20,000-character plan, 50 asks and 50 events. Expect the card to hold at most 40 audit rows, 1500 review characters, 1500 plan characters, 10 asks and 40 events, and the whole prompt under 16,000 characters (Grok C1).
**C-live: `scripts/check-watcher-after-run.ts`:** copy Joe's real run-5073ec51 (done, pushed) into a temp userData and call `conduct` through the real Grok ACP watcher with "What did this run change, and did the review pass?" Expect an answer that names a file from the run's audit and the review status, and phase still `done`. Then "Add a dark mode toggle to the map page." Expect phase `done`, no guide item marked sent, and the reply ending with the nothing-was-sent sentence. Artifact: `plans/20261007-watcher-after-run.txt` with both answers and the before/after phase and guide counts.
**C-render:** a `render-ui factory` frame of a done run asserting the composer is present with the placeholder "Ask about this run" and that Pause and Abandon are absent.

### Files for C

src/main/factory/conductor.ts, src/renderer/src/FactoryPane.tsx (composer condition and placeholder only), scripts/check-watcher-after-run.ts, scripts/render-ui/factory.tsx.

---

## Unit D. The task can be opened to its full text

### Behavior when done

1. The run header's title (`run.title`, the first line cut at 72 characters) stays where it is and looks the same. Beside it, a small text toggle "Show task" / "Hide task" opens a block directly under the title row with the full `run.task`, whitespace and line breaks kept, long words wrapped, and a max height with its own scroll for very long tasks.
2. Closed by default. Opening one run does not open another run's task.
3. Nothing else in the header moves: the chips row, Pause and Abandon keep their places.

### Ways D can fail

D1. A long unbroken line overflows the pane.
D2. The open state carries over to the next run.
D3. Header buttons shift, or the title's look changes.
D4. The block shows the cut title, not the full task.

### End-to-end check for D

`render-ui factory`, all assertions from the DOM, artifact the PNGs plus the assertion output:
1. A **build-phase** run (so Pause and Abandon render) whose `task` is Joe's real 595-character lotline task from run-5073ec51. Closed and open frames. The `h3` text equals `run.title` in both. The open block's text equals `run.task` exactly. The Pause and Abandon bounding boxes are identical in the two frames (Grok D1).
2. Open the toggle on that run, then mount a second run in the same pane: its block is closed (Grok D2).
3. A run whose task has a 400-character unbroken token and 80 lines: open block `scrollWidth <= clientWidth`, and the block scrolls on its own (`scrollHeight > clientHeight`, computed `overflow-y` is `auto`) inside its max height (Grok D3).

### Files for D

src/renderer/src/FactoryPane.tsx (header only), the Factory stylesheet, scripts/render-ui/factory.tsx.

---

## Also

- `node --test` on the factory tests, `npm run typecheck`, `scripts/check-factory.ts` (FACTORY_PASS) and `render-ui factory` stay green after each commit.
- GOAL.md gets one line per unit; the agency brain backlog item `factory-opus-builder-asks` is checked off with A's commit. Preview-branch pushes are not watched in B; that goes on the backlog as `factory-watch-preview-deploys`.

---

Review: Grok 4.6 xhigh plan review REJECT (15 items), REJECT (2 new: A11, B10), APPROVE round 3 (2026-10-07).
