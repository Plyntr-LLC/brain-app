# V1 spec: Brain app

- **Slug:** `brain-app`
- **Repo:** `/Users/joewine/Projects/brain-app/`
- **Stack:** Electron + electron-vite + React + TypeScript. Main process owns ads2ai, git clone, Agency Brain launch. Renderer is the room (mock UI).
- **Start:** `npm run dev` → Electron window (also a renderer URL on localhost for click-check)
- **Design source:** `plans/brain-first-run.html` (copy into repo as `docs/mock.html`)
- **Date locked:** 2026-09-17

## Goal

A Mac desktop room where an owner or scout signs in with the same email code Agency Brain uses, names the business, connects a GitHub **organisation**, and we feed `api.ads2ai.com` the same calls Mike’s wizard makes (create team, GitHub App, ensure repo, clone). Agency Brain is installed/launched in the background to **watch** that folder. Then they pick Claude, Grok, or ChatGPT, and the same window becomes a chat whose first job is an AI-driven interview from a needs list.

They never open Agency Brain’s wizard if the mapped path works. They never see a terminal.

## How we feed Agency Brain (the golden path)

Mike’s app (v1.1.36) is Electron. Its wizard is IPC onto `https://api.ads2ai.com`. There is **no** setup API to drive the wizard UI, and `agencybrain://` only deep-links invite tokens. We do not iframe it.

We call the same HTTP endpoints with the member’s OTP token:

| Step | Endpoint |
|---|---|
| Email code | `POST /api/auth/request-code` `{ email, app: true }` |
| Verify | `POST /api/auth/verify-code` `{ email, code }` → `{ token, member }` |
| Teams | `GET /api/team-brain/my-teams` |
| Create agency | `POST /api/team-brain/create-team` `{ name }` |
| Install status | `GET /api/team-brain/install-status?team=` |
| Org already has the App | `POST /api/team-brain/adopt-org-installation` |
| Finish repo | `POST /api/team-brain/ensure-brain-repo` |
| Clone token | `POST /api/team-brain/git-token` |
| Metric | `POST /api/team-brain/install-complete` |

GitHub organisation: **Agency Brain cannot create an org**. GitHub refuses App-created repos on a personal account. Our GitHub screen matches theirs: open `github.com/account/organizations/new`, they type the org name, we `GET https://api.github.com/users/:login` to confirm `type=Organization`, then open `https://github.com/apps/agency-brain-sync/installations/new?state=<teamSlug>`. That browser is the one screen we do not own.

After the repo exists we clone the same way they do (installation token in the URL, then strip it from `origin`), seed if empty, write git identity, then **append** a brain entry and launch Agency Brain so **it** watches. We never `git push` after that.

## Hard guards (do not ship without these)

1. **Do not steal Plyntr’s watcher.** If `~/Library/Application Support/Agency Brain/config.json` already has an active `brainPath`, we do not change it. Create-new on this machine is blocked unless `BRAIN_APP_ALLOW_CREATE=1` or the active path is empty. Demo the “already set up” path against the existing folder without writing interview files into the shared brain unless the user is clearly on a **new** team folder.
2. **Never log or print member tokens, git tokens, or config.json.**
3. **Dry-run default** (`BRAIN_APP_DRY_RUN=1` in dev): screens work; ads2ai OTP may be live; create-team / clone / config writes are stubbed with on-screen “would have…”.
4. Interview on a live shared brain (Plyntr) is off unless the folder was cloned by this run.

## Out of scope

- Windows / Linux
- Iframe of Agency Brain, or “click setup is complete” inside that app
- Brain Bridge / Plyntr-hosted copier
- A second git watcher
- Replacing Command Centre
- ChatGPT skill tree (Codex may run; skills are not promised)
- Creating GitHub orgs via API
- Spending money / new ads2ai products
- Pushing this app to GitHub unless Joe asks

## Shared contracts

### Window

One window. Title bar (traffic lights + name + Agency Brain watching pill). Left rail: human steps. Main: current screen or chat.

### Screens (in order)

`welcome` (6-character **setup code** from Your Clients / the invite email) → then we already have email, name, role, team, and whether GitHub is done.

- Client or agency **owner/scout**, repo not created yet → `abget` → `github` → `abapply` → AI → chat interview
- Teammate → `hello` → `abapply` → AI → chat about them
- Repo already exists, this computer → `abget` → `abapply` → AI → chat

`email` → `otp` is the **backup** only ("I don't have a code"), then `choice` / `name` as before.

The setup code is the same `GET /api/team-brain/invite-resolve?token=` call Agency Brain's wizard makes. It mints the member token. They do not type their email on the happy path.

### Data shapes

```ts
export type PathKind = 'create' | 'join' | 'second';

export type Member = { email: string; name?: string; token: string };

export type Team = { slug: string; name: string; role: string; kind?: string; repoUrl?: string };

export type NeedId = 'what' | 'who' | 'offer' | 'voice' | 'now' | 'people' | 'you';

export type Need = { id: NeedId; label: string; ask: string };

export type Session = {
  path: PathKind;
  email: string;
  member?: Member;
  teams: Team[];
  team?: Team;
  business: string;
  orgLogin?: string;
  ai?: 'claude' | 'grok' | 'gpt';
  brainPath?: string;
  abWatching: boolean;
  dryRun: boolean;
  filled: Partial<Record<NeedId, boolean>>;
  parked: string[];
};
```

