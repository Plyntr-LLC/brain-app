# Brain

This file is the working set. Open this repo, read this file, work **Inbox** then **Now**. When you land something, rewrite the matching lines here. Do not append a log.

**Repo:** `/Users/joewine/Projects/brain-app`  
**Start:** `npm run dev` (dry-run is on). `npm run typecheck` after edits.  
**Owner:** Joe Wine. First other user in mind: Jeen, on a Mac, not a terminal person.

## North star

Joe, 2026-09-22. This is the product. Do not ship a setup that walks away from it.

Someone downloads Brain.app. One wizard. Three choices, then a code or an email that is already allowed. **Plyntr Brain setup** is Path B: `plyntr-brain-sync` on **Only select repositories** (never All repositories; a repo URL is not an install), Brain.app sync via worker git token, no Agency Brain.app required. **Plyntr Brain with Agency Brain sync** is Path A: setup code from Your Clients (Ads2AI), `agency-brain-sync`, Agency Brain.app when installed, tunnel and bridge gates for full seats as today. **Plyntr Brain local only** copies the client brain onto this computer and does not install GitHub apps or start a watcher. Chat can open without those apps. An owner or a scout can turn on GitHub sync later in Settings (organization, then Plyntr sync and Brain Bridge on that one repo). A project code on either Plyntr choice still opens the project folder. One watcher per folder (`activateWatching` OR `startBrainSync`, never both). A local folder starts neither. Chat stays closed until that path's required steps are actually finished.

The first time a new brain reaches chat, the folder on disk is the real repo, and the thread tells them how to start filling in the business.

## Product

One downloadable window that feels like Slack and has the power of the local AI CLIs (Grok, Claude, Cursor, Codex). **Skin is the default face:** Brain catalog paint over the live CLI. Chat is the ACP bubble toggle. **Show terminal** peels the skin to the real CLI TUI in a PTY (not a login shell). Terminal (`+` → Terminal) is a login shell, optional and hidden by default.

A teammate installs this app and one AI CLI they already pay for. They sign into that CLI as themselves. Brain.app copies their GitHub repo (`org/slug-brain`) and keeps it in sync. They land in Skin against that folder. **Show terminal is its own CLI session** (accepted). App `/` commands stay in Brain; other `/` commands are typed into that CLI. They never scrape the TUI into bubbles, and they never share Joe’s login.

Path A full seats use ads2ai git-token + `agency-brain-sync` (Only select repositories). Path B full seats use the brain-sync worker git token + `plyntr-brain-sync` and do not call ads2ai. Project seats use hq-sync / Brain Bridge (`plyntr-brain-bridge`) on mini folders. Switching brains (Joe superadmin) uses `switchBrain`. One watcher per folder: `activateWatching` when the folder is Path A and Agency Brain.app is installed, otherwise `startBrainSync`. Path B never calls `activateWatching`. Tokens are never logged or sent to the renderer.

## How it talks to the CLIs

Skin paints catalog cards over a live CLI PTY. Chat keeps one warm ACP (or stream-json / app-server) process per tab. Composer Send for ordinary messages goes to that ACP session so the skin has a thread. **Show terminal** is a separate CLI TUI. In Skin, `/` that Brain does not handle is typed into that TUI (`/theme`, `/vim-mode`, `/fullscreen`, `/dashboard`, skills). Do not spawn `grok -p` (or the others) on every send. Do not paste the whole thread back in.

| Face | Transport |
| --- | --- |
| Skin | Catalog thread is ACP. **Show terminal** is a separate CLI TUI (accepted). Skin `/` except app commands goes into that TUI. |
| Chat / Grok | `grok --cwd <folder> --trust agent --always-approve --leader --leader-socket ~/.grok/leader-brain-app.sock stdio` (ACP). `--trust` loads project `.grok/hooks/`. Isolated from the default `~/.grok/leader.sock`. Falls back to `--no-leader` if that leader does not start. |
| Cursor | `cursor-agent --trust --workspace <cwd> acp` (ACP). Model ids look like `composer-2.5[fast=true]`. No `reasoning_effort` config option. Modes: ask / plan / agent. |
| Claude | `claude -p --input-format stream-json --output-format stream-json` (process stays up) |
| Codex | `codex app-server --listen stdio://` |

Pickers (model, effort, mode, folder) must follow what that CLI actually advertises. Claude reads this Mac’s plan list (not Grok). Do not send Grok fields to Cursor.

