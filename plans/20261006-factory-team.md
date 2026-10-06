# Factory as a team of engineers (framing, 2026-10-06)

Joe, 2026-10-06, after run-ae98e1f8: "It was supposed to operate as a team of software engineers that plans, builds, tests, verifies and then allows me to push the changes seamlessly. Not something that has blockades everywhere and we can't speak with it to direct or coax it." He also asked for the Factory tab's chat and status to be redesigned. That is an explicit redesign ask for this screen (AGENTS.md preference 13 allows it).

Mockups: `plans/mockups/20261006-factory/index.html` (A team chat, B pipeline board, C living plan), built from run-ae98e1f8.

## What went wrong on run-ae98e1f8 (evidence)

| Moment | What Joe saw | Cause |
| --- | --- | --- |
| Start | Work began in 360-seo-intake | "take" inside a folder name beat "lotoffice" (fixed in `54fcd32`) |
| Plan | Plan "approved" with empty text | Opus planned in the wrong repo; an empty plan was accepted |
| Build | "This turn changed no files", run paused | An empty turn pauses instead of retrying or asking |
| Chat | Same status card 3 times; "I did not send that" | Answers cancelled each other; directions needed magic words (fixed in `54fcd32`) |
| Chat | "Type exactly `Resume this run.`" | Exact-phrase doors (fixed in `54fcd32`) |
| Chat | "It will not deploy" | False; the card had no push facts (fixed in `54fcd32`) |
| Test | typecheck and e2e "skipped" silently | No script means skip, with no substitute and no word to Joe |
| Push | Push button failed | A local guard added in this session blocked the click; removed |
| Throughout | Raw tool text in a grey box, warnings stacked as lines | The run view shows plumbing, not the team's work |

## Definition of done (checkable)

1. Replaying run-ae98e1f8's task in the Factory reaches Ready to push in lotline with no manual stop except the push itself, and the replay's chat shows the Lead's repo statement, the plan, the builder's changes, the test result, every review round, and a Push that works. Checked by a scripted replay against a lotline fixture with fake models (`scripts/check-factory.ts` style) plus one live run in `npm run dev`.
2. Every stop the controller can make today (`needsPrep` dirty, `needsProceed` critical, tier `upgrade`, review cap, voice cap, empty turn, unchanged diff, plan rejected 3 times, lock held, Grok and Cursor down, push blocked) shows up as a Lead message with a recommended button and a plain sentence. None of them requires an exact phrase. Checked by a table-driven test that forces each stop and asserts the message and the button.
3. Anything Joe types reaches the Lead, and the Lead can: answer, redirect the builder, move repos (and re-plan), add or drop a job, skip a step, pause, resume, and push. Checked by the transcript-replay test extended with each verb.
4. Push from the Factory works on Joe's click on any branch, says what the push triggers (host deploy detected from `.vercel/project.json`, `railway.json`, `netlify.toml`), and offers a preview branch. Ship in advance never auto-pushes a branch a host deploys; it stops at Ready to push. Checked by tests with a fake host-linked repo and a real bare remote.
5. The Tester never silently skips: a missing `typecheck` runs `tsc --noEmit` when there is a tsconfig; a missing `e2e` is stated in the chat. Checked by verify tests.
6. The Factory tab shows the chosen layout, with no raw tool dump in the main view. Checked by screenshots of the dev app at each stage, compared to the mockup.

## Scope and phases (each phase: xhigh-gate plan and diff, a prerelease pack only on Joe's yes)

1. **Lead acts (behavior, ~1 day).** Holds become Lead questions with buttons; empty turn retries once with a nudge before asking; an empty plan is never approved; a repo move before any build re-plans in the new repo (backlog `factory-replan-on-repo-move`); the Lead states the repo and its confidence in its first message.
2. **Push that works (~0.5 day).** Host-deploy detection, Push always runs on Joe's click, preview-branch option, Ship in advance stops at Ready for deploying branches (backlog `factory-ship-in-advance-host-deploy-warn`).
3. **Tester that tests (~0.5 day).** tsc fallback, stated skips, the test summary as a card.
4. **The Factory tab (UI, ~1.5 days).** The chosen direction. The thread is built from run events the controller already records (guide, usage, live, verify, strict, audit), plus a new event list where they are missing.

Rigor: high. Factory runs push to production repos (lotline main is Vercel production). Every phase gets the failing-first test, the xhigh gate on plan and diff, FACTORY_PASS, and a dev-app click-through before any pack.

## Decisions

- 2026-10-06 Joe: layout **A** ("Option A is fantastic"). Build it with C's job checklist as the rail's Progress box.
- 2026-10-06 Joe: the other tabs get the same idea: "the right side bar would show what it is doing rather than showing In use files." Mockup D. Chat tabs already receive what the rail needs: `status` `work:<label>` (current tool action), `plan` steps with status (Grok and Cursor ACP), `thought` vs `text`, `permission`, `context` use, and `file` hits.

## Order of work (revised for A and D)

1. **Run events and one rail component.** A run keeps a timeline of events (repo chosen, plan, each build turn's files, test rows, each review round's verdict and findings, each hold, commit, push). One `ActivityRail` component renders Now, Plan or Progress, Done so far, Files (folded), Session. Factory and Chat feed it different data.
2. **Factory tab as A.** The thread from guide notes plus run events, with Planner, Builder, Tester and Reviewer cards; every current hold rendered as a Lead question with the existing buttons; the rail with Progress, Team, Changed files, Ship.
3. **Chat tabs as D.** The right rail swaps In use for the activity rail; the model, effort, folder pickers stay at the bottom of the rail.
4. **Lead acts** (phase 1 above). 5. **Push that works** (phase 2 above). 6. **Tester that tests** (phase 3 above).
