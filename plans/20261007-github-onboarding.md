# GitHub onboarding in Brain

Date: 2026-10-07. Status: approved and saved on main. The plan review and the implementation review both ended APPROVE. Joe asked to save this so the other Brain session can merge. Do not pack or deploy unless Joe asks.

The target is the walkthrough in `~/Desktop/Brain-GitHub-setup.mp4`, plus the GitHub apps that walkthrough left out. A company signs in to GitHub once, names an organization only when they do not already have one, and does the repository in a Brain card. The last GitHub screens are the Install pages for the apps that lane already uses. The person never picks an app.

## Behavior when this is done

This applies to a new company brain, and to a local-only brain whose owner or scout later turns GitHub on from Settings. It does not apply to someone joining with a code, to a team or project seat, or to This computer only.

1. The card says Connect GitHub. Sign in with GitHub opens the system browser. Not a window inside Electron. Passkeys stay on GitHub’s own page.
2. GitHub shows its sign-in page, then its authorize page for a Plyntr setup app. They approve. The browser lands on a page that says to return to Brain. The card advances on its own.
3. The card lists the GitHub user and every organization that user owns. A personal account is listed and can be chosen. An organization they do not own is shown and cannot be chosen.
4. If they own no organization, the card says so. Create an organization opens `https://github.com/account/organizations/new`. They use GitHub’s own plan page, organization form, and invite page. Brain cannot create an organization. When they come back, the card lists the new organization without them pasting or copying its name.
5. They pick an account and confirm the repository name. The name starts as `{slug}-brain`. They can edit it. Create repository makes a private repository and copies `Plyntr-LLC/client-brain-template` into it. GitHub’s new-repository page does not open. The copy uses two credentials. The Plyntr app installation reads the private template, which is how `ensure-repo` reads it today. The setup token writes the new repository. The setup token cannot see the template.
6. The card then opens two Install pages, in this order, both pinned to that repository. First `plyntr-brain-sync`. Then `plyntr-brain-bridge`. Both stay on Only select repositories for that one repository. This is what `PlyntrPath` step 5 and Settings `LocalSyncPanel` already require. The video showed the first of those two pages. This pass is that Plyntr lane, including a local-only brain whose owner or scout later turns GitHub on. An Agency Brain code is not this pass.

7. The folder `~/Projects/{repo}` appears only after both apps are on that repository. Sync then uses the installation token from `POST /v1/git/token`. The setup login is not the sync credential.
8. Other people still join with a code. They do not create an organization or a repository, and they do not install an app. A project seat uses the repository that already has Brain Bridge. This computer only still installs no GitHub app.

The authorize page will not match the lighter page in the video. GitHub will tell them the setup app can read organization membership and create and write repositories. That access is what lets the card create the private repository before the Install page, so the Install page can show the repository already selected. The setup credential is revoked as soon as the copy succeeds, and also on cancel and after 15 minutes. Plyntr Brain Sync stays at its live permissions: contents write, metadata read. Checked 2026-10-07 with `gh api /apps/plyntr-brain-sync`.

One manual step, once, by Joe, before a customer can use this. It is not a customer step. Register an OAuth App owned by Plyntr-LLC. Callback URL `https://brain-sync.joe-84a.workers.dev/v1/github/oauth/callback`. Request `read:org` and `repo` at authorize time. Put the client id and client secret in worker secrets. Do not put them in the app, the repo, or a prompt.

## How the card does the GitHub work

The app never sees the GitHub token or the client secret.

