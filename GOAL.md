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

Default Chat effort is **high** (Joe’s TUI stays extra high). Cursor Chat defaults to **ask** so it does not edit unless they switch to agent.

Writes stay blocked for Chat unless the user picks a mode that allows them (Grok `--deny Write/Edit`, Claude disallowed tools, Codex read-only sandbox, Cursor ask).

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
- Slash: ACP `available_commands_update` is the session catalog (TUI chrome filtered). Session commands send `/name` on the live session (`/compact` pattern). App jobs are real (`/rename`, `/export` save dialog, `/resume` session/load + transcript, `/fork` `x.ai/session/fork`, `/delete` closes the tab). Grok-only: resume/login/logout/doctor.
- Drag/drop, paste (including screenshots), and Attach on Chat for images and docs. Grok/Cursor: ACP image + embedded resource. Claude: image + PDF document. Codex: localImage + inlined text docs. Pathless clipboard files stash under userData/drops. 20 MB cap.
- Times live in the right sidebar under Folder (collapsed to local time; click to compare Eastern, Central, Pacific). 12-hour US. DST via IANA. Not a titlebar strip.
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

**Signed Mac pack:** LIVE 2026-09-18. Grok 4.6 xhigh **APPROVE**. One-file arm64 dmg. Notarize still blocked until Joe yes.

## Hard rules

1. Stay on `main` in this repo. No feature branches here.
2. Do not steal Plyntr’s Agency Brain watcher. Dry-run stays the default in `npm run dev`.
3. Never print tokens, `config.json`, or API keys.
4. US English. No em dashes. No contrast framing. No Inter / Space Grotesk / Geist.
5. Close Chrome tabs you opened.
6. Do not spend money or ship a signed build until Joe says yes.
7. Typecheck green. For UI, click-check in the running Electron window.

## Now

Empty. Next Inbox items are large slices of their own: Windows, Brain Bridge wizard, auto-install. Wait for **next 3**.

## Inbox

Bugs and product gaps. One line each. Date + what.

- [x] 2026-09-17 Joe: Cursor send `Invalid params` from Grok `reasoning_effort`. Caps-driven Cursor pickers. Joe: Cursor chat works. Done: 2026-09-17.
- [x] 2026-09-17 Joe: ChatGPT/Codex model picker lists Grok’s two models. Effort from Codex `model/list` (`reasoningEffort`). Picker no longer falls back to Grok models. Done: 2026-09-17. Evidence: `slash.ts` gpt branch, `codex-app.ts` `listCodexCaps`. Joe should click-check the ChatGPT Model list.
- [x] 2026-09-17 Joe: Drag/drop, paste, and Attach images and docs in Chat (Grok, Cursor, Claude, Codex). Done: 2026-09-17. Grok 4.6 xhigh APPROVE. Evidence: `attach.ts`, composer drop/paste/Attach.
- [x] 2026-09-17 Joe: Titlebar clocks — local, Eastern, Central, Pacific — easy to compare. Done: 2026-09-17. Grok 4.6 xhigh APPROVE. Evidence: `WorldClocks.tsx`.
- [x] 2026-09-17 Joe: **All slash commands must work as real ACP/session calls.** Done: 2026-09-18. Grok 4.6 xhigh APPROVE. Evidence: `runSlash`, `acpResume`, `acpFork`, `available_commands_update`.
- [x] 2026-09-17: Chat tabs die on quit. Persist `userData/chats.json` by cwd, flush on quit, `session/load` / `thread/resume`. Done: 2026-09-17. Evidence: `persist.ts`, `acp-session.ts` resumeId.
- [x] 2026-09-17: Live context meter. Grok `_meta.totalTokens`, Codex `thread/tokenUsage/updated`. Done: 2026-09-17. Evidence: runmeta Context.
- [x] 2026-09-17 Joe: **Signed Mac app** (electron-builder + Apple notarization) so a newbie downloads one file. Done: 2026-09-18. Grok 4.6 xhigh APPROVE. Evidence: `npm run pack:mac` → `dist/Brain-0.1.0-mac.dmg`. Signed **Developer ID Application: Plyntr LLC (DWYL4KK53B)**. Notarized Accepted `bdca8cd7-f323-4280-9612-a65a262fc157`, stapled.
- [ ] 2026-09-17 Joe: **Windows app** with Windows paths for Agency Brain, CLI bins, and installers. Not a Mac build renamed.
- [ ] 2026-09-17 Joe: **Brain Bridge in this app.** Setup wizard (HQ + project brains, role permissions owner/scout/team) lands the person in this Chat with only what they are allowed. One walk, then they are in. Code today: `~/Projects/brain-bridge`, `docs/client-setup-wizard.html` in the agency brain.
- [ ] 2026-09-17 Joe: **Auto-install for newbies.** If Homebrew, Grok/Claude/Cursor/Codex CLI, or Agency Brain is missing, the wizard downloads and installs it (with Joe/user consent on spend). Zero technical skill after “download this app.” Detect, explain in one line, install, then Chat.

## Next

Empty until Inbox Now is drained. Optional terminal stays a toggle, not the product. GitHub remote for this repo when sharing the signed build.

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