Default Chat effort is **high** (Joe’s TUI stays extra high). **Claude** Chat defaults to **Opus 5.5** (`claude-opus-5-5`) at **low** effort, not Fable and not `~/.claude/settings.json`. Cursor Chat defaults to **agent** so it can edit. Chat may write files in the watched folder (Grok no `--deny Write`, Claude Write/Edit allowed, Codex `workspace-write`). Google Ads and outbound mail still need a clear yes.

Each person uses their own CLI login. Never bake a Plyntr SuperGrok (or Cursor) account into the app.

## Checkpoint (rollback here)

**Tag: `working-chat-2026-09-17`** (`33275f2`)

Joe 2026-09-17: Grok, Cursor, and ChatGPT chats send. Compact UI, warm sessions, folder switch, Grok/Cursor pickers. ChatGPT model picker still lists Grok’s two models; ChatGPT effort is not Codex’s. If a later pass wrecks Chat, roll back:

```
git checkout working-chat-2026-09-17
```

Do not rewrite this section except to add the commit hash after the tag exists.

## Already true (do not rebuild)

- Electron + electron-vite + React. Chat-first workspace. Skip 6-digit setup when Agency Brain is already watching.
- Warm Grok/Cursor ACP, Claude stream-json, Codex app-server. Process prewarm on launch for Grok.
- Structured chat events: thought, text, files, compact status. Markdown tables in brain bubbles.
- Right sidebar: In use files, live Model / Effort / Mode / Folder. Folder recents live in this app’s userData. **Settings → Switch brain** (Joe superadmin) also points Agency Brain and Plyntr project sync at that folder (one watcher each).
- `/compact` goes to the live session. Auto-compact shows a wheel + “Compacting…” then a short note. Transcript on screen stays.
- Grok and Cursor model/mode pickers follow the live session. Claude model picker reads this Mac’s Claude plan list. ChatGPT/Codex picker uses Codex `model/list`.
- Slash: every `/` either does a real in-app job or is sent on. Chat leftover `/` goes ACP. Skin leftover `/` is typed into the peel TUI (`/theme`, `/vim-mode`, `/fullscreen`, `/dashboard`, skills). Grok catalog is in the `/` menu.
- Skin default is catalog paint. Chat toggle is ACP bubbles. **Show terminal** is a separate CLI TUI (accepted). Terminal (`+` → Terminal, or `/terminal`) is a login shell, not Grok/Claude.
- Settings: one company at the top (You are working on this company). Joe superadmin: Switch brain retargets Agency Brain and Plyntr project sync. Add a company brain: paste the Ads2AI code. Setup if GitHub is missing, clone if the repo exists. Add users and Catalog school stay collapsed. Other people do not get the switcher.
- Drag/drop, paste (including screenshots), and Attach on Chat for images and docs. Grok/Cursor: ACP image + embedded resource. Claude: image + PDF document. Codex: localImage + inlined text docs. Pathless clipboard files stash under userData/drops. 20 MB cap.
- Times live in the right sidebar under Folder (collapsed to local time; click to compare Eastern, Central, Pacific). 12-hour US. DST via IANA. Not a titlebar strip.
- Auto-install follows the active folder. Path A still lists Homebrew, Git, Agency Brain, Cloudflare Tunnel, a CLI, `agency-brain-sync`, and Brain Bridge for full seats. Path B lists Homebrew, Git, one signed-in CLI, and a status row for `plyntr-brain-sync` on that repo. Chat opens only after that path's gate. A Mac that already has that folder skips to Chat.
- Long runs show a live Working strip (wheel, phase, elapsed time) plus a pulse on the chat tab. Tools update the phase. Setup polls use the same strip. The thread does not sit on a frozen Thinking label.
- Mac one-file installer: `npm run pack:mac` writes a signed arm64 dmg. Latest packed: **0.1.60**. Developer ID Application: Plyntr LLC. A website link opens in the browser, and Settings shows the local roster before the network. A missing Brain Bridge answer does not stop GitHub sync. All repositories still does. Adding a company asks for Starter, Standard, or Growth, and superadmin can change that plan later. Starter stops at the owner and two other people.
- Phone: Settings → Phone starts a loopback listener, `caffeinate -dims`, and a Cloudflare tunnel (named host `brain-phone.plyntr.com` when configured). Scan the QR or type the 6-digit code to link a phone. Linked phones stay until Remove.

## How Joe runs Inbox

Say **next 3** (or **run brain inbox**). That is the whole start.

1. Take **3 Inbox lines**, unless one line is a large slice (then that line is the whole slice).
2. Build on `main` in this repo. `npm run typecheck`. Click-check Chat in the running app.
3. **Review gate:** independent `grok -p` with **model grok-4.6** and **effort xhigh**. Last line must be `APPROVE` or `REJECT`. `APPROVE` only if it would ship unchanged. Max 2 fix cycles, then show Joe.
4. On APPROVE, that slice is live (this repo’s `main`, app restarted). Check off Inbox. Rewrite Now.
5. Stop. Joe says **next 3** again.