1. The signed-in Brain seat asks the worker to start a setup. The worker returns a random state and a PKCE challenge. The app opens `https://github.com/login/oauth/authorize` with that state, the challenge, and the callback above.
2. GitHub redirects to the worker. The worker checks state, exchanges the code with the client secret, and keeps the user token in a Durable Object for that setup. The browser only sees “Return to Brain.”
3. The app polls with the seat token. The worker uses the GitHub token to read the user and the organizations they own. It pages through `/user/orgs`, then checks `GET /user/memberships/orgs/{org}` and keeps role `admin`.
4. Create repository is `POST /orgs/{org}/repos` or, for the personal account, `POST /user/repos`. `private: true`. No `auto_init`. The setup token does that write. The Plyntr app installation token reads `Plyntr-LLC/client-brain-template`. The worker writes that tree, plus the same seed files `ensure-repo` writes today, into the new repository with the setup token, and records the repo on the brain. A name that is already taken is an error on the card. The worker does not add a suffix.
5. The worker revokes the token with `DELETE /applications/{client_id}/token` before it tells the app the repository is ready. Cancel, sign-out, and the 15-minute alarm revoke it too.
6. Both installs use the helpers in `src/main/setup-folder.ts`, pinned to the repository id from step 4. Sync is `plyntrBrainSyncInstallUrl`. Bridge is `bridgeInstallUrl`.
7. Sync is polled with `GET /v1/github/installed?repo=` and the seat token. There is no `app` parameter. That route is always `plyntr-brain-sync`. Ready when `installed` is true, `repositorySelection` is `selected`, and `repo` is the repository just created. Bridge is polled with `GET /github/installed?repo=` on the brain-sync worker, using the expected repository name. That body has `installed` and `repositorySelection` only. Ready when `installed` is true and the selection is not `all` or `all_repositories`. Then the existing clone and `startBrainSync` run.

Replace, on this path only:

- `ensureRemoteBrainRepo` in `src/main/github-account.ts`, which runs `gh repo create` as whoever is logged into the GitHub CLI on that Mac.
- `watchClipboardOrg` from `setup:openCreateOrg`. The card learns the new organization from the API poll, not from the clipboard.

Leave `gh` in place for any call this plan does not name.

## Ways this can fail

1. The GitHub token, refresh token, authorization code, or client secret reaches the renderer, a log, `git remote`, or the setup trace.
2. The token is still valid after a successful copy, a cancel, a sign-out, or 15 minutes.
3. The repository is created public, or under an account the user does not own.
4. The repository name is not the one they confirmed, or a taken name is replaced with a silent suffix.
5. An existing repository that is not this brain gets overwritten. A `sync.json` whose `mode` is not `plyntr` or whose `repo` is not this repository stays a 409, as `ensure-repo` does today.
6. Install continues when GitHub says all repositories, or when the installed repo is a different one.
7. Later sync uses the setup token instead of the installation token from `POST /v1/git/token`.
8. This computer only, or a join-with-a-code, starts this GitHub flow.
9. A team seat, a project seat, or a scout who is not the bootstrap scout can start it. Owners and the bootstrap scout can, which is the rule on `ensure-repo` today.
10. The flow requires the `gh` binary or a clipboard copy of the organization name.
11. GitHub’s new-repository page is opened.
12. Creating an organization is attempted through the API.
13. The OAuth `state` from the callback is accepted when it does not match the one issued.
14. Two setups for the same brain both create repositories. The second finds the first repository and does not create another.
15. `/user/orgs` is only read for the first page, so an organization past that page never appears.
16. A personal account is refused even though they chose it.
17. Any install page is opened before that repository exists, so GitHub cannot pre-select it.
18. Plyntr Brain Sync, Agency Brain Sync, or Brain Bridge has its permissions widened so that the setup token is unnecessary. That is a different plan. This one does not do it.
19. A Plyntr company brain, or Settings turning GitHub on, finishes after only `plyntr-brain-sync`, or opens `agency-brain-sync`.
20. Brain Bridge is accepted on All repositories, or the Bridge poll is treated as ready without asking for the repository just created.
21. A project seat or a join-with-a-code is sent through organization creation, repository creation, or an install.

## Check

One command, against the worker’s fake GitHub, not a test written to mirror the finished code. The fake GitHub records which token saw which repository. The setup token cannot read `Plyntr-LLC/client-brain-template`. The Plyntr app installation token can. The installation token cannot create or write the customer repository. Artifact: stdout contains `GITHUB_SETUP_PASS` only when the happy path and every assertion below passed. Dry-run does not print that line.

