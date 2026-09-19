# Brain

This file is the working set. Open this repo, read this file, work **Inbox** then **Now**. When you land something, rewrite the matching lines here. Do not append a log.

**Repo:** `/Users/joewine/Projects/brain-app`  
**Start:** `npm run dev` (dry-run is on). `npm run typecheck` after edits.  
**Owner:** Joe Wine. First other user in mind: Jeen, on a Mac, not a terminal person.

## Product

One downloadable window that feels like Slack and has the power of the local AI CLIs (Grok, Claude, Cursor, Codex). Chat is the product. Terminal is optional and hidden by default.

A teammate installs this app, Agency Brain (Mike’s, for git sync), and one AI CLI they already pay for. They sign into that CLI as themselves. They land in Chat against the watched brain folder. They never need to see a TUI, scrape it, or share Joe’s login.

Agency Brain owns git. This app does not start a second watcher and does not rewrite `~/Library/Application Support/Agency Brain/config.json` unless Joe has set `BRAIN_APP_ALLOW_CREATE=1` and the machine has no watched path.

## How it talks to the CLIs

Keep one warm process per CLI and a session per chat tab. Do not spawn `grok -p` (or the others) on every send. Do not paste the whole thread back in.

| Chat | Transport |
| --- | --- |
| Grok | `grok agent --always-approve --no-leader stdio` (ACP) |
| Cursor | `cursor-agent --trust --workspace <cwd> acp` (ACP). Model ids look like `composer-2.5[fast=true]`. No `reasoning_effort` config option. Modes: ask / plan / agent. |
| Claude | `claude -p --input-format stream-json --output-format stream-json` (process stays up) |
| Codex | `codex app-server --listen stdio://` |

Pickers (model, effort, mode, folder) must follow what that CLI actually advertises. Do not send Grok fields to Cursor.

Default Chat effort is **high** (Joe’s TUI stays extra high). Cursor Chat defaults to **agent** so it can edit. Chat may write files in the watched folder (Grok no `--deny Write`, Claude Write/Edit allowed, Codex `workspace-write`). Google Ads and outbound mail still need a clear yes.

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
- Right sidebar: In use files, live Model / Effort / Mode / Folder. Folder switch is local to this window (recents in this app’s userData). It does not change Mike’s watched path.
- `/compact` goes to the live session. Auto-compact shows a wheel + “Compacting…” then a short note. Transcript on screen stays.
- Grok and Cursor model/mode pickers follow the live session. ChatGPT/Codex picker does **not** yet (still falls through to `grok models`).
- Slash: every `/` either does a real in-app job or is sent to the live session as the canonical name (aliases rewritten). TUI commands are not blocked. Grok catalog is in the `/` menu.
- Terminal is a separate tab (`+` → Terminal, or `/terminal`). It is a login shell, not Grok/Claude. Chat stays ACP.
- Settings: one company at the top (You are working on this company). Then job 1 company, job 2 brains for that company, job 3 people at that company. Buttons name the company. Stored in userData, not Agency Brain config.json.
- Drag/drop, paste (including screenshots), and Attach on Chat for images and docs. Grok/Cursor: ACP image + embedded resource. Claude: image + PDF document. Codex: localImage + inlined text docs. Pathless clipboard files stash under userData/drops. 20 MB cap.
- Times live in the right sidebar under Folder (collapsed to local time; click to compare Eastern, Central, Pacific). 12-hour US. DST via IANA. Not a titlebar strip.
- Auto-install: if Homebrew, Git, Agency Brain, or a CLI is missing, one setup screen lists them, pre-warns every permission dialog, then **Start setup** (one click) runs official installers in order and waits. Chat when Agency Brain is watching and at least one CLI is present. Joe’s already-set-up Mac skips to Chat.
- Long runs show a live Working strip (wheel, phase, elapsed time) plus a pulse on the chat tab. Tools update the phase. Setup polls use the same strip. The thread does not sit on a frozen Thinking label.
- Mac one-file installer: `npm run pack:mac` writes `dist/Brain-0.1.0-mac.dmg` (arm64). Signed Developer ID Application: Plyntr LLC. Notarized 2026-09-18.

## How Joe runs Inbox

Say **next 3** (or **run brain inbox**). That is the whole start.

1. Take **3 Inbox lines**, unless one line is a large slice (then that line is the whole slice).
2. Build on `main` in this repo. `npm run typecheck`. Click-check Chat in the running app.
3. **Review gate:** independent `grok -p` with **model grok-4.6** and **effort xhigh**. Last line must be `APPROVE` or `REJECT`. `APPROVE` only if it would ship unchanged. Max 2 fix cycles, then show Joe.
4. On APPROVE, that slice is live (this repo’s `main`, app restarted). Check off Inbox. Rewrite Now.
5. Stop. Joe says **next 3** again.

Do not start signed Mac, Windows, Brain Bridge, or auto-install in a 3-pack with Chat bugs. Those are their own slices (large). Do not notarize or spend without Joe’s yes.

**Large (one item = one slice):** all remaining slash ACP parity; signed Mac; Windows; Brain Bridge wizard; auto-install.

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

## Now

Shipping Brain 0.1.4 so Skin is in the installed app. Chat stays the default.

## Inbox

Bugs and product gaps. One line each. Date + what.

- [x] 2026-09-19 Joe: Skin catalog slice A — seed catalog + map StreamEvent kinds. ChatPane bubble path unchanged. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `src/shared/skin/`, `from-events.test.ts`.
- [x] 2026-09-19 Joe: Skin catalog slice B — Joe-only capture in userData/skin-captures. Settings review list. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: `src/main/skin/capture.ts`, Settings Skin captures.
- [x] 2026-09-19 Joe: Skin catalog slice C — opt-in Skin view + Raw drawer + PermissionAsk. Chat auto-approve unchanged. Done: 2026-09-19. Grok 4.6 xhigh APPROVE. Evidence: Chat|Skin switch, `SkinPane`, `RawDrawer`. Do not pack unless Joe says yes.

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
- Writing Agency Brain `config.json` on Joe’s machine (watched path is Plyntr).
- Sharing one AI login across the team (ToS).
- Union Alpha / OpenCode is not installed on Joe’s Mac; do not block on it.

## Out

- Iframing Agency Brain or dumping TUI chrome into Chat.
- A second git watcher.
- Replacing Command Centre.
- Training or scraping grok.com.
- Personnel notes in this app or the shared brain.