Do not start signed Mac, Windows, Brain Bridge, or auto-install in a 3-pack with Chat bugs. Those are their own slices (large). Do not notarize or spend without Joe’s yes.

**Large (one item = one slice):** all remaining slash ACP parity; signed Mac; Windows; Brain Bridge wizard; auto-install; phone remote (Cloudflare Tunnel, Mac on).

**First slice:** LIVE 2026-09-17. Grok 4.6 xhigh **APPROVE**. Codex pickers, context meter, persist chats.

**Slash ACP:** LIVE 2026-09-18. Grok 4.6 xhigh **APPROVE**.

**Signed Mac pack:** LIVE 2026-09-18. Grok 4.6 xhigh **APPROVE**. Signed + notarized dmg. Download: GitHub Releases.

## Hard rules

1. Stay on `main` in this repo. No feature branches here.
2. Do not steal Plyntr’s Agency Brain watcher. Dry-run stays the default in `npm run dev`.
3. Never print tokens, `config.json`, or API keys.
4. US English. No em dashes. No contrast framing. No Inter / Space Grotesk / Geist.
5. Close Chrome tabs you opened.
6. Do not spend money or ship a signed build until Joe says yes.
7. Typecheck green. For UI, click-check in the running Electron window.
8. Never hide Model or Effort. Those stay on screen. Do not gate them behind first-send, Jeen, or a “power UI” flag.

## Inbox

