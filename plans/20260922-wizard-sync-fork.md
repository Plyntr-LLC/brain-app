# Wizard fork: Agency Brain path and Plyntr sync path

Status: **APPROVED** (independent Grok 4.7 xhigh plan review, cycle 19 — 2026-09-22). Ready for Phase 1 implementation. Date: 2026-09-22. Repo: `/Users/joewine/Projects/brain-app`. Worker changes live in the brain-sync project that owns `https://brain-sync.joe-84a.workers.dev` (vendored agent only is in `vendor/brain-sync`). Dry-run stays `BRAIN_APP_DRY_RUN=1`.

This plan is the product. Path A keeps today's ads2ai setup. Path B is how Jeen gets a full `org/slug-brain` clone with no Agency Brain.app and no Command Centre code.

## Decision

The first wizard screen is a fork. The choice is stored in the brain folder and followed on every later Mac.

| Path | Who it is for | GitHub App for the full repo | Invite authority | Watcher |
| --- | --- | --- | --- | --- |
| A. With Agency Brain | Brains already on ads2ai, and anyone who still wants Mike's app | `agency-brain-sync` | `GET https://api.ads2ai.com/api/team-brain/invite-resolve` | `activateWatching` when Agency Brain.app is installed, otherwise `startBrainSync` |
| B. Plyntr sync only | Greenfield client brains. Jeen. Joe as scout before the client owner arrives | New app `plyntr-brain-sync` | Brain.app mints codes on the brain-sync worker | `startBrainSync` only. Never `activateWatching` |

Project-only people stay on the existing hq-sync agent and `plyntr-brain-bridge` on both paths. They never receive a full clone.

## What is true today

Three overlapping setups exist. The fork replaces the overlap for new brains. It leaves the old callers in place for Path A.

1. **HQ / agency full repo.** `src/main/ads2ai.ts` talks to `https://api.ads2ai.com` (`invite-resolve`, `git-token`, `install-status`, `ensure-brain-repo`, `adopt-org-installation`). Install URL is `https://github.com/apps/agency-brain-sync/installations/new` with `state=<teamSlug>` (`src/main/setup-folder.ts`). `src/main/brain-sync.ts` polls every 60s with that git token when Agency Brain is not watching. `src/main/ipc-stubs.ts` `settleSync` calls `activateWatching` first when `/Applications/Agency Brain.app` (or the Windows equivalent) is present, then `stopBrainSync`. One watcher.
2. **Project seats.** `src/main/hq-sync.ts` and `vendor/brain-sync` talk to `https://brain-sync.joe-84a.workers.dev`. `exchangeAndCompose` builds a mini folder. ACL in `vendor/brain-sync/src/acl.js` allows only `projects/` and `clients/` roots, denies `.team-config`, and fails closed. Bridge install is `plyntr-brain-bridge`. `GET /github/installed` is a hard stop before chat for full seats. Project seats skip that stop. `isHqMiniFolder` skips `startBrainSync`.
3. **Legacy local join.** `auth:joinFolder` trusts `.team-config/roles.json` on a folder the person can already open. No ads2ai call. `login-route.ts` still sends owner, scout, and team emails to ads2ai, and project emails to hq-sync.

Settings already has a role picker (`owner`, `scout`, `team`, `project`) in `src/renderer/src/SettingsPanel.tsx`. Project add calls `addProjectSeat` (worker invite). Owner, scout, and team only call `upsertTeamMember` on `roles.json`. That file write is not an invite. `SeatRole` in `src/shared/contracts.ts` is already `owner | scout | team | project`.

`clone.ts` strips `x-access-token` from `origin` and redacts tokens in errors. `githubInstallReady` rejects `allRepositories` and `repositorySelection` of `all`.

## Seat model

These four seats are the only ones. `head_scout` stays an alias of `owner` inside `asSeat`. `member` stays an alias of `team`.

| Seat | Folder on disk | `skills/` | `clients/` and `projects/` | Rest of the repo (HQ, `AGENTS.md`, `code/`) | `.team-config` | Invites |
| --- | --- | --- | --- | --- | --- | --- |
| Owner | Full `org/slug-brain` clone | Read and write | Read and write | Read and write | Read and write | Mint and revoke every role |
| Scout | Full clone | Read and write | Read and write | Read and write | Read. Write roster rows for team (Phase 1) | Mint and revoke **team** (Phase 1). **Project mint/revoke: Phase 1.5.** Bootstrap scout may mint **agency team** and **one owner** only (not another scout; Joe already holds scout) |
| Agency team (`team`) | Full clone | Read | Read and write | Read. Write is allowed outside `skills/` and `.team-config/` | Read own row | None |
| Project-only | hq-sync mini folder, not a git clone of HQ | Absent | **`projects/` and `clients/`** roots as **`acl.js` today** (Phase 1 fork email flow). Path B worker-minted project seats (Phase 1.5) may narrow roots in brain-sync + vendor copy | Absent | Absent | None |

Skill rules are the brain repo's `AGENTS.md`, which the CLI reads. **Path B seed `AGENTS.md` must match the seat table:** owner and scout may edit `skills/`; agency team may read `skills/` and may write anywhere in the repo **except** `skills/` and `.team-config/` (including `clients/`, `projects/`, `code/`, and other top-level folders); project-only people never receive HQ (Phase 1.5). Brain.app does not rewrite an existing customer's `AGENTS.md`.

Enforcement split:

- Project-only is enforced now by `acl.js` (path allow-list, wipe on revoke). Leave that lock alone in this repo. Change it only in brain-sync, then copy `vendor/brain-sync` again.
- Owner, scout, and team all hold a full clone and a contents read/write installation token. GitHub cannot see the seat. MVP ships the `AGENTS.md` rule and the Settings copy that already says agency team has no skill-edit rights. A main-process deny on `skills/**` and `.team-config/**` for `team` is Phase 2. Until that lands, a CLI can still write those paths if it ignores `AGENTS.md`.

Bootstrap scout is Joe on a new client brain. The worker marks that seat `bootstrap: true` until the first owner invite is redeemed. After that, Joe remains a normal scout. The client owner is the only person who can mint another owner or scout.

Seat caps live on the worker brain row, not in the app binary.

- Builders (owner + scout, including bootstrap): 2.
- Agency team: 10.
- Project-only: no numeric cap. Each seat has at least one ACL root.

A mint over the cap returns a user-visible error and creates nothing. **Pending unredeemed invites count toward the cap** (same as redeemed seats for builder/team limits).

## Phases

### Phase 1 (MVP): Jeen on a new brain with no Agency Brain.app

Ship this first. Joe (Plyntr scout) creates the brain on his Mac. He generates a code in Settings. Jeen installs Brain.app, picks Plyntr, pastes the code, and lands in Skin on the real repo. Her Mac never installs Agency Brain.app and never calls `api.ads2ai.com`.