Happy path: a user owns no organization, then owns `harbor-and-co`, then confirms `harbor-and-co-brain`. The fake records, in order: authorize exchange, org list that grows by `harbor-and-co`, `POST /orgs/harbor-and-co/repos` with `private: true` and that exact name by the setup token, a template read by the installation token, a commit to the new repository by the setup token whose `.team-config/sync.json` says `mode` `plyntr` and `repo` `harbor-and-co/harbor-and-co-brain`, token revoke, and no further call with that token. Then `GET /v1/github/installed?repo=harbor-and-co/harbor-and-co-brain` returns `installed: true`, `repositorySelection: selected`, and that `repo`. Then `GET /github/installed?repo=harbor-and-co/harbor-and-co-brain` returns `installed: true` and `repositorySelection: selected`, with no `repo` field required. A second run does not call `POST /orgs/harbor-and-co/repos` again. A setup-token read of the template fails the run.

The same command fails the run unless each of these assertions fails the case it belongs to:

- A mismatched OAuth `state` is refused and no token is stored.
- Cancel revokes the token. Sign-out revokes the token. The 15-minute alarm revokes the token. Each of those is its own case, and a later GitHub call with that token fails it.
- A taken name returns an error and does not create `harbor-and-co-brain-1` or any other suffix.
- An existing repository whose `sync.json` `mode` is not `plyntr`, or whose `repo` is not that repository, returns 409 `sync_conflict` and is not written.
- The personal account creates with `POST /user/repos`, `private: true`, and the same two-token copy.
- An organization that appears only on the second page of `/user/orgs` is listed and can be chosen.
- A team seat, a project seat, and a scout who is not the bootstrap scout each get 403. An owner and a bootstrap scout do not.
- This computer only, a join-with-a-code, and a project seat do not start setup.
- The token is absent from response bodies, the setup trace, and logs.
- A public create, a create by a non-owner, `repositorySelection` `all` on either poll, or a call to GitHub’s new-repository URL fails the run.
- Skipping the Bridge poll fails the run. Opening `agency-brain-sync` on this Plyntr path fails the run.

A source check in the same command fails if the Plyntr create path or the Settings “turn GitHub on” path still calls `gh repo create`, `watchClipboardOrg`, or `plyntrCreateRepoUrl`.

Dry-run stays off the network. It walks the same cards and prints `GITHUB_SETUP_DRY_RUN`. It does not print `GITHUB_SETUP_PASS`.

Click-through of the real GitHub pages waits until Joe asks to pack a build. It is not this check.

## Files

Brain.app, only the GitHub setup path:

- `src/renderer/src/PlyntrPath.tsx` steps 2 through 5
- `src/renderer/src/SettingsPanel.tsx` and `src/renderer/src/LocalSyncPanel.tsx` where they open create-org for a local brain
- `src/renderer/src/FirstRun.tsx` only where the Plyntr create-org handoff is duplicated. The Agency GitHub screen stays as it is.
- `src/main/setup-folder.ts`, `src/main/ipc-stubs.ts`, `src/main/github-account.ts`, `src/main/plyntr-sync.ts`, `src/preload/index.ts`
- a new main-process module for the poll and the browser open
- the existing setup check script pattern under `scripts/`

Worker, `~/Projects/brain-sync`:

- a new setup route module, mounted from `src/worker.js` beside `handlePlyntrV1`
- the Durable Object that holds the token until revoke
- `test/` for the medium case above

Do not change the join-with-a-code clone, the local-only seed, the CLI or Cloudflare steps, or the permissions of `plyntr-brain-sync`, `agency-brain-sync`, or `plyntr-brain-bridge`.

## Not in this pass

Packing, notarizing, or replacing `/Applications/Brain.app`. Downloading Agency Brain.app.

Agency Brain Sync. An Agency code still installs `agency-brain-sync` and then Brain Bridge the way it does today, before the repository exists, so that install cannot be limited to the new repository. Doing it the Plyntr way needs an ads2ai server change: `ensure-brain-repo` today receives only `teamSlug` (`brain-app/src/main/ads2ai.ts`). The server is not in `brain-app` or `brain-sync`. This pass does not claim a check can see that server create or seed the repository the card named. That lane comes back when ads2ai can take the confirmed `owner/name`, seed that repository, and not create a second one. An Agency member also has an ads2ai token, not a brain-sync seat, so this pass does not start the setup token from an Agency sign-in.