- [x] 2026-09-24 Joe: Client-brain seat packs. Replace the flat "10 agency team" cap with the commercial pack on that brain. Source sheet: `agency-brain/context/products/client-brain-offer-sheet.html`. No card and no per-seat charge in the app. Plyntr sets the pack when they pay. Changing the pack is how the cap lifts. Done: 2026-09-24. Evidence: Brain.app 0.1.59 selector; worker `ca08e234-f85c-439a-b7a6-10c89f671bf4` stores the plan. rose wine read back `standard`.

  Packs:
  - **Starter.** 3 people total: the owner plus two others. Count active owner, scout, and team seats, plus pending invites for those roles. The next Add user is refused. Copy: "Starter includes the owner and two other people. Standard is $4,000 setup, then $700 a month."
  - **Standard.** No people cap. Price on the sheet is $4,000 then $700/month. Do not meter seats.
  - **Growth.** No people cap. Price on the sheet is $5,000 then $1,000/month. Do not meter seats.

  Same on every pack: at most 2 builders (owner + scout) who can change playbooks. That cap stays. Project-only seats stay uncapped and do not count toward the Starter three.

  Unset pack (Plyntr's own brain, and any brain Plyntr has not marked): do not apply the Starter cap.

  Enforce in the worker mint path and in Settings Add user, with the same sentence. A client cannot raise their own pack.

## Now

- [x] 2026-09-22 Joe: Phase 3 package, scout removal, and code email. Settings on a Plyntr brain states the package: 2 builders, 10 agency team, project-only with no numeric cap. Checkout stays out. Remove Plyntr scout is only for a redeemed owner seat token. That calls `POST /v1/brains/:id/transfer` with the owner token, revokes the brain's scout email, and that seat's git token then fails. After Move to Plyntr sync, the scout seat on this Mac does not see the control, even when roles.json still says owner. A scout cannot run it. Creating a code still shows it once. When brain-sync mail is configured, the worker also emails the code. If mail is missing, the code still comes back and Settings says email did not send. The wizard and Settings do not call `auth:joinFolder`. That IPC stays for Path A. Typecheck is green. Worker deploy was not run.

- [x] 2026-09-22 Joe: Phase 2 write guard and Plyntr move. Agency team writes to `skills/` and `.team-config/` through Brain.app file helpers are refused. Owner and scout writes there succeed. The CLI can still write those paths until a later hook. Settings on an Agency Brain folder shows Move this brain to Plyntr sync for Joe. That action installs `plyntr-brain-sync`, writes `sync.json` mode `plyntr`, stores a scout seat token, and syncs with `/v1/git/token`. If Agency Brain is watching, the move stops before `startBrainSync`. The seat list shows a last-sync hint. Typecheck is green. Tests cover the guard and the move.

- [ ] 2026-09-22 Joe: Phase 1.5 Path B project seats. Settings on a Plyntr brain can mint a project code with project folders. The first project person runs Connect on that brain before the code is created. Connect is `POST /v1/brains/:id/bind` with the bootstrap scout or owner seat token. A platform login stays a platform login, so creating another company brain still uses that session. After an owner code is redeemed, that owner can Connect, and this Mac stores an hq owner session for that brain when it is not the platform login. The fork Project-only code is a 10-character field that resolves and joins the mini folder. The older email code is still on that screen. Worker `POST /v1/invites` accepts `role: project` plus roots, writes `.team-config/seats.json` as `client-project`, stores the plaintext code for `/auth/exchange`, and binds that email to the brain repo. A project mint and a project revoke refresh the HQ snapshot on that request, so `GET /seat` includes the new seat. `GET /v1/github/installed` includes `projectSeatCount`. Scout and owner can mint and revoke project seats. Dry-run Connect uses the same gate: a platform session or a team seat stays disconnected, and a bootstrap scout or owner seat reports connected and `projectSeatCount`. Settings does not call the production worker in dry-run. Typecheck is green. brain-sync tests are green. Worker deploy and migration `0002_plyntr_project.sql` were not run.

- [ ] 2026-09-22 Joe: Wizard fork. Path B create and join stay off ads2ai. Join clones with a git token and does not call ensure-repo. Dry-run does not call api.github.com on the GitHub steps. An empty GitHub repo (no HEAD) seeds with an initial commit. `/v1/github/installed` and `/v1/git/token` use only the `PLYNTR_BRAIN_SYNC` app credentials. Settings shows Recover scout token when the local seat token is missing on a Plyntr folder. The fork screen shows Continue setup and Continue join errors (platform gate, GitHub poll timeout, clone). Set up a new company brain and resume create open platform step 0 when signed out, or when a later wizard step has no platform session, and resume the scout account before leaving that step. Typecheck is green. brain-sync tests are green (130). Click-check of the fork is still open: the window on screen is the packed Brain.app, and this session cannot drive it. brain-sync D1 `brain-sync-plyntr` exists and migration `0001_plyntr.sql` is applied. Worker code deploy is still `scripts/deploy.cjs` and was not run. The workers API token cannot call the D1 API, so that deploy needs a token that can bind D1.

- [x] 2026-09-22 Joe: Brain Bridge (`plyntr-brain-bridge`) is a hard stop before chat. The wizard opens the install page and waits until `GET /github/installed` says that repo has the app. Only select repositories. Project seats skip it. Dry-run skips it.

- [x] 2026-09-22 Joe: If Agency Brain.app is on the machine, the clone writes its config (even the first profile) and does not also start our watcher. The tool list installs his app from this wizard. Chat still opens on our sync when his app is absent.

- [x] 2026-09-22 Joe: Setup does not treat a repo address as a GitHub install. The app stays on Install until GitHub says the app is installed, then it copies the folder.

- [x] 2026-09-22 Joe: Setup code clones when GitHub already has the repo. If it does not, the app opens GitHub to create the short name instead of asking for one. An empty folder is not opened as the brain. The name on screen is the folder name. A brand-new brain gets one welcome in chat that asks what the business does.

- [x] 2026-09-21 Joe: One app for all users. No Agency Brain.app required. Brain.app clones org/slug-brain and ff-only syncs. Project seats stay hq-sync. Done: 2026-09-21. Grok 4.6 xhigh APPROVE (cycle 3). Packed 0.1.32.



Skin is the face. Chat stays in the code, hidden. Terminal is a top tab only. Last tab can close after a confirm. Empty stage is the card color, not black. Claude tabs start on Opus 5.5 at low effort. Settings → Phone is a Cloudflare Tunnel remote of this Mac.

- [x] 2026-09-21 Joe: Phone WhatsApp-style pairing (QR, no email), named host stays, CLI picker on New, session list actually shows open chats. Done: 2026-09-21. Grok 4.6 xhigh APPROVE (cycle 2). Packed 0.1.23. Evidence: `phone-devices.json` + `/api/pair`, Settings QR/PIN, `#kind` New, full-width Open chats. Direct: https://github.com/Plyntr-LLC/brain-app/releases/latest/download/Brain-0.1.23-mac.dmg

- [x] 2026-09-21 Joe: Phone picker empty, New blinks, composer should match the Mac, show files being touched outside the Brain folder. New tab focuses the composer. No starter chips above the box. Restart to install must actually relaunch. Done: 2026-09-21. Grok 4.6 xhigh APPROVE (cycle 4). Evidence: v0.1.22.

- [x] 2026-09-21 Joe: Phone remote of this Mac from anywhere (cellular). Cloudflare Tunnel. Mac stays on. Secret-link hardening (hash `#t=&k=`, seal key ≠ Bearer, 12h, New/Close/attach/queue/stop). Named hostname `brain-phone.plyntr.com` + Access. Done: 2026-09-21. Grok 4.6 xhigh APPROVE. Evidence: v0.1.21, `src/main/phone.ts`, Settings Phone. Plan: agency-brain `plans/20260921-brain-phone-remote.md`.

- [x] 2026-09-20 Joe: Claude default is Opus 5 low, not Fable. Done: 2026-09-20. Grok 4.6 xhigh APPROVE (cycle 2). Evidence: v0.1.18, `claude-defaults.ts`, `claude-stream.ts` always `--model`/`--effort`.

- [x] 2026-09-20 Joe: Hide Chat (keep Skin). No Show terminal in Skin. Bigger +. Last tab can close. Confirm before close. No black empty stage. Done: 2026-09-20. Grok 4.6 xhigh APPROVE. Evidence: v0.1.17 signed+notarized, GitHub latest, `/Applications/Brain.app`. Direct: https://github.com/Plyntr-LLC/brain-app/releases/latest/download/Brain-0.1.17-mac.dmg

- [x] 2026-09-20 Joe: Jeen list. AB watching auto-continue. CLI login auto-start. Two-apps line. Empty-Skin starters. GitHub short name + paste. Hide power UI. Owner skip GitHub when repo exists. Setup checklist. Pack autoheal in the Jeen build. Done: 2026-09-20. Grok 4.6 xhigh APPROVE (cycle 4). Evidence: v0.1.16 signed+notarized, GitHub latest, `/Applications/Brain.app`. Direct: https://github.com/Plyntr-LLC/brain-app/releases/latest/download/Brain-0.1.16-mac.dmg

- [x] 2026-09-20 Joe: Claude model picker lists Grok 4.5/4.6. Title says Jeen-AI-Brain-test while the window is Plyntr. Add-company must not attach to Jeen. Wire pickers and folder to the CLI and brain in use. Done: 2026-09-20. Grok 4.6 xhigh APPROVE (cycle 2). Evidence: `listSlash` claude branch, `claude-models.ts`, `hq-folder.ts`, `watchingHealth`, Settings add-company copy.

- [x] 2026-09-20 Joe: Settings Welcome said jj ww (test company) and Loading waited on HQ/skin. Brain.app login name; paint after get+brains. Done: 2026-09-20. Grok 4.6 xhigh APPROVE. Evidence: packed 0.1.15 `/Applications/Brain.app`.

- [x] 2026-09-20 Joe: Setup that leaves Brain (GitHub, installers, AI sign-in) should bring you back. Only required fields. No skip of steps the app needs. Clear errors if something is blank. Done: 2026-09-20. Grok 4.6 xhigh APPROVE (cycle 2). Evidence: `watchClipboardOrg` + `stopClipboardOrgWatch`, `loginCliUntilDone`, FirstRun blank-field errors.

- [x] 2026-09-20 Joe: Switch brain hid after leaving Plyntr (login became the other brain’s email). Brain.app login stays; switcher still works both ways. Done: 2026-09-20. Grok 4.6 xhigh APPROVE. Evidence: v0.1.14 signed+notarized, GitHub latest, `/Applications/Brain.app`. Direct: https://github.com/Plyntr-LLC/brain-app/releases/latest/download/Brain-0.1.14-mac.dmg

- [x] 2026-09-20 Joe: Jev high-confidence unmatched screens join the catalog on their own (autoheal). Spend TypeSafe yes. PermissionAsk never Allow. Done: 2026-09-20. Grok 4.6 xhigh APPROVE (cycle 2). Evidence: `proposeFromCapture` + `setLearned`, `joeOnly` is `isJoeSuperAdmin`, PermissionAsk `paint: false` / `shouldLearn` false.

- [x] 2026-09-20 Joe: Turn Jev on for Skin. Propose catalog rows from unmatched captures. Do not Allow a write. Spend TypeSafe yes. Done: 2026-09-20. Grok 4.6 xhigh APPROVE. Evidence: `src/main/skin/jev.ts`, Settings Jev toggle, `skin.json` jev on.

- [x] 2026-09-20 Joe: New brain setup did not install Agency Brain Sync on the GitHub repo and did not clone the folder. Make it obvious and make it actually clone this team’s folder. Done: 2026-09-20. Grok 4.6 xhigh APPROVE. Evidence: `putFolder` adopt+ensure+clone; reuse only same slug; install URL `installations/new?state=`; GitHub steps numbered.

- [x] 2026-09-20 Joe: Start setup does nothing, GitHub org is not used, and Continue with GitHub sends me back to Shared folder ready (One setup). Done: 2026-09-20. Grok 4.6 xhigh APPROVE. Evidence: packed `dryRun` is only `BRAIN_APP_DRY_RUN`; Continue stays on GitHub then `abapply`; paste copy + `target_id`.

- [x] 2026-09-19 Joe: GitHub login in the in-app window does not support passkeys, so I cannot log in. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `openInApp` → `shell.openExternal`; poll unchanged.

- [x] 2026-09-19 Joe: While a turn is working, Queue works, but Send now and empty Enter do nothing. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `sendNow` stops the live turn then `sendText({ fromQueue: true, cancel: true })`.
- [x] 2026-09-19 Joe: Invite mail and the /install page send people to Brain.app, not the old Brain Bridge zip. Done: 2026-09-19. Grok 4.6 xhigh APPROVE (cycle 2). Worker deployed. Download for Mac starts the .dmg (no GitHub releases page). Evidence: `/install/mac` → `Brain-0.1.5-mac.dmg`.
- [x] 2026-09-19 Joe: Connect HQ from the watched folder. Open the Brain Bridge GitHub App if needed, wait until GitHub is done, then bind. First-run waits the same way for Agency Brain Sync. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `hqRepoFromFolder`, `ownerBindUntilReady`, FirstRun `pollInstall`.
- [x] 2026-09-19 Joe: Superadmin said only I can add a company but hid the form until a platform login. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: Settings Superadmin always shows the company fields; code sign-in in that same block.
- [x] 2026-09-19 Joe: Drop the leftover Railway Brain Bridge wizard. Welcome does not send people to the copier prompt. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: deleted `BridgeWizard.tsx`; Welcome/SetupNeeds no “Set up HQ and project brains”.
- [x] 2026-09-19 Joe: Sync health in the window (last sync, offline, error) plus a tray light (orange ok, grey not). Quitting the window must not stop the silent agent. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `paintHealth` + titlebar `sync-pill`; `src/main/tray.ts`; hide-on-close; no `uninstallAgentService`.

- [x] 2026-09-19 Joe: `/usage` popup shows real plan/session usage, not Loading and not Cursor `about`. Grok `grok usage` for this session. Cursor plan spend from this Mac’s Cursor login. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `slash.usage` → `cursorPlanBlurb` + `grok usage`; cmdpanel; no ACP `/usage`.

- [x] 2026-09-19 Joe: `/usage` (and `/cost`) goes to the live CLI session, like `/compact`. Grok and Cursor send `/usage` on the warm session. Other CLIs keep the account blurb. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `sendQuiet('/usage')` for grok/cursor.

- [x] 2026-09-19 Joe: Jeen setup. After missing bits, land in Skin with one place to type. Hide Chat / Show terminal / CLI jargon until she needs them. Sign in is a labeled button for that CLI. Done: 2026-09-19. Grok 4.6 xhigh APPROVE (cycle 2). Evidence: `showPower` / More, `I signed in. Start`, `Sign in to ${cliName}`, greeting without slash.
- [x] 2026-09-19 Joe: Empty Skin tells her what to send so the reply knows this brain folder. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: greeting + composer `Ask about this folder`.
- [x] 2026-09-19 Joe: After an update, one line that the app updated and chats are where she left them. Skin + Chat survive. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `recordLaunchVersion`, FirstRun `update-note`, `userData/chats.json`.

- [x] 2026-09-19 Joe: Skin Plan card is catalog-only. ACP already emits `plan`. Paint it. Done: 2026-09-19. Grok 4.6 xhigh APPROVE (cycle 2). Evidence: `onEvent` plan-per-turn, `SkinPane` Plan, Chat `ol.skin-plan`.
- [x] 2026-09-19 Joe: Skin ErrorNotice / LoginNeed are catalog-only. Error events paint as those cards. Sign in is wired. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `who: 'err'`, `specFromStreamEvent` error, Registry Sign in.
- [x] 2026-09-19 Joe: Skin Queue card is show-only. Composer queue is the live one. Drop the duplicate card. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: SkinPane no `queueSpec`; composer `followq`.
- [x] 2026-09-19 Joe: Skin ContextMeter is catalog-only. Context events already hit the sidebar. Show the meter on the Skin face too. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: Skin caption `ContextMeter`.
- [x] 2026-09-19 Joe: Chat permission is missing Always in this folder. Skin has it. Same three buttons, wired. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: Chat `alwaysAllowInFolder`.
- [x] 2026-09-19 Joe: PermissionAsk ignores CLI option ids. Buttons should be the CLI options (`selectOption` → decide). Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: Registry `p.options`, Chat option map, `selectOption`.
- [x] 2026-09-19 Joe: Settings Skin capture Label does not change paint. Labelled fingerprints choose that catalog row. Done: 2026-09-19. Grok 4.6 xhigh APPROVE (cycle 2). Evidence: unmapped `sessionUpdate` → `who: 'raw'` + `skinLabel`; `labelCapture` cache; SkinPane catalog override.
- [x] 2026-09-19 Joe: First-run rail/Invite/needs are leftover. Chat already hides the rail in CSS. Do not render them on chat. Invite is Settings. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: FirstRun aside only when `screen !== 'chat'`.

- [x] 2026-09-19 Joe: Skin is the default. Readable markdown. Isolated Grok leader + `/clear` session id + sys notes. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `SkinPane`, `grok-leader.ts`, `resetCli`.
- [x] 2026-09-19 Joe: Skin is full terminal (CLI TUI in Brain chrome), not catalog cards. Composer injects into that PTY. Chat stays ACP. Open raw / folder shell is gone. Done: 2026-09-19. Then Joe: that dropped the skin. Catalog is the face again; Show terminal peels to the CLI PTY. Evidence: `SkinPane` overlay + `SkinTerm`.

- [x] 2026-09-19 Joe: Skin catalog slice A — seed catalog + map StreamEvent kinds. ChatPane bubble path unchanged. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `src/shared/skin/`, `from-events.test.ts`.
- [x] 2026-09-19 Joe: Skin catalog slice B — Joe-only capture in userData/skin-captures. Settings review list. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `src/main/skin/capture.ts`, Settings Skin captures.
- [x] 2026-09-19 Joe: Skin catalog slice C — opt-in Skin view + Raw drawer + PermissionAsk. Chat auto-approve unchanged. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Packed as 0.1.4. Evidence: Chat|Skin switch, `SkinPane`, `RawDrawer`, GitHub v0.1.4, `/Applications/Brain.app` swapped.

- [x] 2026-09-19 Joe: 0.1.2 will not open. Main-process `Named export 'autoUpdater' not found`. Done: 2026-09-19. Evidence: v0.1.3 signed+notarized, GitHub latest, `/Applications/Brain.app` swapped and launched. Direct: https://github.com/Plyntr-LLC/brain-app/releases/latest/download/Brain-0.1.3-mac.dmg

- [x] 2026-09-19 Joe: Brain.app Chat send `Invalid params` (Cursor tab, composer-2.5 / Medium). Done: 2026-09-19. Evidence: v0.1.2 signed+notarized, GitHub release, `/Applications/Brain.app` swapped. Direct: https://github.com/Plyntr-LLC/brain-app/releases/latest/download/Brain-0.1.2-mac.dmg

- [x] 2026-09-17 Joe: Cursor send `Invalid params` from Grok `reasoning_effort`. Caps-driven Cursor pickers. Joe: Cursor chat works. Done: 2026-09-17.
- [x] 2026-09-17 Joe: ChatGPT/Codex model picker lists Grok’s two models. Effort from Codex `model/list` (`reasoningEffort`). Picker no longer falls back to Grok models. Done: 2026-09-17. Evidence: `slash.ts` gpt branch, `codex-app.ts` `listCodexCaps`. Joe should click-check the ChatGPT Model list.
- [x] 2026-09-17 Joe: Drag/drop, paste, and Attach images and docs in Chat (Grok, Cursor, Claude, Codex). Done: 2026-09-17. Grok 4.6 xhigh APPROVE. Evidence: `attach.ts`, composer drop/paste/Attach.
- [x] 2026-09-17 Joe: Titlebar clocks — local, Eastern, Central, Pacific — easy to compare. Done: 2026-09-17. Grok 4.6 xhigh APPROVE. Evidence: `WorldClocks.tsx`.
- [x] 2026-09-17 Joe: **All slash commands must work as real ACP/session calls.** Done: 2026-09-18. Grok 4.6 xhigh APPROVE. Evidence: `runSlash`, `acpResume`, `acpFork`, `available_commands_update`.
- [x] 2026-09-17: Chat tabs die on quit. Persist `userData/chats.json` by cwd, flush on quit, `session/load` / `thread/resume`. Done: 2026-09-17. Evidence: `persist.ts`, `acp-session.ts` resumeId.
- [x] 2026-09-17: Live context meter. Grok `_meta.totalTokens`, Codex `thread/tokenUsage/updated`. Done: 2026-09-17. Evidence: runmeta Context.
- [x] 2026-09-17 Joe: **Signed Mac app** (electron-builder + Apple notarization) so a newbie downloads one file. Done: 2026-09-18. Grok 4.6 xhigh APPROVE. Evidence: `npm run pack:mac` → `dist/Brain-0.1.0-mac.dmg`. Signed **Developer ID Application: Plyntr LLC (DWYL4KK53B)**. Notarized Accepted `bdca8cd7-f323-4280-9612-a65a262fc157`, stapled.
- [x] 2026-09-17 Joe: **Windows app** with Windows paths for Agency Brain, CLI bins, and installers. Done: 2026-09-18. Grok 4.6 xhigh APPROVE. Evidence: `agency-brain.ts` AppData paths, `pack:win` → `Brain-0.1.0-win.exe`. Unsigned. Download: GitHub Releases.
- [x] 2026-09-17 Joe: **Brain Bridge in this app.** Done: 2026-09-18. Grok 4.6 xhigh APPROVE. Evidence: `BridgeWizard.tsx`, welcome “Set up HQ and project brains”, role in titlebar, `userData/bridge.json`. Does not write Agency Brain config.json.
- [x] 2026-09-17 Joe: **Auto-install for newbies.** Done: 2026-09-18. Grok 4.6 xhigh APPROVE. Evidence: `install.ts`, FirstRun `needs` screen. Detect Homebrew/Git/Agency Brain/CLIs, tick to install official scripts, then Chat when watching + a CLI. Does not write Agency Brain config.json.
- [x] 2026-09-18 Joe: **One seamless setup.** Downloads/installs automatic or 1 or 2 clicks. Pre-warn before any permission/approval dialog. Done: 2026-09-18. Grok 4.6 xhigh APPROVE (cycle 2). Evidence: `SetupNeeds.tsx`, `install.ts` warn/accept/wait, Bridge/GitHub Before we start boxes. Does not write Agency Brain config.json.
- [x] 2026-09-18 Joe: **Settings is confusing.** Spell out what adding a person vs adding a brain means, where to add it, and that this Mac list does not email, create GitHub, or rewrite Agency Brain config. Done: 2026-09-18. Grok 4.6 xhigh APPROVE (cycle 2). Evidence: `SettingsPanel.tsx` Brains then People.
- [x] 2026-09-18 Joe: Long runs stay on Thinking and the rest of the app looks dead. Show waiting/working. Done: 2026-09-18. Evidence: `WorkPulse.tsx`.
- [x] 2026-09-18 Joe: Send while busy kills the turn. Queue like the TUI. Add on unless the follow-up says stop. Done: 2026-09-18. Evidence: queue in `TerminalWorkspace.tsx`.
- [x] 2026-09-18 Joe: While the reply is typing, let me scroll the message. Done: 2026-09-18. Evidence: pinBottom / Latest.
- [x] 2026-09-18 Joe: Settings still confusing. Company, brain, and person are different. Always know which company I am adding to. Done: 2026-09-18. Grok 4.6 xhigh APPROVE (cycle 2). Evidence: `SettingsPanel.tsx` sticky You are working on, jobs 1–3.
- [x] 2026-09-18 Joe: Chat must wait like Terminal. No 3-minute cutoff. Show working until the turn finishes or Stop. Setup must work for Grok, Claude, Cursor, and Codex (each CLI’s own login and session start). Done: 2026-09-18. Evidence: `line-rpc.ts` timeout 0 on session/prompt, per-CLI `loginCli`.
- [x] 2026-09-18 Joe: Sign in with email (Agency Brain codes). Log out without erasing chats, brains, or Agency Brain files. Identity drives Settings/superadmin. Done: 2026-09-18. Evidence: `session-token.ts` account.json, Log out in title bar and Settings.
- [x] 2026-09-18 Joe: Team login without Agency Brain / ads2ai. Email + shared folder + `.team-config/roles.json`. Done: 2026-09-18. Evidence: `auth:joinFolder`.
- [x] 2026-09-18 Joe: Wizard handles Brain Sync for every seat: clone via git-token when ads2ai membership exists, folder pick for team roster, pull/push when Agency Brain is not watching. Never steal an existing watcher. Done: 2026-09-18. Evidence: `clone.ts`, `brain-sync.ts`, `setup:applyFolder`.

## Next

Empty until Inbox Now is drained. Optional terminal stays a toggle, not the product. GitHub: `Plyntr-LLC/brain-app` public, Releases for Mac dmg and Windows exe.

## Blocked

- Publishing / notarization until Joe says yes.
- Sharing one AI login across the team (ToS).
- Union Alpha / OpenCode is not installed on Joe’s Mac; do not block on it.

## Out

- Iframing Agency Brain or dumping TUI chrome into Chat.
- A second git watcher.
- Replacing Command Centre.
- Training or scraping grok.com.
- Personnel notes in this app or the shared brain.