**Phase 1 scope cut:** Path B **`POST /v1/invites` for `owner | scout | team` only** — worker **rejects** `role: project` with 400. Project-only people use **fork → hq-sync email only** (today's `/auth/exchange` mini folder). **No** `addProjectSeat` / Bridge bind for a greenfield Path B brain until Phase 1.5. Fork "Project-only" link unchanged (hq-sync email).

In scope:

- Wizard fork as the first screen.
- Path A behavior unchanged, including ads2ai invite-resolve, `agency-brain-sync`, and `settleSync`.
- Path B create (Joe) and Path B join (Jeen, and later the client owner).
- Worker: brain row, hashed invites, seat tokens, installation lookup, short-lived git token for `plyntr-brain-sync`.
- One-time GitHub App `plyntr-brain-sync` (Joe creates the app in GitHub settings; the app only opens the install URL).
- Manifest `.team-config/sync.json` committed in the repo.
- `startBrainSync` reads the manifest and asks the worker for the git token.
- Settings: owner or bootstrap scout generates a code, picks a role, sees it once, revokes an unredeemed or redeemed seat.
- Project-only invites keep today's hq-sync email/code flow.
- North-star gate for Path B: Git present, `plyntr-brain-sync` installed on that one repo with Only select repositories, folder cloned by this app and not empty, one CLI signed in. Chat stays closed until those are true.
- **`GOAL.md`:** rewrite North star to Path A vs Path B (see **GOAL.md** section under Implementer constraints).

### Phase 1.5 (project seats on Path B)

- Worker: registry plaintext code for exchange; bind invite email → `hq_repo`; seed `.team-config/seats.json`; map `project` ↔ `client-project` in ingest; first project seat before Bridge count > 0 handled explicitly.
- **`POST /v1/brains/:id/bind`:** bootstrap scout or owner **seat token** (`pbt_`) connects **that brain's repo** for project sync (Brain Bridge install, exchange bind, hq owner token for that repo). A platform session is not accepted and is not rewritten, so `POST /v1/brains` still requires `isPlatformOwnerSession()`. After an owner code is redeemed, that owner Connects with the owner seat token. The app stores the returned hq owner session only when this Mac is not on a platform login.
- Re-enable `POST /v1/invites` with `role: project` + `roots`.
- Fork project code field → resolve + `joinProject` as in Review closure.

### Phase 2

- Main-process write guard: seat `team` cannot write `skills/**` or `.team-config/**` through Brain.app file helpers. Document that the CLI can still bypass until a later hook.
- Settings UI polish: richer seat list (names, last sync hint). Revoke-to-401 ships in Phase 1; Phase 2 adds filters and bulk revoke only if needed.
- Same-repo move: an existing ads2ai brain installs `plyntr-brain-sync` on that repo, writes `sync.json` mode `plyntr`, and stops calling ads2ai `git-token`. Ship only with Joe present on that brain. If Agency Brain is already watching the folder, refuse to start `startBrainSync` until that watch is stopped.

### Phase 3

Smallest shippable slice. Stripe and any other checkout stay out until Joe approves a paid service. This repo has no billing client.

- **Package.** The tier is the caps already enforced on the worker: 2 builders (owner + scout), 10 agency team, project-only with no numeric cap. Settings on a Plyntr brain states that package. No payment call.
- **Owner transfer.** `POST /v1/brains/:id/transfer` with the redeemed owner's seat token revokes the active scout whose email is the brain row `scout_email`, and revokes that email's pending scout invites. A later git token for that seat is unauthorized. Scout and team receive 403. Settings shows **Remove Plyntr scout** only when this session's seat token role is owner and that token's email is not the active Plyntr scout. After Move to Plyntr sync, a scout seat token stays hidden even when `roles.json` still lists that email as owner, and the app does not send that scout token.
- **Email.** `POST /v1/invites` still returns the code once. When `extras.sendPathCode` is wired (Resend via `mail.js`, same key as other brain-sync mail), it also emails the code. Mail copy uses `pathCodeMail` and must pass `assertBrainCopy`. If the key is missing or send throws, the mint still succeeds and the response is `emailed: false`.
- **Legacy join.** Wizard and Settings do not call `auth:joinFolder`. The IPC handler stays so a Path A folder with `roles.json` can still join until no packaged build calls it.

### Phase 3 acceptance

- Settings on a Plyntr folder shows the package sentence (2 builders, 10 agency team, project-only with no numeric cap). The app does not call a payment API.
- Owner transfer revokes only the Plyntr scout seat. That seat's git token then returns 401. A scout token cannot transfer. A second transfer returns "The Plyntr scout is already off this brain." Settings offers the control only for a redeemed owner seat token. A roster owner who holds the scout seat after a move does not see it, and that scout token is not posted.
- A mail stub that records the message sets `emailed: true` and the message contains the code. A mail stub that throws sets `emailed: false` and the code is still in the JSON. The seats list still does not contain the plaintext code.
- Renderer source does not reference `joinFolder`. `auth:joinFolder` remains registered.
- `npm run typecheck` is green. brain-app unit tests and brain-sync tests are green. Worker deploy is not part of this slice.

## Backend

Extend the brain-sync Cloudflare Worker. Add one D1 database on that same Cloudflare account if the worker has nowhere durable to store brains and invites. The Electron app gains `src/main/plyntr-sync.ts` as the only caller. Do not route Path B through `ads2ai.ts`.

No new vendor. Supabase and Railway are out.

### Worker routes

All JSON. Seat token is `Authorization: Bearer`. The worker stores a hash of the seat token. Codes are stored as hashes. The plaintext code and the plaintext seat token are returned once.

| Method | Path | Who | Behavior |
| --- | --- | --- | --- |
| POST | `/v1/brains` | **`Authorization: Bearer <hq-owner.json session token>`** where worker validates **platform** session (same rules as existing `/platform/status`) | Body `{ label, org, slug, scoutEmail, rotate?: boolean }`. First create for `(org, slug)` always returns **`seatToken`**. Idempotent retry without local token: client must use **`rotate: true`** (wizard step 3 shows recover copy + button that POSTs rotate). Repeat without `rotate` when scout exists → `{ brainId, repo, seatToken: null }`. |
| POST | `/v1/brains/:id/ensure-repo` | Bootstrap scout seat token | **Repo must already exist** on GitHub at `org/<slug>-brain` and appear in the app's Only-select-repositories installation. If GitHub returns 404 → **409** `{ error: 'repo_missing' }` and client shows: *"Create the empty repo on GitHub first, then try again."* Worker only seeds commits; it does not create the GitHub repo. |
| GET | `/v1/github/installed?app=plyntr-brain-sync&repo=` | Seat token for this brain | Worker **always** queries GitHub App installation API for this org/repo on each request (no webhook-only cache). Returns `{ installed, repositorySelection, repo }` where **`repo` equals the query param when that repo is in the selected-repositories installation**. Phase 1.5 may add `projectSeatCount`. |
| POST | `/v1/invites` | Owner, or bootstrap scout, or scout within the mint rules | Body `{ email, name, role }`. Phase 1: **`owner` \| `scout` \| `team` only**; **`project` → 400**. Bootstrap may submit **`owner` \| `team` only**. Returns `{ inviteId, code, expiresAt }`. |
| POST | `/v1/invites/resolve` | Anyone with the code | Body `{ code, deviceId }` (deviceId from `app.getPath('userData')` hash). Rate limit 5 failures / device / hour. Single redeem. Returns `{ seatToken, role, email, name, repo, label, brainId, bootstrap }`. When `role` is `owner`, worker clears `bootstrap` on that brain. |
| POST | `/v1/git/token` | Seat token, role owner, scout, or team | Returns `{ token, repo, expiresIn: 600 }` using the GitHub App installation token. 403 when the installation is missing, revoked, or All repositories. |
| POST | `/v1/seats/:id/revoke` | Owner, or scout for **team** (Phase 1) | Marks seat **revoked**; **revoked redeemed seats no longer count toward caps.** Revokes linked unredeemed invites. Redeemed: git token 401. Project wipe: Phase 1.5. |
| POST | `/v1/invites/:inviteId/revoke` | Owner, bootstrap scout, or scout (team-scope rules) | Unredeemed code only; bootstrap scout may revoke **owner** invite; `invites/resolve` → 410 afterward. |
| GET | `/v1/seats` | Owner or scout | `{ seats: [{ id, email, name, role, status, bootstrap? }], invites: [{ inviteId, email, name, role, status, expiresAt }] }`. No tokens. `id` / `inviteId` for revoke routes. |

Existing `/owner/seats`, `/auth/exchange`, and `/github/installed` for `plyntr-brain-bridge` stay as they are for project-only.

Joe's Path B create uses **`isPlatformOwnerSession()`** (`hq.kind === 'platform'`). Jeen never sees platform login. Do not add a parallel bootstrap device flow in Phase 1.

**Worker GitHub App credentials (Phase 1).** Store `PLYNTR_BRAIN_SYNC_APP_ID` and `PLYNTR_BRAIN_SYNC_PRIVATE_KEY` (PEM) in the brain-sync Worker secrets (same place as existing bridge app secrets). Mint installation tokens via GitHub REST `POST /app/installations/{id}/access_tokens`. When webhooks lag, poll `GET /app/installations` (or installation repositories) for the org until the repo appears in a selected-repositories installation.

**GitHub org lookup on Path B.** Do not import `ads2ai.ts` for create. Move or duplicate `lookupGithubAccount` into `src/main/github-account.ts` (calls `api.github.com` only). Path B create/join uses that module.

### Seed commit (worker, via installation token)

**Idempotent seed checklist** (each file independent; never wipe business content):

1. If **`sync.json` missing** → write it.
2. If **`AGENTS.md`, `CLAUDE.md`, `roles.json`, or any `context/TEMPLATE-*.md` missing** → write that file even when `sync.json` already exists.
3. If **`sync.json` exists** with wrong `mode`/`repo` → **409** (do not partial-seed).

Return success when every checklist item is satisfied.

**Minimum new-repo seed** (empty repo, no README — create-repo screen tells Joe to leave README unchecked):

- `AGENTS.md`, `CLAUDE.md`, `.team-config/sync.json`, `.team-config/roles.json` with **`team_slug` and `team_name`** equal to the brain slug, plus scout **`members[]`** row (email, name, role `scout`) so `readTeamIdentity()` works after relaunch.
- At least one **`context/TEMPLATE-*.md`** stub so `contextNamesLookNew` is true and the first-chat welcome fires (see `src/shared/first-chat.ts`).

Joe fills real context after clone. Jeen fast-forwards normally.

**Create-repo URL:** **`https://github.com/organizations/{org}/repositories/new?name={slug}-brain`** (org from create step 2). Fallback copy: exact name `{slug}-brain` under org `{org}`. Optional check: `GET api.github.com/repos/{org}/{slug}-brain` → 404 before install step.

### Slug rules (Path B)

Derive `slug` from business name: lowercase; replace runs of whitespace with `-`; remove apostrophes; map `&` → `and`; **delete every character outside `[a-z0-9-]`**; collapse repeated `-`; trim leading/trailing `-`; truncate to 40 chars. Reject create if slug empty. Worker one brain row per `(org, slug)`. **`plyntr-seats.json` keys by `brainId`**; resume may overwrite the same key when token rotates.

### Invite code canonical form

**Single rule (worker + app):** normalize by removing `-` and spaces only, then uppercase. **No** stripping other punctuation and **no** character substitution. Hash the normalized 10-char string. UI may display `XXXX-XXXX-XX`; paste with or without dashes must resolve.

### Path A `sync.json`

**Out of Phase 1.** No change to Path A clone/handoff. Manifest for Path A ships in Phase 2 or via ads2ai seed later.

### Joe's Mac: Path A membership + Path B client brain

(See credentials above.) **`ensurePendingJoinForFolder`:** never copy `login:*` into AB `memberToken`. **Platform create gate:** `hq-owner.json` platform check. **`POST /v1/brains`:** registers worker `businessId` on the **brain row only**; **does not** write `hq-owner.json` `hq_repo`. **Phase 1:** switching the active client brain **does not** retarget hq-sync / Bridge bind — `hq_repo` changes **only** on explicit Settings **Connect project sync** (same as today). Phase 1.5 documents auto-bind when the first Path B project seat is added.

*(Path B project seats: Phase 1.5 only. Phase 1: no project mint on Path B; **`readSyncMode === 'plyntr'` → Bridge skipped always** (full-repo Path B never waits on `plyntr-brain-bridge`). Bridge gates apply only to hq-sync **mini folders** and Path A full seats as today.)*

### Logout and relaunch

`logOut` → **`fork`**, clear session `syncPath` and **`account.json`** only — **do not delete `plyntr-seats.json`, `pending-plyntr-create.json`, or `pending-plyntr-join.json`**. **Signed-out resume:** incomplete **create** (`wizardStep <= 7`, no folder path; **`wizardStep === 7` without folder → step 6**) → **Continue company brain setup**; incomplete **join** → **Continue joining this brain** (reuse **`seatTokenForBrain`**, no second resolve). Create re-gates platform then **`saveAccount`** from stored scout token. **Recover scout token** on wizard step 3 (and Settings): POST `rotate: true` with platform bearer when local token missing. **Mount effect (signed in):** infer `syncPath` from active folder; do not default to ads2ai `email`.

### `GOAL.md`

Replace the **North star**, **Product → sync / watchers**, and the **Already true → auto-install / chat gate** line with the closure paste text (remove tunnel + bridge as universal chat requirements; Path A keeps them, Path B does not).

### Git token use in the app

`startBrainSync` in `src/main/brain-sync.ts`:

- Read `.team-config/sync.json`.
- Mode `plyntr`: token from **`seatTokenForActiveBrain()`** after the folder is active. If null → error; never ads2ai. On 401/403, same.
- Mode `agency-brain`, or file absent and the active brain row is not `syncMode: 'plyntr'`: keep `ads2ai.gitToken` / `memberTokenForTeam`.
- Manifest missing or invalid while row says plyntr: same error; do not fall through to ads2ai.
- Mini folder: return immediately, as today.

Tokens stay in the main process. The renderer receives `{ installed: boolean, detail: string }` only.

Installation tokens last 10 minutes. The 60-second poll requests a new one each tick. The token is placed only in the git remote URL for that command, then the stored `origin` stays `https://github.com/org/slug-brain.git` (already implemented in `clone.ts`).

## Manifest

Path: `.team-config/sync.json` inside the brain repo. Committed. No secrets, no tokens, no emails.

```json
{
  "version": 1,
  "mode": "plyntr",
  "repo": "harolds-books/harolds-books-brain",
  "githubApp": "plyntr-brain-sync",
  "bridgeApp": "plyntr-brain-bridge",
  "createdAt": "2026-09-22T00:00:00.000Z"
}
```

`mode` is `plyntr` or `agency-brain`. **Path A `sync.json`:** Phase 2 only (or ads2ai server seed). **Phase 1 leaves existing Path A folders untouched** — no local commit/push of `sync.json` during setup.

Parser rules (new `src/main/sync-manifest.ts`, unit-tested):

- Unknown `version` or unknown `mode`: fail closed, sync does not start.
- `repo` must match `git remote get-url origin` after normalizing both sides with the same helper as `parseGithubHqRepo` (`org/slug-brain`, no `.git`, no host). Mismatch: fail closed.
- `githubApp` must be `plyntr-brain-sync` when mode is `plyntr`, and `agency-brain-sync` when mode is `agency-brain`.

**Credentials (fixes one-token / multi-brain clash).**

- `account.json`: **`source`:** `'ads2ai' | 'team-file' | 'hq-sync' | 'plyntr'` (persist/load; never collapse `plyntr` → `ads2ai`). **`token`:** `login:<hex>` when `source === 'plyntr'`; ads2ai JWT when `source === 'ads2ai'`. **`getMemberToken()`** only when `source === 'ads2ai'`. Path B git: **`seatTokenForActiveBrain()` only** (see below). Ads2ai JWT for Path A also remains in AB `config.json` when Joe uses both; Path B sign-in does not wipe AB config.
- `userData/plyntr-seats.json` (mode `0600`): map keyed by **`brainId`** → `{ seatToken, slug, email, role, repo, wizardStep? }`. Also index slug → brainId for lookup. Copied to `brains.json` row after clone.
- `join-pending.ts` pattern: optional `setPendingPlyntrJoin({ brainId, slug, seatToken, … })` for the in-flight wizard so resolve → GitHub steps → clone do not lose the token if `mergeBrainRows` drops pathless rows.
- `userData/brains.json` rows (extend `BrainRow`): `syncMode`, optional `brainId`, optional **`seatToken`** after clone. **`mergeBrainRows` / `rememberBrain` must preserve** `syncMode`, `brainId`, and `seatToken` when merging (today they drop extra fields). **`saveFile` for brains.json uses mode `0600`**. **`brains:list` and `brains:remember` IPC** strip `seatToken` before the renderer sees rows.
- Ads2ai brains: unchanged (`memberTokenForTeam`, AB `config.json`).
- **`seatTokenForBrain(brainId)`:** read **`plyntr-seats.json[brainId].seatToken`** (always persisted after resolve or step 3 POST).
- **`seatTokenForActiveBrain()`:** `brainId` from active `brains.json` row for `currentBrainFolder()` → **`seatTokenForBrain`**. Slug fallback only when row lacks `brainId` but folder has valid manifest + `roles.json`.
- **Wizard / pre-active-folder calls** (`GET /v1/github/installed`, `ensure-repo`, `putFolderPlyntr`, `/v1/git/token`): pass explicit **`brainId`** from wizard session (`pending-plyntr-create.brainId` or join pending file). **Do not** infer token from Joe's unrelated active Path A folder.
- Optional in-memory `pendingPlyntrJoin` is a cache only; **disk `plyntr-seats.json` is source of truth** after resolve/step 3.

**`readSyncMode(folder)` (gates + watcher choice):** valid `.team-config/sync.json` wins; else if `brains.json` row has `syncMode`, use it **for UI gates only** (AB/Bridge skip, wizard resume). **`startBrainSync` / git token:** require a **valid manifest** with `mode: plyntr`. If the row says plyntr but manifest is missing or invalid → **do not sync**; set user-visible error *"This folder has no Plyntr sync file."* (no ads2ai fallthrough). If manifest and row both exist and **`mode` differs**, fail closed.

Renderer session IPC continues to omit all seat tokens.

## GitHub Apps

Three apps. Two of them already exist.

| App | Owner | Path | Job |
| --- | --- | --- | --- |
| `agency-brain-sync` | ads2ai / Mike | A only | Full-repo installation tokens through ads2ai `git-token`. `state` on the install URL stays the team slug. |
| `plyntr-brain-sync` | Plyntr | B full seats (owner, scout, team) | Full-repo clone, fetch, push. Webhook to the brain-sync worker. |
| `plyntr-brain-bridge` | Plyntr | Project-only on both paths | Mini-folder sync. Unchanged. |

Path B full-repo chat does not wait on `plyntr-brain-bridge` (Phase 1–2). Bridge stays required for **hq-sync mini folders** (fork project email) and Path A full seats as today. Phase 1.5 Path B project seats re-use today's bind + Bridge flow against the **active brain's** `businessId`/`repo` on that Mac.

`plyntr-brain-sync` permissions, set once in the GitHub App UI:

- Repository: Contents read and write, Metadata read.
- Organization: none that grant every repo.
- Webhook events: `installation`, `installation_repositories`.
- Install URL: `https://github.com/apps/plyntr-brain-sync/installations/new?state=<brainId>`. GitHub returns `state` only to the browser Setup URL callback, not on webhooks. Phase 1 **polls** `GET /v1/github/installed?app=plyntr-brain-sync&repo=org/slug-brain` after install; no OAuth redirect handler required in Brain.app.
- Suggested target: the org id from the existing `lookupGithubAccount` call, same query style as `githubAppInstallUrl`.

**Path B create order (canonical = wizard steps 0–7 below).** GitHub work is steps **2 → 6** (org known before `POST /v1/brains` on step 3). Never call `ads2ai.*` on this path.

The worker rejects the installation when `repository_selection` is `all`. The wizard stays on the Install step until the poll passes. A repo URL is not an install.

**Install polling helpers:** keep **`githubInstallReady(payload)`** unchanged for Path A (`installStatus` / `repoUrl` only). Add **`plyntrGithubInstallReady(payload, expectedRepo)`** for Path B: true only when `installed`, selection is not `all`, and **`payload.repo` equals `expectedRepo`** (normalized). Path B polls use the new helper only.

Same repo name as Path A: `org/<slug>-brain`, cloned to `~/Projects/<slug>-brain`. Two Plyntr apps may be installed on that one repo when project seats exist. They use different tokens. A project seat token cannot call `/v1/git/token`.

## Wizard

New first screen `fork` in `src/renderer/src/FirstRun.tsx`. **`blankSession` initial screen is `fork`**, not `welcome`. **Do not use a machine-wide `setup-path.json`.** During wizard only, keep `syncPath` in React session. After clone, **gates always read the active folder's** `.team-config/sync.json` or `brains.json` row `syncMode` (switching back to a Path A folder restores Path A gates even if the last wizard fork was Plyntr).

Mount effect: unsigned → **`fork`** (never default `email`). Incomplete **create** or **join** pending files → show Continue buttons first. Signed out with a saved folder on disk → **`fork`** with copy "Pick how to sign in" (Plyntr invite code / Agency code / Project email). Do not open chat unsigned.

**Email / OTP:** add optional `via` on `auth:requestCode(email, via?)`. When **`via === 'hq-sync'`**, the main process calls **only** hq-sync routes (no ads2ai attempt). Same for **`auth:verify`** on that flow. Project-only link sets `loginVia: 'hq-sync'` before request. Back from `email` goes to **`fork`**, not `welcome`.

Copy:

- **With Agency Brain.** "You have a setup code from Your Clients." Goes to today's `welcome` and `auth:resolveCode`.
- **Plyntr sync only.** "This brain stays in Brain.app. Agency Brain is not required." Then two buttons: "I have a Plyntr code" and "Set up a new company brain".
- **Third link on `fork`:** "Project-only code" → **`email`** with `via: 'hq-sync'` (unchanged live flow). **Not** the 10-char Plyntr field in Phase 1.

**Startup effect (`FirstRun.tsx` mount).** Today it forces `email` and applies `abMissing` + `bridgeStatus` to every signed-in full seat. Change:

- If `loginVia === 'hq-sync'` or role `project`: keep current hq-sync behavior (may land in `chat` / mini folder).
- Gates use **active folder only:** `readSyncMode(activeFolder)`. Path B → skip `abMissing` and **Bridge entirely in Phase 1**. Path A → today's rules.
- Path A: unchanged when active folder is Path A.

**Path B join after `putFolderPlyntr`.** Join must continue through **One setup → AI pick → chat** (same as create step 7), not stop at clone.

Path B join: one code field (`auth:resolvePlyntrCode`). 10 chars from the Crockford alphabet. **Normalize with `normalizePlyntrInviteCode()`** (remove `-` and spaces, uppercase — **same function as worker hash**; do **not** reuse ads2ai's strip-all-non-alphanumeric). Persist full-seat tokens in **`plyntr-seats.json`** + pending join.

**After resolve (Phase 1 full seats only):** immediately write **`plyntr-seats.json[brainId]`** + **`pending-plyntr-join.json`** `{ brainId, repo, role, email, wizardStep: 5 }` (seat token on disk before GitHub poll). GitHub not ready → poll up to 15m; **relaunch:** fork shows **Continue joining this brain** while pending join exists and no folder path. Else **`putFolderPlyntr(brainId)`** → **`saveAccount`** → One setup → chat; delete pending join on chat entry.

**Join assumes Joe already created the repo** for full seats. No create wizard on join.

Skip Agency Brain.app and `agency-brain-sync`.

Path B create (Joe, platform session on the Mac). **Only this step list is canonical:**

| Step | Screen |
| --- | --- |
| 0 | Platform gate (see closure — not plain `loadOwnerSession` alone) |
| 1 | Business name → derived slug |
| 2 | GitHub org (`lookupGithubAccount`, Organization) |
| 3 | **`POST /v1/brains`** once → pending + **`saveAccount`** scout |
| 4 | Create empty repo: open **`https://github.com/organizations/{org}/repositories/new?name={slug}-brain`** (org from step 2); checkbox "I created `{org}/{slug}-brain`" |
| 5 | Install `plyntr-brain-sync`; poll until **`plyntrGithubInstallReady(..., org/slug-brain)`** |
| 6 | **`ensure-repo`** + **`putFolderPlyntr`** → **`switchBrain(newPath)`** + **`saveAccount` update `folder`** + **`rememberBrain`** with path, `syncMode: plyntr`, `brainId`, `seatToken` |
| 7 | One setup → AI pick → **chat** (wizard complete) |

Step 0 copy: *"Sign in to platform sync first: Settings → Add users → Email me a project-sync code, then Sign in, until you see This is the platform login."*

Joe's seat is scout with `bootstrap: true` until the client owner redeems an owner code.

`SetupNeeds` tool list follows the manifest once the folder exists, and follows the fork choice before that:

- Path A: unchanged (Homebrew, Git, Agency Brain.app, Cloudflare Tunnel, CLIs, `agency-brain-sync`, and Brain Bridge for full seats).
- Path B: Homebrew, Git, one CLI, plus a **non-installable** checklist row `plyntr-github` ("GitHub app on this repo") satisfied only when `GET /v1/github/installed` is true. Do not add `plyntr-brain-sync` to `installNeed` / `TOOL_IDS`. Cloudflare Tunnel optional (Settings → Phone).

**Path B chat gate (one formula):** `ready = brainPath && git && cliSignedIn && hasBrainMarker(folder) && plyntrGithubInstalled`. Extend `NeedItem` with optional `kind: 'status' | 'install'` so **`plyntr-github`** is a status row (poll only, not in `installNeed`). `listNeeds` for Path B omits `ab` and `cloudflared` items entirely. `SetupNeeds` treats status rows as poll-until-present, never calls `setup:install` for them.

`holdForBridge` **and** startup `bridgeStatus`: Phase 1 — if **`readSyncMode(activeFolder) === 'plyntr'`**, skip Bridge (`skipped: true`).

**Dry-run:** see Review closure (stub clone path, bridgeStatus, click-check scope).

`auth:joinFolder` is not a third button.

## Watcher rule

One watcher per folder.

- Manifest `agency-brain`: keep `settleSync`. If `activateWatching` returns ok, `stopBrainSync`. If Agency Brain.app is absent, `startBrainSync`.
- Manifest `plyntr`: do not call `activateWatching`. Do not write Agency Brain `config.json`. If `readWatching()` already has this `brainPath` and `watching` is true, do not start `startBrainSync`. Show: "Agency Brain is already syncing this folder. Stop that sync in Agency Brain, then come back." Fail closed.
- Mini folder: neither watcher. hq-sync `watchLoop` only.

**Watcher handoff (code locations).** Gate all of:

- `adoptFolder` / `settleSync` in `src/main/ipc-stubs.ts`
- `handOffToAgencyBrain` in `src/main/watch-handoff.ts` (called from install when AB need runs)
- **`startBrainSync` entry in `src/main/index.ts`** (on app launch): if manifest `plyntr` and AB already watches that path, **do not** silently return; set **`lastBrainSyncError`** with the stop-sync sentence.
- **`src/main/sync-health.ts`:** when AB watches a folder whose manifest is `plyntr`, **prefer `lastBrainSyncError`** over AB green health so the sync pill shows the stop-sync sentence (add to Phase 1 file list).

When **`readSyncMode(folder) === 'plyntr'`** (manifest or brain row; during wizard before clone, session `syncPath` only for that flow): **never** `activateWatching` or write AB `config.json`. Use `startBrainSync` only. Fail closed if AB is watching that path.

## Settings

On manifest **`plyntr`**, hide **Add this person**. **Create a code** via `POST /v1/invites`. Code shown once; list/revoke via `GET /v1/seats` + revoke routes.

- **Bootstrap scout (`bootstrap: true`):** mint **Owner** or **Agency team** only. May **`POST /v1/invites/:inviteId/revoke`** on any unredeemed invite (including the owner code). May **`POST /v1/seats/:id/revoke`** on redeemed **team** seats only.
- **Scout after owner redeems (`bootstrap: false`, role scout):** mint **Agency team** only; revoke unredeemed invites and redeemed **team** seats (same routes; worker enforces role).
- **Owner:** mint owner, scout, team per caps; full revoke.
- No Project picker until Phase 1.5.
- Agency team: no mint UI.

Path A Settings stay on ads2ai plus the current project-seat block. Generating a Plyntr code on an `agency-brain` manifest is a Phase 2 action, labeled "Move this brain to Plyntr sync", and it is absent in Phase 1.

## Security

- Fail closed on bad manifest, repo mismatch, All repositories, missing installation, revoked seat, expired code, second redeem, and over cap.
- A Plyntr account never calls ads2ai for git.
- An ads2ai code never hits `/v1/invites/resolve` (length check before the request).
- Codes and seat tokens are hashed on the worker. Logs and error strings go through `redact` in `clone.ts`. Add the worker's token prefix to that replacer if it differs.
- Do not log `config.json`, seat tokens, or installation tokens. IPC responses to the renderer exclude them.
- `account.json` and any worker token file stay mode `0600`.
- Git commands keep `credential.helper` empty and `GIT_TERMINAL_PROMPT=0` (already in `clone.ts`).
- Invite resolve rate limit: 5 failures per device per hour, then a generic "That code did not work."
- Project ACL, symlink deny, and blob cap stay in `acl.js`.
- Only select repositories. The install page is the one step we do not own. The app waits until the worker agrees.

## Migration

**Already on disk (Plyntr, Jeen test, any ads2ai brain).** No `sync.json`. Phase 1 leaves them on Path A. `startBrainSync` keeps using `ads2ai.gitToken` via `memberTokenForTeam` / AB config for those folders only. Adding a Path B client brain adds a **second row** in `brains.json` with its own `seatToken`; switching brains retargets sync using that row's mode. The wizard fork does not rewrite existing remotes or Agency Brain profiles.

**Greenfield.** Joe uses Path B create. The seed commit contains `sync.json`. Jeen and the client owner join that repo. They never get an ads2ai membership.

**Later move (Phase 2 only).** Install `plyntr-brain-sync` on the same repo, write `mode: plyntr`, issue Plyntr seat tokens for the same emails, stop ads2ai git-token. Leave the `agency-brain-sync` installation in place so Mike's app can still be turned on later. Do not run both watchers.

`auth:joinFolder` keeps working for a Path A folder that has `roles.json`. On a `plyntr` manifest it returns "This brain uses a Plyntr code." and does not create a `local:` session.

## Where ads2ai is still required

Required for every brain whose manifest is `agency-brain` or whose folder has no manifest and whose account source is `ads2ai`: setup codes, member OTP, create-team, install-status, ensure-repo, git-token, and optional Agency Brain.app watch.

Not required for a Path B brain: Jeen's Mac, the client owner's Mac, clone, 60-second sync, Chat, Skin, CLI login, or project-only seats on that same repo.

Joe's platform login on the worker (`hq-owner.json`, `/platform/status`) is how the first Path B brain is created. That login is Plyntr's brain-sync owner, not an ads2ai membership. Command Centre stays the place ads2ai clients get Your Clients codes. Brain.app does not replace it.

## Files

Phase 1 app work:

- `src/renderer/src/FirstRun.tsx`: `fork` screen and Path B join/create.
- `src/renderer/src/SetupNeeds.tsx`: tool list by path.
- `src/renderer/src/SettingsPanel.tsx`: create code, show once, revoke.
- `src/preload/index.ts` and `src/main/ipc-stubs.ts`: **`setup:putFolderPlyntr`** (worker git token + clone; dry-run copies fixture). After success: **`switchBrain`**, update **`account.folder`**, **`rememberBrain`** with path + plyntr fields. Path B must not call `settleSync`'s `activateWatching` branch.
- `src/main/plyntr-sync.ts`: worker client.
- `src/main/sync-manifest.ts` plus `sync-manifest.test.ts`.
- `src/main/brain-sync.ts`: token from manifest + **`seatTokenForActiveBrain()`** only.
- `src/main/brains.ts` / `brains-pick.ts`: preserve `syncMode`, `brainId`, `seatToken` in merge; strip token on list IPC.
- `src/main/plyntr-seats.ts` (or extend `join-pending.ts`): pending seat tokens before folder exists.
- `src/main/session-token.ts`: extend `source` with `plyntr`; `getMemberToken` guard; no seat tokens in `account.json`.
- `src/main/install.ts` (`listNeeds`): Path B / manifest `plyntr` skips Agency Brain and Cloudflare Tunnel as **required** for `ready`; still require Git, one AI CLI, and successful clone marker.
- `src/renderer/src/FirstRun.tsx`: `holdForBridge` skips when `readSyncMode === 'plyntr'` (Phase 1).
- `src/renderer/src/flow.ts`: `blankSession` starts on `fork`; **`stepState`** does not mark "Got your code" done on `fork`.
- `src/main/ipc-stubs.ts`: **`auth:verify`** — if code normalizes to Plyntr length, **no** ads2ai fallback on failure.
- `src/main/github-account.ts`: org lookup (extracted from ads2ai module).
- `src/main/setup-folder.ts`: `plyntr-brain-sync` install URL helper, next to the existing two URL helpers.
- `src/main/watch-handoff.ts` + `src/main/index.ts`: plyntr watcher gates.
- `src/main/sync-health.ts`: AB-watching-plyntr-folder shows `lastBrainSyncError`.
- `src/main/install.ts`: `listNeeds({ syncMode: readSyncMode(activeFolder) })`, Path B ready rule, `plyntr-github` status row.
- `src/shared/contracts.ts`: manifest type and Path B code length.
- `src/shared/plyntr-invite.ts`: **`normalizePlyntrInviteCode()`** (single hash/compare rule).
- `userData/pending-plyntr-create.json` + **`pending-plyntr-join.json`** in `FirstRun` mount + `plyntr-seats.ts`.
- `plyntr-sync.ts` / IPC: all worker calls accept optional **`brainId`** for token lookup during wizard.
- `GOAL.md`: replace North star body (Path A vs Path B); Now line when slice lands.

Worker (other repo): routes above, D1 tables `brains`, `seats`, `invites`, GitHub App webhook, seed commit.

Do not edit `vendor/brain-sync/src/acl.js` in this repo. Do not hand-edit `out/`.

## Acceptance

### Phase 1

- Fresh Mac, no Agency Brain.app, no ads2ai account. Jeen picks Plyntr, enters a code Joe created in Settings, and the app clones `org/slug-brain` to `~/Projects/<slug>-brain`. Chat stays closed until GitHub reports `plyntr-brain-sync` on that repo with Only select repositories, the clone has a brain marker, and one CLI is signed in. Then Skin opens with the first-chat welcome while `context/TEMPLATE-*` files remain.
- That Mac has no new Agency Brain `config.json` brain entry. `startBrainSync` runs. `activateWatching` is not called.
- If Agency Brain is already watching that same path, Brain.app shows the stop-that-sync message and does not start a second watcher.
- All repositories install never flips `installed` to true.
- Revoked code and a second paste of a used code fail with a clear sentence. Sync after revoke fails with a non-secret error.
- Builder cap 3rd seat and team cap 11th seat fail at mint time.
- Path A: a 6-character Your Clients code still resolves on ads2ai, still installs `agency-brain-sync`, and still hands off to Agency Brain.app when that app is on the machine.
- Project-only code still builds a mini folder and never a full clone.
- `npm run typecheck` is green. Unit tests cover manifest parse, code-length routing, **`plyntrGithubInstallReady` rejects wrong `repo`** (Path A helper unchanged), and the watcher choice (plyntr mode does not call `activateWatching`; ads2ai mode still prefers it).
- Dry-run click-through does not call production worker or real GitHub (`BRAIN_APP_DRY_RUN=1` stub table in Review closure + fixture folder).
- Tokens do not appear in renderer props, sync pill text, or git error strings.
- Click-check: fork; Path B bad code; Settings `TESTTEST12` / stub once on fixture brain; Path A welcome. Dry-run: no prod worker. Packaged smoke: full-seat join → chat after One setup.
- Relaunch signed in on Path B folder does not force Bridge or Agency Brain needs (Phase 1).

### Phase 2

- Seat `team` file writes under `skills/` and `.team-config/` from Brain.app are refused. Owner and scout writes there succeed.
- A brain that started on ads2ai can be moved only by the explicit Settings action, ends with `sync.json` mode `plyntr`, and syncs with `/v1/git/token`. If Agency Brain is watching, the move stops before `startBrainSync`.

### Phase 3

See **Phase 3 acceptance** under Phases. Do not start it inside the Phase 1 slice.

## Not in this delivery

- A third wizard path for `auth:joinFolder`.
- Supabase, Railway, or a new public API host.
- Replacing Command Centre, ads2ai, or `agency-brain-sync`.
- Using `agency-brain-sync` as the Path B credential.
- Using `plyntr-brain-bridge` as the full-repo git credential.
- Loading both watchers on one folder.
- All repositories.
- Auto-migrating brains that are already on disk.
- Stripe or any other paid checkout. Phase 3 states the seat package in Settings and does not charge.
- Rewriting customer `AGENTS.md` files on existing brains.
- Editing the vendored ACL lock from brain-app.
- A signed Mac build or notarization (still blocked until Joe says yes).
- Changing the phone tunnel, Skin catalog, or CLI transports.

## Open questions (defaults are binding unless Joe overrides before implementation)

1. **Who creates the first brain?** Default: Joe, with the existing brain-sync platform owner session, as bootstrap scout. The client owner joins later with an Owner code. Jeen joins as Agency team when she is staff, or as Owner when she is the client.
2. **How does Jeen get the code?** Default: Joe copies it from Settings. No email in Phase 1. Phase 3 also sends it through brain-sync mail when Resend is configured. The screen still shows the code once.
3. **Code shape and life.** Default: 10 chars from Crockford-32 alphabet (see Review closure), 7 days, one redeem, revocable; revoke/expired frees cap.
4. **Caps.** Default: 2 builders, 10 agency team, project-only uncapped and root-scoped. Stored per brain on the worker.
5. **Scout mint rights (Phase 1).** Default: scout mints **team** only. **Project mint: Phase 1.5.** Bootstrap scout mints **team + one owner** (not scout). After the owner redeems, only the owner mints owner or scout.
6. **Agency Brain.app installed on a Path B Mac.** Default: ignore it for that folder. If it is already watching that folder, refuse our watcher.
7. **Bridge before Path B full-repo chat.** Default: never (Phase 1–2). Bridge applies to hq-sync mini folders and Path A as today; Phase 1.5 adds project seats on Path B with explicit bind.
8. **Cloudflare Tunnel before Path B chat.** Default: no. Phone stays Settings → Phone.
9. **Where state lives.** Default: D1 on the existing worker account. No Supabase and no Railway.
10. **Skill enforcement in Phase 1.** Default: `AGENTS.md` plus Settings copy. The write guard is Phase 2.
11. **Empty GitHub repo.** Default: the worker seed commit lands before clone returns success. Joe fills the business after that.
12. **Legacy join.** Default: IPC remains for Path A folders. Wizard does not offer it. Plyntr manifests reject it.

## Review closure (binding — resolves review cycles)

**Project-only join.** **Phase 1:** fork link → hq-sync **email** flow (unchanged). **Phase 1.5:** 10-char field + worker registry work (see Phase 1.5). Phase 1 acceptance: project-only mini folder via **hq-sync email**, not Path B invite.

**`auth:verify` / routing.** `via === 'hq-sync'` → never ads2ai. **10-char codes** route to **`auth:resolvePlyntrCode`** using **`normalizePlyntrInviteCode()`** only — never ads2ai `resolveCode` normalizer.

**Full-seat join GitHub not ready.** Poll install every 3s for up to **15 minutes**, then: *"This brain is not ready on GitHub yet. Ask whoever set it up to finish install on the repo."* Create install screen uses the same poll (no timeout on create until user backs out).

**Gates.** Phase 1: **`readSyncMode === 'plyntr'`** → skip AB + Bridge. **`setup:bridgeStatus`:** `{ skipped: true }` on Path B folders.

**Dry-run.** Fixture tree **`resources/fixtures/plyntr-brain/`** (paths the app reads):

- `.team-config/sync.json` — **`version: 1`**, `mode: plyntr`, **`githubApp: plyntr-brain-sync`**, **`repo`: `plyntr-fixture/plyntr-fixture-brain`**
- `.team-config/roles.json` — scout email row, `team_slug: plyntr-fixture`
- `AGENTS.md`, `CLAUDE.md`, `context/TEMPLATE-business.md`, `projects/_template/.gitkeep`

**Dry-run network boundary.** When **`BRAIN_APP_DRY_RUN=1`**, `plyntr-sync.ts` **must not** call production `brain-sync.joe-84a.workers.dev`. Use an in-process stub (same module, `dryRunPlyntrWorker`):

| Call | Stub behavior |
| --- | --- |
| `POST /v1/brains` | `{ brainId: 'dry-brain', repo: org/slug-brain, seatToken: 'pbt_dry_scout', role: 'scout', bootstrap: true }` from body slug |
| `POST /v1/brains/:id/ensure-repo` | `{ ok: true }` (no GitHub writes) |
| `POST /v1/invites/resolve` | Code **`TESTTEST12`** → fixture scout payload + fake `pbt_dry_*` token |
| `GET /v1/github/installed` | `{ installed: true, repositorySelection: 'selected', repo: <query repo> }` |
| `POST /v1/git/token` | Fake token; **`putFolderPlyntr`**: copy fixture → target path, **`git init`**, set **`origin`** to `https://github.com/{org}/{slug}-brain.git`, patch **`sync.json`** `repo` + `githubApp` + `version` to match parser rules (dry-run only) |
| Settings mint / seats | `{ code: TESTTEST12, seats: [], invites: [] }` |

**Fixture prep (manual or `npm run dry-run:plyntr-fixture`):** copy fixture tree → `~/Projects/plyntr-fixture-brain`, `git init`, remote `https://github.com/plyntr-fixture/plyntr-fixture-brain.git`. Launch app with **`BRAIN_APP_DRY_RUN=1`**; use wizard/UI to sign in (stub resolve) or drop a test `account.json` under the app's dev `userData` path documented in `README` — do not call main-process helpers from a shell script.

**Create resume / completion.** **`wizardStep`** = **the screen index to show next** (0–7). Write **`pending-plyntr-create.json`** when the user passes step 0; update **`wizardStep` on every Next** (and on Back). Fields: `{ createId, wizardStep, label, org, slug, scoutEmail, brainId? }`. **`seatToken` only in `plyntr-seats.json[brainId]`.** After step 3 success: set **`pending.brainId`**, store seat row, set **`wizardStep = 4`**.

**Resume (signed-in or signed-out after platform re-gate):** open **`pending.wizardStep`** while create incomplete (no **`brains.json` path** for `pending.brainId`; **`wizardStep === 7` without folder → open step 6**). Steps 4–6 call worker APIs with **`brainId` from pending**, not active Path A folder. **Completion:** entering chat from step 7 deletes pending create file.

**Step 3 without `seatToken` in response:** show error + **Recover scout token** button (wizard, not Settings-only). Do not advance to step 4.

**`POST /v1/brains` idempotency:** First create for `(org, slug)` returns token. Re-entry with local token: skip POST. Re-entry without local token: POST **`rotate: true`** via recover button only.

**Repo exists.** Checkbox only.

**Platform business.** `POST /v1/brains` → worker D1 only; no `POST /platform/businesses`, no mail. **`hq-owner.json` `hq_repo`** changes only on explicit Connect project sync.

**Caps / list.** Revoked/expired **invites** free slots. **Revoked redeemed seats** also free builder/team slots (status `revoked` excluded from cap counts). `GET /v1/seats` → `{ seats: [...], invites: [{ inviteId, … }] }`.

**Bootstrap scout Settings.** Mint: **agency team + one owner** only (no scout, no project in Phase 1).

**Seed.** Includes **`projects/_template/.gitkeep`**. **`ensure-repo`:** wrong `sync.json` → **409**; otherwise run **checklist seed** (each required file independent); never wipe business files.

**Platform gate (single check).** Copy: *"Sign in to platform sync first: Settings → Add users → Email me a project-sync code, then Sign in, until you see This is the platform login."* **Gate = `loadOwnerSession()` AND session `hq.kind === 'platform'`** (same as Settings platform banner — company-owner `hq-owner.json` alone is **not** enough to create). Implement **`isPlatformOwnerSession()`** in main; wizard step 0 and `POST /v1/brains` both use it.

**AB conflict.** Export **`setBrainSyncBlockedReason(folder, msg)`** from `brain-sync.ts`; use when `abOwns` on plyntr folder.

**Alphabet / tokens.** Generate 10 chars from **`0123456789ABCDEFGHJKMNPQRSTVWXYZ`** only (Crockford Base32). **`normalizePlyntrInviteCode()`** (shared `src/shared/plyntr-invite.ts`, imported by renderer + main + worker tests): remove `-` and spaces, uppercase — **no other stripping** (Path A ads2ai codes keep their own normalizer). Display may group as `XXXX-XXXX-XX`. Dry-run stub: **`TESTTEST12`**. Seat tokens: **`pbt_`** prefix in `redact()`.

**`GOAL.md` replacement text (replace North star, Product sync bullets, **and** the old universal auto-install/chat-gate line — delete AB+tunnel+bridge as requirements for every brain):**

> Someone downloads Brain.app. One wizard. **Path A (Agency Brain):** setup code from Your Clients, `agency-brain-sync`, Agency Brain.app when installed, tunnel and bridge gates for full seats as today. **Path B (Plyntr sync only):** `plyntr-brain-sync` on **Only select repositories** (never All repositories; a repo URL is not an install), Brain.app sync via worker git token, no Agency Brain.app required; tunnel and bridge **not** chat gates on Path B full-repo folders in Phase 1. Same `org/slug-brain` clone either way. One watcher per folder (`activateWatching` OR `startBrainSync`, never both). Chat closed until that path's required steps are actually finished. Project-only people use hq-sync mini folders + bridge, not a full clone.

## Implementer check

Phase 1 is one slice: wizard fork, worker routes, manifest, git-token branch, Settings codes. Phase 2 and 3 wait for Joe. `npm run typecheck` and a click-check of the fork are the app gate. Worker tests cover hash-only storage, single redeem, All-repositories 403, and cap refusal.

**Plan review gate (done):** independent xhigh review loops until the last line is **APPROVE**; every finding is blocking and must be fixed in this document (no “non-blocking” waivers). Build does not start on REJECT.

**Delivery rhythm (per phase):** Grok **4.7 high** (or medium if high is unavailable) implements the phase → independent **4.7 xhigh** review loops until **APPROVE** → next phase. Phase 1.5 / 2 / 3 only after their predecessor phase is approved. **Phase 1 implementation:** APPROVED (xhigh cycle 4, 2026-09-22). **Phase 1.5 implementation:** APPROVED (xhigh cycle 3, 2026-09-22). **Phase 2 implementation:** APPROVED (xhigh, 2026-09-22). **Phase 3 implementation:** APPROVED (xhigh cycle 2, 2026-09-22).