### Tokens (CSS)

From the mock: `--ink #1a1612`, `--muted #5c534a`, `--line #d9d0c6`, `--paper #f3eee8`, `--card #fffdf9`, `--orange #f0810e`, `--orange-deep #c45f00`, `--ok #2c6e3a`, `--ok-bg #e8f0e6`, `--warn #8a5a12`, `--warn-bg #f8eedc`. Fonts: Schibsted Grotesk + Source Serif 4. Radius 2px. No Inter / Space Grotesk / Geist.

### IPC (preload `window.brain`)

`auth.requestCode(email)`, `auth.verify(email, code)`, `auth.myTeams()`, `setup.createTeam(name)`, `setup.lookupOrg(login)`, `setup.openCreateOrg()`, `setup.openAppInstall(slug, org?)`, `setup.pollInstall(slug)`, `setup.ensureRepo(slug)`, `setup.applyFolder(opts)`, `ab.detect()`, `ab.install()`, `ab.watching()`, `ai.detect()`, `ai.login(which)`, `chat.send(text)`, `chat.needs()`

### Shared files (foundation / integrator only)

- `package.json`, lockfile, electron-vite config, tsconfigs
- `src/main/index.ts` (window + register IPC modules)
- `src/preload/index.ts`
- `src/renderer/src/App.tsx`, `main.tsx`, `index.html`
- `src/renderer/src/styles/tokens.css`, `shell.css`
- `src/shared/contracts.ts`
- `docs/v1-build.md`, `docs/v1-contracts.md`

## Work list

### slice-1: Foundation

- **Wave:** 0
- **Depends on:** none
- **Owns:** scaffold, shell, tokens, contracts, IPC stubs returning dry-run, `docs/`
- **Acceptance:** `npm install` works; `npm run dev` opens the Electron shell with rail + empty main; contracts file exists.

### slice-2: First-run screens

- **Wave:** 1
- **Depends on:** slice-1
- **Owns:** `src/renderer/src/screens/*.tsx`, `src/renderer/src/flow.ts`, `src/renderer/src/components/Rail.tsx`, `Titlebar.tsx`, `Choice.tsx`, `MapCard.tsx`
- **Acceptance:** Click through owner-create, teammate, and already-set-up in dry-run. Copy matches the mock. Download link on owner/scout `abget` points at `https://ads2ai.com/downloads`. Invites disabled until needs are filled.

### slice-3: ads2ai auth

- **Wave:** 1
- **Depends on:** slice-1
- **Owns:** `src/main/ads2ai.ts`, `src/main/ipc-auth.ts`
- **Acceptance:** request-code and verify-code hit api.ads2ai.com; token never written to logs; my-teams populates choice. Dry-run still skips create-team.

### slice-4: GitHub + team repo

- **Wave:** 2
- **Depends on:** slice-3
- **Owns:** `src/main/github-setup.ts`, `src/main/ipc-github.ts`
- **Acceptance:** Org lookup rejects personal accounts. Create-org and App-install open in the browser. Poll + ensure-brain-repo run only when not dry-run.

### slice-5: Agency Brain folder

- **Wave:** 2
- **Depends on:** slice-3
- **Owns:** `src/main/agency-brain.ts`, `src/main/clone.ts`, `src/main/ipc-ab.ts`
- **Acceptance:** Detects `/Applications/Agency Brain.app`. Refuses to change an existing active `brainPath`. Dry-run shows the mapped apply list. Live clone uses git-token, strips it from origin, launches AB.

### slice-6: AI login

- **Wave:** 2
- **Depends on:** slice-1
- **Owns:** `src/main/ai-cli.ts`, `src/main/ipc-ai.ts`
- **Acceptance:** Detects `claude`, `grok`, and `codex` on PATH. Login opens the right CLI auth. One connected AI is enough.

### slice-7: Interview chat

- **Wave:** 3
- **Depends on:** slice-2, slice-6
- **Owns:** `src/main/chat-cli.ts`, `src/main/ipc-chat.ts`, `src/shared/needs.ts`, `src/renderer/src/screens/ChatScreen.tsx`
- **Acceptance:** Opening chat asks from the needs list, not a fixed script. A long answer can fill several needs. Work mid-interview shows pause/save. CLI cwd is the brain folder when live; dry-run echoes.

## Waves

- **Wave 0:** slice-1
- **Wave 1:** slice-2, slice-3
- **Wave 2:** slice-4, slice-5, slice-6
- **Wave 3:** slice-7

## Verify

- `npm run typecheck` / build green
- Click-check every visible button
- Open the Electron window for Joe
- On this Mac, default is dry-run so Plyntr’s Agency Brain config is untouched
