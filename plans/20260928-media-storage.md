# Brain.app large-file storage (videos and images in Plyntr storage)

Plan date: 2026-09-28. Written with Opus 5.5 medium. Opus approved the storage plan, then rejected the lost-Mac reclaim until the passphrase proof, the 410 wipe rule, and the check steps were closed. The last line on that reclaim pass was APPROVE. Nothing here is built. No bucket, no deploy, no spend.

Rollback tags (create before any media code): `pre-media-storage-20260928` on `Plyntr-LLC/brain-app` and `Plyntr-LLC/brain-sync`. Reset those repos to the tag if this work breaks setup. Do not pack, notarize, or replace `/Applications/Brain.app` from the Grok Bot computer. That Mac does not have the Plyntr Developer ID. Joe packs on his Mac when he is back.

## Context

Brain folders are markdown in git. Videos and images do not belong in git (the worker caps a blob at 50 MB in `brain-sync/src/acl.js` `MAX_BLOB_BYTES`, and project mini folders skip anything larger in `brain-sync/app/src/scan.js`). Gene has about 2 TB of video that his team needs per project. This adds an opt-in storage lane: bytes go to Cloudflare R2 in Plyntr's account, encrypted on the Mac first; a short pointer file sits in the project folder and syncs like any other note. Git sync, seats, setup, and watchers stay as they are.

### Sources read

- `brain-app/GOAL.md` (North star, Already true, Hard rules: dry-run default, no em dashes, never print tokens)
- `brain-app/src/renderer/src/PlyntrPath.tsx` (`ForkScreen` three choices at lines 76-89, `PackSelect` at 10-25, `PlyntrCodeScreen` with `local`)
- `brain-app/src/renderer/src/FirstRun.tsx` (fork wiring 1124-1147: `onLocal` goes to `plyntr-code` with `channel: 'local'`; six `go('chat', ...)` sites at 417, 554, 573, 687, 1296, 1300)
- `brain-app/src/renderer/src/SettingsPanel.tsx` (`<section className="biz current">` at 685 and 1245, `PackSelect` at 690 and 1250, `{localSyncOffer()}` at 705 and 1265, `FoldHead title="Project-only people"` at 707, `channelLine` at 53)
- `brain-app/src/renderer/src/LocalSyncPanel.tsx` (the sub-panel pattern `localSyncOffer()` mounts)
- `brain-app/src/shared/client-pack.ts`, `brain-app/src/shared/contracts.ts` (`canTurnOnGithubSync`)
- `brain-app/src/main/ipc-stubs.ts` (`dryRun()` 175, `openPlyntrProject` 226, `putFolderPlyntr` 1281, `putFolderLocal` 1327, `enableLocalSync` 1412 which throws under dry-run, `storeSetupSeat` 1569, `plyntr:active` 1788, `plyntr:revokeSeat` 1785, `hqSync:revoke` 852)
- `brain-app/src/main/plyntr-seats.ts` (`seatForBrain`, `plyntrDeviceId`, `writeJson` with chmod 600), `brain-app/src/main/shell-vault.ts` (`vault.json`, plain JSON, no chmod), `brain-app/src/main/hq-sync.ts` (project seats hold an HMAC seat token under brain-sync's `seatDir`; loads `src/tokens.js` from `syncRoot()`), `brain-app/src/main/sync-manifest-parse.ts` / `sync-manifest.ts` (`SyncMode = 'plyntr' | 'agency-brain' | 'local'`, `readSyncMode`), `brain-app/src/main/watcher-choice.ts`, `brain-app/src/main/files.ts` (`readSafe` kinds `md | html | text`), `brain-app/src/renderer/src/TerminalWorkspace.tsx` (`openFile` ~2377)
- `brain-sync/src/plyntr-v1.js` (`seatAuth` pbt_ tokens, `canMint`, `canRevokeSeat`, `issueSeat`, `redeemProjectExchange`, `/v1/codes/email`, `/v1/seats/:id/revoke`, `ALPHABET`, `mintCode`), `brain-sync/src/tokens.js` (`issueSeatPayload`: `seat_id, email, hq_repo, device_id, kind, exp` 30 days), `brain-sync/src/acl.js` (`normalizeRoot` allows `projects/<x>/` and `clients/<x>/`, `DENY_SEGMENTS` includes `.team-config`, `SENSITIVE_TOKEN`), `brain-sync/src/blob.js`, `brain-sync/src/worker.js` (`/v1/` dispatch at 224), `brain-sync/src/index.js` (`/auth/exchange`, `/owner/seats`), `brain-sync/migrations/0001-0003`, `brain-sync/wrangler.toml` (D1 + two Durable Objects, no R2)
- Cloudflare docs (R2 limits, multipart, presigned URLs), pulled 2026-09-28: 1,000,000 buckets per account; multipart parts 5 MiB to 5 GiB, all parts but the last the same size, 10,000 parts max; presigned URLs are bearer tokens on `<ACCOUNT_ID>.r2.cloudflarestorage.com`, not custom domains; incomplete multipart uploads abort after 7 days by default.

## 1. What is true when this is done (what a person sees)

- Setup still shows **Sign in**, **I have a code**, **This computer only**. After the chosen path finishes, an owner or scout sees one follow-up question: "Where should big videos and pictures live?" The first button is **Keep on this computer**. Picking **Use Plyntr storage** turns it on and shows a recovery key once.
- Settings, inside the open company block, has a new "Videos and images" block right under the existing local-sync offer. It says where files live now and has the same **Use Plyntr storage** switch, so a brain can turn it on later.
- With storage on, an owner or scout clicks **Add a video or image**, picks a file, picks the project. A pointer note appears in `projects/<name>/media/`. It syncs to everyone who has that folder.
- A project member opens that pointer in Brain.app (the same file tab they open any note in) and the video plays. Someone on a different project never gets the pointer and cannot play it even with the media id.
- An agent reading the folder sees the pointer's title, type, and size. It cannot fetch the bytes.
- Removing John from the project stops his new downloads, deletes his cached copies on his Mac the next time his app checks in, and seals every later upload under a key he never had.
- When a brain hits its byte limit, upload stops with a plain sentence. Nothing is charged to the customer in the app.

## 2. What stays unchanged

- `ForkScreen` in `PlyntrPath.tsx` keeps exactly three choices in `choice-stack`: **Sign in**, **I have a code**, **This computer only**. No fourth button. `PlyntrCodeScreen`, `PlyntrProjectScreen`, `PlyntrCreateScreen` untouched.
- Settings keeps its order: Switch brain, then `Businesses` (`PlyntrCompanyScreen` for superadmin, other brains, `<section className="biz current">` with title, `Brain · {here}`, `channelLine`, `PackSelect`, `{localSyncOffer()}`, then `Project-only people` fold or the "You are ... The owner adds people." line), then **Move this brain to Plyntr sync**, then **This Mac** (Phone, Updates), then **Super admin**. The new block is inserted, nothing moves.
- Git sync, `activateWatching` / `startBrainSync` (one watcher per folder, `chooseWatcher` in `watcher-choice.ts`), hq-sync mini folders, seat minting and revoke, pack caps in `client-pack.ts`: unchanged.
- Local-only still starts no watcher and installs no GitHub app.

## 3. Threat model

The single honest limit, stated once: **we ship Brain.app, and the app is what holds the key. Encryption stops the Cloudflare dashboard. It does not stop a copy of the app we deliberately changed.**

| Who | Can read ciphertext | Can unwrap a key | Gets |
| --- | --- | --- | --- |
| Anyone with Cloudflare account access (dashboard, R2 API token, D1 console) | Yes | Only if they also guess the passphrase | Ciphertext, the scrypt wrap, and the proof public keys. A 6-word passphrase is not guessable. A short one they typed themselves can be attacked offline from this copy. The app will not accept a short one. There is no reusable secret in D1. |
| Someone who changes the worker code | Yes | Not directly | Can register a fake device for an invited email and wait for it to be wrapped. Mitigation below. Can also serve altered ciphertext; AES-GCM refuses it (tag fails, playback shows "This file could not be opened."). |
| A presigned URL leaked in transit or logs | That one object's ciphertext for up to 10 minutes | No | Ciphertext only. |
| Active project member | Ciphertext for objects in their projects | Their project keys, per file keys under them | Plaintext of files in their projects. |
| Full-brain seat (owner, scout, team, Ads2AI full clone) | All objects in the brain | Brain key, so every project key | Plaintext of every file. |
| Stolen Mac, powered off, FileVault on | No | No | Nothing. |
| Stolen Mac, disk image without the user's login keychain | Cached ciphertext | No (device private key is sealed by `safeStorage`, which uses the login keychain) | Ciphertext only. |
| Someone who can read the owner's inbox | The scrypt wrap, after a code, once | No | They can start reclaim and download the locked wrap. They cannot finish, revoke, rotate, or replace that wrap. Cracking the wrap is the same as guessing the passphrase. |
| Stolen Mac, unlocked and logged in | Yes | Yes, through the device key already on it | Everything that seat can see, until the owner types the passphrase on another computer and removes this one. The thief does not learn the passphrase from the disk, and cannot rotate or replace the wraps without it. |
| Revoked person | New downloads stop | A project revoke: the old project key, until `rotate-scope` on the owner's next check-in. A full-brain revoke with a passphrase or recovery signature: the old brain key, until that same request rotates it. A blocked full-brain device with no signature: the old brain key, until someone types the passphrase | A project revoke, or a full-brain revoke with that signature, returns 410 and that Mac deletes its media folder on check-in. A blocked full-brain device returns 401 and the folder stays. Plaintext they already exported, and any cache they keep by never checking in, cannot be taken back. |

**Rogue device mitigation (pick: auto-wrap only for invites minted on this Mac, otherwise a one-click Allow with a fingerprint).** When an owner or scout mints a project invite from Brain.app, main records `{inviteEmail, roots, mintedAt}` in `userData/media/<mediaBrainId>/minted.json`. When a new device registers for that email and those roots, that Mac wraps automatically on its next check-in. Any other new device (a second Mac for an existing member, an invite minted on another Mac, an Ads2AI teammate) appears in Settings as "Waiting: John · Mac ABCD-EFGH · Bible" with **Allow**. The fingerprint also shows on John's Mac in his Settings block so they can compare if they care. Residual: a worker we changed could register its own device key for an email invited from this Mac before John registers. Stated here, not solved.

## 4. Crypto

All crypto runs in the main process with Node `crypto`. The generated passphrase and the recovery key each cross IPC once, through the one-shot calls in Conflicts 1, and a passphrase the person typed crosses only from the renderer into main.

- **File bytes.** AES-256-GCM, chunked. Plaintext chunk 4 MiB (ASSUMED; no code decides this today; small enough for seek, large enough to keep tag overhead at 16 bytes per 4 MiB). Each file gets a random 32-byte data key (DEK) and an 8-byte random nonce prefix. Chunk nonce = prefix (8 bytes) + chunk index (4 bytes, big endian). AAD = `mediaId | chunkIndex | isLast`. Truncation or reordering fails the tag.
- **Object format.** 64-byte plaintext header, then chunks. Header: magic `BRMEDIA1`, format version, chunk size, nonce prefix, chunk count, plaintext length. The header holds no key and no title.
- **Per-file DEK wrap.** DEK encrypted under the project key with AES-256-GCM, AAD = `mediaId | scopeId | keyVersion`. Stored in D1 `media_objects.dek_wrap`.
- **Project key.** 32 random bytes, one per project root (`projects/<name>/` or `clients/<name>/`), versioned. Generated on the owner's or scout's Mac the first time a file is added under that root (`keys.ts` `ensureScopeKey`). Wrapped under the brain key (escrow row) and to each project member's device.
- **Brain key.** 32 random bytes, generated on the Mac that turns storage on (`keys.ts` `createBrainKeys`). Wraps every project key. Wrapped to every full-brain device, to the passphrase, and to the recovery key.
- **Proof, not a verifier.** The brain key is not a proof. Every full-brain Mac can unwrap it, so a value derived from it does not prove anyone typed the passphrase. Scrypt's 32-byte output is split with HKDF into a wrap key and an Ed25519 seed. The recovery key is split the same way. D1 stores the two public keys only. Finish, brain-key rotate, full-device revoke, and wrap replace each start with a one-time challenge (32 bytes, 2 minutes, single use). The Mac signs `challenge || action || SHA-256(body)` with the passphrase key or the recovery key. The server checks that signature and then discards the challenge. A stolen Mac can unwrap the brain key and still cannot sign. A leaked signature cannot be reused.
- **Device key.** X25519 keypair per Mac per storage brain, generated in `device-key.ts` on first use. Private key (PKCS8) sealed with Electron `safeStorage.encryptString` and written to `userData/media/<mediaBrainId>/device.key` with mode 600. Public key registered with the worker. Fingerprint = first 8 Crockford characters of SHA-256 of the public key, shown as `ABCD-EFGH`.
  - Why `safeStorage` over calling the macOS keychain directly: it is already part of Electron (no native module, no `keytar`), it is backed by the login keychain on macOS, and it uses DPAPI on the Windows build that GOAL.md lists. If `safeStorage.isEncryptionAvailable()` is false, storage refuses to turn on or join. No plaintext fallback.
- **Wrap to a device.** Ephemeral X25519, ECDH with the device public key, HKDF-SHA256 (salt = ephemeral pub + device pub, info = `brain-media wrap v1|<mediaBrainId>|<scope or "brain">|<version>`), AES-256-GCM over the key. Row stores `eph_pub, nonce, ciphertext`.
- **Passphrase.** Set on the Mac that turns storage on. The default is 6 words from the EFF large wordlist (7776 words), shown once, about 77 bits. A phrase they type themselves must be at least 16 characters and must not be on a bundled list of common passwords, checked only on that Mac. Node `crypto.scrypt` (N = 2^17, r = 8, p = 1, salt 16 bytes, maxmem 256 MiB) derives a 32-byte key. That key wraps the brain key with AES-256-GCM. The salt, parameters, and wrap sit in D1. The passphrase is typed into the existing Settings block, sent once to the main process, and zeroed there after the wrap is made. It is never stored, never logged, and never sent to the worker. The six generated words are the one-shot return in Conflicts 1. A phrase the person typed is not returned. If scrypt cannot get the memory, turn-on stops with "This Mac does not have enough free memory to protect the passphrase." The parameters are not lowered.
- **Recovery key.** 32 random bytes rendered with `ALPHABET` from `plyntr-v1.js` (Crockford-style, no I L O U): 52 characters in groups of four, prefixed `RK1-`. It has full 256-bit entropy, so HKDF-SHA256 (info `brain-media recovery v1|<mediaBrainId>`) is enough; no slow KDF. It wraps the brain key; that wrap is stored in D1. It is shown once, on the same screen as the passphrase (see Conflicts 1). Either secret opens the brain key. The email code does not. If every Mac, the passphrase, and the recovery key are all gone, the files are unrecoverable. Plyntr cannot reset any of them.
- **Who may reclaim.** An owner or scout email only. A team seat and a project seat do not receive the wraps. Their new computer stays pending until an owner Mac that already has the key allows it.
- **What D1 stores.** Public keys, fingerprints, wrapped keys, the two proof public keys, scrypt salt and parameters, key versions, object ids, sizes, mime types, uploader emails, root names, caps and usage. Never a bare key, never the passphrase, never a proof private key, never a title, never a presigned URL.
- **What never happens.** A bare key is never written to git, D1, a markdown file, `vault.json`, logs, or sent to the renderer. Unwrapped keys live in a main-process `Map` and are cleared on brain switch, logout, and revoke.

## 5. R2 layout

- **Bucket per brain.** Name `bm-<first 24 hex of mediaBrainId>` (lowercase, within R2's 3 to 63 character rule). No customer name in the bucket name. Cloudflare allows 1,000,000 buckets per account, so the per-brain rule has headroom. Bucket creation only through the platform-only route, and only when the worker env `MEDIA_BUCKETS_LIVE` is `"1"` (ASSUMED switch name). Joe turns it on per brain.
- **Object key.** `o/<mediaId>`. No project, no title, no scope in the key, so moving a file between projects is a metadata change.
- **Upload.** Files up to 64 MiB of ciphertext: one presigned PUT. Larger: multipart with part size = 16 ciphertext chunks (about 64 MiB), every part equal size except the last, which satisfies R2's 5 MiB to 5 GiB and equal-size rules. 10,000 parts gives about 640 GB per file.
- **Presign lifetime.** Upload part PUT: 15 minutes. Download GET: 10 minutes. The Mac asks for the next batch of part URLs (8 at a time) as it goes, so a two-hour upload never holds an expired URL for long.
- **Signing.** SigV4 in the worker with an R2 access key pair scoped to object read/write (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` as worker secrets). Bucket create uses a separate Cloudflare API token (`CF_R2_ADMIN_TOKEN`). None of these exist today and this plan does not create them.
- **What the worker checks before it signs.** Token valid and seat active; device registered, not revoked; media brain bucket on; object belongs to that brain; object's scope is inside the caller's access (full seat, or a project seat whose roots contain the scope root); for upload: caller is owner or scout, reservation fits the cap, part number is within the planned count, planned part size matches; for download: object status `ready`.
- **Worker never touches bytes.** Create, complete, and abort multipart plus a `HEAD` to confirm size are control calls from the worker. No object body passes through it.
- **Cleanup.** Leave R2's default 7-day abort of incomplete multipart uploads. The worker also releases the cap reservation when an upload row is older than 7 days.

## 6. Auth on each sync mode

The worker resolves every media call to `{mediaBrain, email, access: 'full' | roots[], role, deviceId}` in `mediaAuth()`.

| Sync mode | Seat | Token the Mac already has | How storage finds the seat | Media access | Who can turn storage on |
| --- | --- | --- | --- | --- | --- |
| `plyntr` | owner / scout / team (full brain) | `pbt_` seat token in `vault.json` (`seatForBrain`) | existing `seatAuth()` → `plyntr_seats` → `media_brains.plyntr_brain_id` | full | owner, scout (`canTurnOnGithubSync`); worker checks role |
| `plyntr` | project | HMAC seat token from `/auth/exchange` in brain-sync `seatDir` (the D1 `pbt_` from `redeemProjectExchange` is discarded) | `verifySeatToken(token, BRAIN_SYNC_SEAT_TOKEN_KEY)` → `hq_repo` → `brainByOrgSlug` → active `plyntr_seats` row with role `project` and that email → `roots` | roots | no |
| `local` from the wizard (**This computer only**) | owner / scout usually | `pbt_` seat (`putFolderLocal` requires a `brainId` from a Plyntr code) | same as `plyntr` full seat | full, one person on this Mac until they invite | owner, scout |
| `local` keyless (folder with no `brainId`, `rememberKeylessFolder`) | none | none | email code on our worker (`/v1/media/codes/email`, reuses `mintCode`, `sha256Hex`, `mail.js`) → new `pms_` storage seat, role owner | full | whoever claims it; one person until they invite |
| `agency-brain` (Ads2AI) full clone | owner / scout / team per `.team-config/roles.json` | Ads2AI member token only; no Plyntr seat | email code → `pms_` storage seat. First claim needs local `roles.json` owner or scout for the signed-in email (checked on the Mac; the worker cannot see Ads2AI). Teammates get storage invites minted by that storage owner. | full | owner, scout per local `roles.json` (ASSUMED, `write-guard-role.ts` / `roleForKeylessWrite`) |
| `agency-brain` project | project (hq-sync mini folder) | HMAC seat token from `/auth/exchange` | `hq_repo` → `media_brains.hq_repo` (set when the Ads2AI owner turns storage on, from the folder's git remote) → roots from the HqRepo Durable Object ingested seats for that email (ASSUMED; `index.js` `/auth/exchange` reads the same snapshot) | roots | no |

When a Plyntr seat already exists, storage reuses it. No second sign-in. `pms_` tokens are stored in `userData/media/seats.json`, sealed with `safeStorage`, never in the renderer. How other Macs of an Ads2AI or keyless brain know storage is on: `.team-config/media.json` `{ "version": 1, "mediaBrainId": "..." }`, written by the owner or scout who turned it on. It holds no key. Project mini folders never receive `.team-config` (acl `DENY_SEGMENTS`), so project Macs learn it from the worker (`GET /v1/media/state` with their HMAC token), not from that file.

## 7. UI insertion points

No restyle. Reuse existing classes (`set-block`, `set-h`, `field`, `actions tight`, `primary`, `ghost`, `tiny`, `note`, `kicker`). No new CSS unless a class is missing, and then only spacing.

### 7a. Settings, open company block

Add `function mediaStorageOffer()` next to `localSyncOffer()` in `SettingsPanel.tsx` (after line ~537). It returns `<MediaStoragePanel ... />` from a new `src/renderer/src/MediaStoragePanel.tsx` that mirrors `LocalSyncPanel.tsx` (props in, `onDone(detail)` out, `ipcErrorText` for errors). Insert one line in each branch, directly after the existing call. The builder must not move the surrounding controls.

Branch one (can add users), currently:

```tsx
          {localSyncOffer()}
          <div className="set-block">
            <FoldHead title="Project-only people" open={projectFold} onToggle={() => setProjectFold((v) => !v)} />
```

becomes

```tsx
          {localSyncOffer()}
          {mediaStorageOffer()}
          <div className="set-block">
            <FoldHead title="Project-only people" open={projectFold} onToggle={() => setProjectFold((v) => !v)} />
```

Branch two (read-only seats), currently:

```tsx
          {localSyncOffer()}
          <p>You are {seatLabel(seat || role)} in {here}. The owner adds people.</p>
```

becomes

```tsx
          {localSyncOffer()}
          {mediaStorageOffer()}
          <p>You are {seatLabel(seat || role)} in {here}. The owner adds people.</p>
```

`mediaStorageOffer()` returns `null` when `window.brain.media.status()` says the worker has no media routes (packed app before the worker is live), so nothing appears until the feature is real.

Panel copy (US English, short):

- Off, owner or scout: heading **Videos and images**. "On this computer. Only this Mac has them." Button **Use Plyntr storage**. Under it, tiny: "Your notes stay in this folder either way."
- Off, anyone else: "On this computer. Your owner can turn on Plyntr storage."
- Turning on, inside the same block: "Choose a passphrase. You will type it, with the email code, to open these videos on a new computer. Plyntr cannot see it or reset it." Six words in a `<code>` line, **Copy**, a field if they want their own, then type it again. Under that, the recovery key: "Save this too. It works if you forget the passphrase." **Copy**, a checkbox "I saved both", **Done**. After Done both are gone from the screen.
- On: "Plyntr storage is on." Tiny line: "Used 1.2 GB of 50 GB." or, with no limit yet, "Plyntr has not set a limit for this brain yet. Uploads start once it does." or, bucket off, "Plyntr storage for this brain is not turned on yet. Plyntr will let you know."
- On, owner or scout: `field` select "Project" (project roots in this folder), button **Add a video or image**. A `WorkPulse` "Uploading 34%" while it runs.
- On, owner or scout, waiting approvals: rows "Waiting: John · Mac ABCD-EFGH · Bible" with **Allow**.
- On, anyone: tiny "This Mac: ABCD-EFGH." Owner or scout sees **This computer is lost** (email code, then passphrase or recovery key, then the other computers with **Remove**). A computer that already has the key can **Add a person** with the invite that already exists. Removing a computer that had the whole brain asks for the passphrase again on that screen.
- On, project member: "You can watch videos in the projects you are on."
- Superadmin only (`joe && superAdmin`), directly under the existing `PackSelect` in the same block: a `field` "Storage limit (GB)" with **Save**, and **Turn on storage for this brain** (calls the platform route; refuses unless the worker switch is on). This is Joe's control; customers never see it.

### 7b. Setup follow-up question

The question sits at the end of each path, not right after the fork click, because no brain folder or seat exists yet at the fork. Add `screen: 'storage-ask'` in `FirstRun.tsx`, rendered in the same shell as the `plyntr-wait` screen (kicker, h1, p, `actions`). Replace the six `go('chat', patch)` calls with `goChat(patch)`. `goChat` shows `storage-ask` once per brain path when the session role is owner or scout (or Joe), storage is not already on, and the question has not been answered for that path (`userData` prefs key `mediaAsked`). Otherwise it calls `go('chat', patch)` exactly as today. The fork screen is not touched.

- kicker: "Videos and images"
- h1: "Where should big videos and pictures live?"
- p: "Your notes stay in this folder either way. Big files can stay on this computer, or go to Plyntr storage so the people on each project can watch them."
- primary: **Keep on this computer** (records the answer, continues to chat)
- ghost: **Use Plyntr storage** (runs enable; for a keyless or Ads2AI folder it first asks for the emailed code in a `field` on the same screen; then the passphrase and recovery screen from 7a; then continues to chat)
- On any enable error: the `note` line, and **Keep on this computer** still continues. Setup never blocks on storage.

### 7c. Playback (inside the existing file tab)

`files.ts` `readSafe` returns `kind: 'media'` for a file ending `.media.md` whose front matter parses. `openFile` in `TerminalWorkspace.tsx` stores `fileKind: 'media'` and the parsed `{mediaId, title, mime, bytes}`. The file tab body renders `<video controls src="brain-media://<mediaId>">` or `<img src=...>` in place of the markdown html, and the title line above it. Same tab, same place. Errors show as a `note` line: "You are not on this project.", "This Mac is not approved yet. Ask your owner.", "Needs the internet the first time.", "This file could not be opened."

`protocol.handle('brain-media', ...)` in main (registered as a privileged, streaming scheme before `app.ready` in `src/main/index.ts`) looks up the object, checks access, downloads to cache if missing, and serves decrypted bytes with Range support by decrypting only the chunks the range covers. The renderer only ever holds `brain-media://<mediaId>`.

## 8. Pointer file

Path: `<root>media/<slug>--<id8>.media.md`, where `<root>` is the project root (`projects/<name>/` or `clients/<name>/`). Example: `projects/bible/media/sermon-intro--3f9a1c2b.media.md`. `<slug>` is the title lowercased to `[a-z0-9-]`, max 48 characters; any word matching `SENSITIVE_TOKEN` (salary, payroll, private) is dropped, because `brain-sync/app/src/scan.js` skips such names for project seats. `<id8>` is the first 8 hex of the media id, so two people adding "Intro" get two pointers.

Exact content (front matter keys are the whole schema; the writer refuses any other key):

```markdown
---
brain_media: 1
media_id: 3f9a1c2b-7d41-4c1e-9a0b-2f5e8c6d1a90
title: Sermon intro
mime: video/mp4
bytes: 184233112
added: 2026-10-02
---
Sermon intro. Video, 176 MB, kept in Plyntr storage. Open it in Brain.app to watch.
```

No key, no bucket, no URL, no scope id, no uploader email. Agents read it like any note. Moving a file to another project moves the pointer file with it (`git mv` equivalent on disk; the sync picks it up). Deleting a pointer by hand does not delete the object; Settings lists objects without a pointer under "Not in any folder" (later slice, see 15).

## 9. Data model in D1 (`brain-sync/migrations/0004_media.sql`)

- `media_brains(id, plyntr_brain_id, hq_repo, label, bucket, bucket_status, cap_bytes, used_bytes, reserved_bytes, brain_key_version, recovery_wrap, created_by_email, created_at, status)`. `cap_bytes` NULL means no uploads.
- `media_seats(id, media_brain_id, email, name, role, roots, token_hash, status, created_at)` for `pms_` seats only.
- `media_invites(id, media_brain_id, email, name, role, roots, code_hash, status, expires_at, created_at)` for `pms_` brains only. Plyntr brains keep using `/v1/invites`.
- `media_devices(id, media_brain_id, email, seat_kind, seat_ref, public_key, fingerprint, label, status, created_at, revoked_at)`.
- `media_scopes(id, media_brain_id, root, key_version, needs_rotation, created_at)`.
- `media_wraps(id, media_brain_id, scope, key_version, target, device_id, eph_pub, nonce, ciphertext, created_by_device, created_at)`. `scope` is a scope id or `brain`. `target` is `device` or `brain` (escrow).
- `media_objects(id, media_brain_id, scope_id, object_key, bytes, cipher_bytes, mime, dek_wrap, dek_version, status, upload_id, part_count, created_by_email, created_at)`. `status` is `uploading | ready | deleted`.

`memoryMediaStore()` mirrors `memoryPlyntrStore()` for tests and dry-run.

## 10. Worker routes (`brain-sync/src/media-v1.js`, dispatched from `worker.js` before `handlePlyntrV1` when the path starts with `/v1/media/`)

Auth kinds: **full** = `pbt_` owner/scout/team or `pms_` full; **project** = HMAC project token or `pms_` project; **builder** = owner or scout (full); **platform** = `requirePlatform` (Joe).

| Method and path | Who | Writes | Failure codes |
| --- | --- | --- | --- |
| `GET /v1/media/health` | anyone | no | 200 only; the app hides the block on 404 |
| `POST /v1/media/codes/email` | anyone (email) | invite row | 400 bad email, 429 rate, 404 never names brains |
| `POST /v1/media/brains` (turn on) | builder `pbt_`, or `{email, code}` claim for keyless/Ads2AI | brain row (bucket off, no cap), device, brain-key wrap, recovery wrap, `pms_` seat for a claim | 401, 403 not a builder, 409 `exists` (returns the id so this Mac joins instead) |
| `GET /v1/media/state` | full or project | no | 401, 410 `device_revoked` |
| `POST /v1/media/devices` | full or project | device row, `pending` | 401, 409 already registered |
| `POST /v1/media/wraps` | builder with a key for that scope | wrap rows | 403 target device's seat does not cover the scope, 409 stale version |
| `POST /v1/media/scopes` | builder | scope row, escrow wrap, member wraps | 400 root fails `normalizeRoot`, 409 exists |
| `POST /v1/media/uploads` | builder | object row `uploading`, reservation | 403, 403 `wrong_project`, 409 `no_cap`, 413 `over_cap`, 423 `bucket_off` |
| `POST /v1/media/uploads/:id/parts` | the uploader | no | 403, 404, 409 part out of range |
| `POST /v1/media/uploads/:id/complete` | the uploader | status `ready`, usage | 409 size mismatch after `HEAD`, 404 |
| `POST /v1/media/uploads/:id/abort` | the uploader or builder | releases reservation | 404 |
| `POST /v1/media/objects/:id/download` | full, or project whose roots contain the scope | no | 403 `wrong_project`, 404, 410 `device_revoked`, 423 `bucket_off` |
| `POST /v1/media/objects/:id/move` | builder | scope id, new `dek_wrap` | 403, 409 stale version |
| `DELETE /v1/media/objects/:id` | builder | object deleted, usage released | 403, 404 |
| `POST /v1/media/rotate-scope` | approved builder device that already holds the brain key | one project key, rewrapped DEKs, old project wraps deleted | 409 stale version |
| `POST /v1/media/invites`, `/v1/media/invites/redeem` | builder of a `pms_` brain; redeem by email + code | invite, seat | 403, 410 used or revoked |
| `POST /v1/media/reclaim/start` | owner or scout email plus a one-time code, and the new device public key | returns salt, parameters, wraps, and a challenge. Token is single-use, 10 minutes, bound to that email, brain, and device public key | 401 bad code, 403 team, project, revoked, or unknown email, 429 |
| `POST /v1/media/reclaim/finish` | that token, plus a signature of the challenge by the passphrase key or the recovery key | new approved device, its brain-key wrap, and a builder token kept in the main process (`pbt_` if this email already has one, otherwise `pms_` owner) | 403 bad signature, token reuse, or a different device key |
| `POST /v1/media/wrap/passphrase` | signature by the current passphrase key or the recovery key, plus the new wrap and the new proof public key | replaces the passphrase wrap in one batch | 403, 409 stale version |
| `POST /v1/media/rotate` | signature by the passphrase key or the recovery key | new brain key, every project key, each DEK rewrapped under its new project key, new project-key wraps for every kept project device, new brain-key wraps for every kept full-brain device, new passphrase wrap and proof public key, new recovery wrap and proof public key, old wraps and the old recovery public key deleted, one batch | 403 bad signature, 409 stale |
| `POST /v1/media/seats/:id/revoke`, `/v1/media/devices/:id/revoke` | builder (same rules as `canRevokeSeat`). Without a proof signature, a full-brain device is only blocked from new downloads. Wraps stay. With a proof signature, that device's wraps are deleted and `/rotate` runs in the same request | project device: wraps deleted, `needs_rotation` on that scope. Full-brain device without proof: `blocked`, no wipe | 403, 404 |
| `POST /v1/media/brains/:id/cap` | platform | `cap_bytes` | 403 |
| `POST /v1/media/brains/:id/bucket` | platform, and only with `MEDIA_BUCKETS_LIVE=1` | creates bucket, `bucket_status = on` | 403, 423 switch off |

Minting rules reuse `canMint` and `canRevokeSeat` from `plyntr-v1.js` so storage never lets a team or project seat grant access.

## 11. Revoke, rotation, and other Macs

**Revoke hooks.** Four paths end in `markMediaRevoked(email, brain, roots?, proof)` in `media-v1.js`: `/v1/seats/:id/revoke` in `plyntr-v1.js` (after `store.revokeSeat`), the hq-sync `/owner/seats` revoke that `revokeProjectSeat` in `hq-sync.ts` calls (hook in `brain-sync/src/index.js` near the `/owner/seats` response handling), `/v1/media/seats/:id/revoke`, and `/v1/media/devices/:id/revoke`. The seat routes do not carry a proof. For a project seat they still delete that person's project wraps, set `needs_rotation` on those scopes, and the next state call is 410 `device_revoked`. That 410 is what deletes the media folder. For a full-brain seat with no passphrase or recovery signature, they only set the devices to `blocked`, so new downloads stop and the state call is 401. Wraps stay. The folder stays. A full-brain revoke that includes the signature returns 410 and then the folder is deleted. `brain_rotation_pending` names that person. Uploads and `rotate-scope` return 423 until a passphrase or recovery signature completes `/rotate`. The Mac shows "Type your passphrase to finish removing X." A 401 does not wipe the media folder. A 410 `device_revoked` after a proven revoke does.

**Rotation rule.** Removing a project computer rotates that project's key only. An owner Mac that already holds the brain key does it on check-in, with `POST /v1/media/rotate-scope`. The passphrase and the recovery key stay as they are.

Removing a computer that had the whole brain (owner, scout, or team) is allowed only with a passphrase or recovery signature. The same request rotates the brain key and every project key. For each file, the DEK is unwrapped with the old project key and wrapped with the new one, in that batch, so existing files still play. The passphrase stays the one they typed, and its wrap and proof public key are replaced to seal the new brain key. The recovery key is shown again, new, once. Its wrap and its proof public key replace the old ones in the same batch, so the old recovery key cannot unwrap and cannot sign. The batch wraps the new brain key to every full-brain computer they are keeping, and wraps each new project key to every kept device whose roots include that project. Then it deletes the old wraps. A check-in never rotates the brain key. While `brain_rotation_pending` is set, `rotate-scope` and uploads return 423, so a new project key is never sealed under a brain key a removed person still holds. If the request fails, the server keeps the old wraps. Object bytes are not re-encrypted. Re-encrypting bytes ("Seal again") is later.

**Lost computer.** On a new Mac the owner or scout asks for an email code, then types the passphrase or the recovery key. `reclaim/start` takes the new device public key and returns the salt, the scrypt parameters, the wraps, and a challenge. The token is single-use, expires in 10 minutes, and is bound to that email, that brain, and that device public key. The response has no private key, no download URL, and no builder token. The Mac unwraps locally and signs the challenge. `reclaim/finish` checks the signature, stores the device as approved, and returns a builder token to the main process only. From that screen they remove the old computer and can add another person. The old computer does not have to be online, and it does not have to approve. A device that arrives from an email code before a known Mac has approved it is labeled "New sign-in by email, not approved on a known Mac."

**What the copy tells the owner** after Remove: "John can't open new files here anymore. Copies he already opened stay deleted from his Mac once his app checks in. Anything he saved another way, we can't take back."

**Other Macs on next check-in.** Brain.app calls `GET /v1/media/state` when Settings opens, when the window gains focus, and every 10 minutes while running (ASSUMED; no code decides this today; `sync-health.ts` polls git health on its own timer and is not reused). If the key version moved, it fetches new wraps. A 401 leaves the media folder in place. A 410 `device_revoked` deletes it. 410 is returned for a project revoke, and for a full-brain revoke that included a passphrase or recovery signature. A blocked full-brain device without that signature gets 401. Owner or scout Macs also run pending project-key rotations and auto-wraps. That timer never rotates the brain key and never writes a passphrase wrap or a recovery wrap.

## 12. Offline cache

`userData/media/<mediaBrainId>/`:
- `device.key` (sealed private key, mode 600)
- `wraps.json` (wrapped keys for this device only; useless without `device.key`)
- `cache/<mediaId>.bin` (ciphertext exactly as downloaded, same format as the object)
- `minted.json` (invites this Mac minted, for auto-wrap)

Playback decrypts chunk by chunk from `cache/` on demand. Nothing plaintext is written to disk. Offline playback works for anything already in `cache/`, because `wraps.json` plus `device.key` unwrap locally. A first view or an upload needs the network. The markdown brain works offline either way. Cache limit 20 GB per Mac, least recently used out first (ASSUMED; no code decides this today; the 20 MB attach cap in `attach.ts` is unrelated).

On revoke, on **Remove this Mac**, on logout of that seat, or when this brain is removed from this Mac: delete the whole `userData/media/<mediaBrainId>/` folder, drop that brain's `pms_` entry from `userData/media/seats.json` if there is one, and clear the in-memory key map.

## 13. Billing cap

- Stored in D1 `media_brains.cap_bytes`, set only by Joe through the platform route (the Settings superadmin field in 7a).
- `POST /v1/media/uploads` refuses with 409 `no_cap` when the cap is NULL, and 413 `over_cap` when `used_bytes + reserved_bytes + cipher_bytes > cap_bytes`. Reservation is taken at upload start and turned into usage on complete, so two big uploads at once cannot pass the cap together.
- What the person sees: "This brain's storage is full. Ask Plyntr to raise the limit." (over cap) or "Plyntr has not set a storage limit for this brain yet." (no cap). The used line in Settings: "Used 48.2 GB of 50 GB."
- No price appears in the app. Internal note only: R2 Standard is $0.015 per GB-month with free egress (Cloudflare R2 pricing, August 2026); Gene's 2 TB is about 2,048 GB × $0.015 = $30.72 a month on Plyntr's card.

## 14. Ordered slices

Each slice leaves the app usable if later slices never land. No slice deploys brain-sync; brain-sync has 78 uncommitted files today, and deploy waits for a clean tree and Joe. Large change, so each slice goes through `xhigh-gate` (plan, then diff) per `.claude/rules/poteto-mode.md`.

1. **Crypto, format, pointer, fake worker (no bucket, no network, no UI, no medium-case check).** brain-app `src/main/media/{crypto,format,keys,device-key,pointer,cache,transport,dry-worker}.ts` and their unit tests; brain-sync `src/media-v1.js`, `src/media-store.js` (`memoryMediaStore`), `test/media-v1.test.js`. `transport.ts` under `BRAIN_APP_DRY_RUN=1` loads `media-v1.js` in process (the same way `hq-sync.ts` imports `src/tokens.js` from `syncRoot()`) with a directory bucket at `userData/media-dry-bucket/`; it refuses any URL on `r2.cloudflarestorage.com` and never loads `r2-admin.js` while dry-run is on. The in-process bucket route only makes a directory under `userData/media-dry-bucket/<bucket>/` and sets `bucket_status = on`. Loading `media-v1.js` from `~/Projects/brain-sync` is a dev-only dependency (it exists on Joe's Mac for `npm run dev`); a packed build never loads it. Slice 1's gate is `npm run typecheck` plus the crypto, format, and pointer unit tests, plus `node --test test/media-v1.test.js` in brain-sync. Those tests cover chunk boundaries, a bad GCM tag, a missing last chunk, `no_cap`, `over_cap`, two reservations that cannot both pass the cap, a scrypt wrap that opens with the passphrase and fails with one wrong character, a wrap that opens with the passphrase and fails with one wrong character, and a rotate or wrap replace that is refused when the signature is missing, wrong, or made from the brain key instead of the passphrase key. They do not pretend to be the medium-case check. Users see nothing.
2. **Settings block and setup question (dry-run live, packed hidden).** `MediaStoragePanel.tsx`, `mediaStorageOffer()`, `goChat` and `storage-ask`, preload `media:*` IPC, recovery-key one-shot IPC. Packed app hides the block because `/v1/media/health` is 404 on the live worker. Until slice 6 lands, the switch (Settings and `storage-ask`) shows only when `seatTokenForFolder(folder)` is non-empty (a `pbt_` seat exists); Ads2AI and keyless folders see "On this computer." with no button, and `storage-ask` is skipped for them. This slice runs §17 steps A, B, and the enable/add/recovery half of the medium case (steps 1–4 and 12). Playback steps wait for slice 3.
3. **Playback.** `brain-media` protocol, `readSafe` `media` kind, file tab body, cache, state poll. This slice plays the file as the owner on device A (the play and crossing-range assertions in step 6, caller A), plus steps 8–11 and 13. Devices B and C, and steps 6 and 7 as written for them, wait for slice 5.
4. **Real worker plumbing, not deployed.** `migrations/0004_media.sql`, `d1MediaStore`, `src/r2-presign.js` (SigV4), `src/r2-admin.js` (bucket create behind `MEDIA_BUCKETS_LIVE`), cap route, superadmin cap field. Tests with a stubbed `fetch`.
5. **Grants, revoke, rotation.** Auto-wrap from `minted.json`, Allow rows, the four revoke hooks, rotation, revoke wipe on the Mac. This slice runs steps 5, 6, 7, 14, and 15, so steps A, B, and 1–15 all pass together. After this slice the worker is ready for Joe to deploy (clean tree, his yes).
6. **Ads2AI seats, and reclaim on a new computer.** `/v1/media/codes/email`, `pms_` seats and invites, `.team-config/media.json`, `reclaim/start`, `reclaim/finish`, passphrase or recovery key on a new Mac, remove of the old computer, add a person from that Mac. This slice runs §17 steps 16 through 22.
7. **Joe turns it on for one brain.** Secrets set, one bucket, one cap. Manual and gated on Joe, not code.

## 15. Explicitly later (add to agency-brain `todo/deferred-backlog.md` on the day slice 1 starts, per working preference 9)

Google Drive import of Gene's 2 TB; per-file grants or a one-file exception list; a customer's own Cloudflare account; live co-editing; replacing git; "Seal again" byte re-encryption; turning storage off and deleting a bucket; "Not in any folder" list for orphaned objects; thumbnails and transcoding; phone playback through the Phone tunnel; Windows click-check.

## 16. Failure modes (written before code)

| Case | What happens |
| --- | --- |
| Wrong project | Project seat asks for an object whose scope root is outside its roots: 403 `wrong_project`. The pointer never reached that Mac anyway (mini sync filters by roots). File tab: "You are not on this project." |
| Revoked seat | A project revoke returns 410 and that Mac deletes its media folder. A full-brain revoke with a passphrase or recovery signature also returns 410 and deletes the folder. A full-brain device blocked without that signature returns 401 and the folder stays. The brain key does not change on check-in. Plaintext they already exported is out of reach, and the copy says so. |
| Lost recovery key, passphrase remembered | A new computer uses the email code and the passphrase. The old recovery key is already useless after the next full-brain remove, which shows a new one. |
| Lost passphrase, recovery key saved | The same screen accepts the recovery key instead. They set a new passphrase in that session. |
| Lost passphrase, lost recovery key, every Mac gone | Files are unrecoverable. The turn-on screen says this before Done. An email code does not reset it. |
| Inbox can read the owner's mail | `reclaim/start` succeeds and returns the locked wrap. `finish`, revoke, rotate, and wrap replace return 403. The wrap on the server is unchanged. |
| Stolen Mac tries to change the passphrase or remove the owner's other computer | Those routes need a signature from the passphrase key or the recovery key. The brain key on that Mac cannot make it. The routes return 403 and the wraps stay. |
| Email code revokes a seat through `/v1/seats/:id/revoke` | Full-brain devices are blocked from new downloads. Their wraps stay. No Mac wipes its media folder on that 401. The screen asks for the passphrase before the brain key changes. |
| Two people upload the same name | Different media ids, different `--<id8>` pointer names. No overwrite. |
| Presign expires mid-upload | Part PUT returns 403; Mac asks `/parts` again for that part and retries it (3 tries, then pause with "Upload paused. It will pick up where it stopped."). Parts already sent stay. Resume state in `userData/media/<id>/uploads/<mediaId>.json`. |
| Ads2AI brain with no Plyntr seat | Turn on asks for an emailed code; creates a `pms_` storage seat. GitHub sync mode does not change. |
| Local-only invite | Keyless: storage owner mints a storage invite (full or project roots); the invitee redeems it in the same Settings block. Wizard local with `brainId`: the existing `plyntr:invite` path, storage follows the seat. Access to the folder itself is unchanged: a local-only brain has no git sync, so the invitee also needs the folder (their own sync choice). |
| Dry-run | `BRAIN_APP_DRY_RUN=1`: in-process worker and directory bucket. The in-process bucket route only creates a local directory. `r2-admin.js` (real Cloudflare API), real SigV4 presign, and any `r2.cloudflarestorage.com` URL throw. The check asserts no network call was made. |
| Token sent to the renderer | Every `media:*` IPC return passes `assertRendererSafe()` which throws on keys named `token`, `seatToken`, `key`, `wrap`, `dek`, `url` (except `brain-media://`), or values matching `pbt_`, `pms_`, a SigV4 query, or 43/44-character base64. Check 16 exercises it. |
| Key committed into git | Pointer writer only writes the six schema keys and refuses any value that looks like base64 key material. The check greps the fixture folder (tracked and untracked) for key patterns and fails if found. Keys never exist on disk outside `userData`. |
| Cap exceeded | 413 `over_cap`; reservation not taken; Settings line "This brain's storage is full. Ask Plyntr to raise the limit." |
| No cap set | 409 `no_cap`; "Plyntr has not set a storage limit for this brain yet." |
| Device with the key offline when a new person is invited | The new device stays `pending`; John's file tab says "This Mac is not approved yet. Ask your owner." Any builder Mac with the brain key, or a recovery key on any builder Mac, can wrap it. Nothing is wrapped by the worker. |
| `safeStorage` not available | Storage will not turn on or join on that Mac: "This Mac can't keep the storage key safe, so storage stays off here." |
| Pointer title has "private" or "payroll" | Word dropped from the file name so project mini sync does not skip it. |
| Pointer present, object deleted | File tab: "This file was removed from storage." |
| Tampered or truncated ciphertext | GCM tag fails; "This file could not be opened."; cache entry deleted. |
| Two owner Macs turn storage on at once | Second gets 409 `exists` with the id and joins as a pending device; the first Mac approves it. |
| Rotation race (two builder Macs) | Version check on `/rotate`; the loser gets 409 and refetches. |

## 17. End-to-end check (medium case)

The full command runs from the end of slice 5, from `/Users/joewine/Projects/brain-app`:

```
BRAIN_APP_DRY_RUN=1 node --experimental-strip-types scripts/check-media.ts
```

Pattern: `scripts/check-shell-switch.ts` (real main modules and IPC handlers, Electron stubbed). `safeStorage` stub seals with a per-run random key so the sealing path is real code. Earlier slices run only the steps they can, and the script fails if a step from a later slice is skipped while claiming `MEDIA_PASS`. Slice 1 does not run this script.

**Slice 1 gate, before this script exists.** Crypto, format, and pointer unit tests in brain-app, plus `node --test test/media-v1.test.js` in brain-sync against `memoryMediaStore`. Those tests use a 64 KiB chunk and a file of at least 5 chunks. They fail a flipped ciphertext byte, a missing last chunk, an upload before any cap (`409 no_cap`), an upload over the cap (`413 over_cap` with no reservation and no object), and two uploads started together whose sizes sum past the cap (exactly one reservation). `npm run typecheck` in brain-app.

**Dry-run knobs, test only.** `BRAIN_APP_DRY_RUN=1` may set chunk size to 64 KiB, multipart part size to 64 KiB, and the multipart cut-over to 256 KiB. Production stays at 4 MiB chunks, about 64 MiB parts, and a cut-over near 64 MiB. The check sets all three and refuses to run if any one is still at the production size.

**Project-seat tokens in this check.** Devices B and C do not receive a `pbt_` token. The dry-run store mints each one the way `/auth/exchange` does: an HMAC seat payload `{seat_id, email, hq_repo, device_id, kind: "client-project", roots}` signed with the test `BRAIN_SYNC_SEAT_TOKEN_KEY`, verified by `verifySeatToken` in `brain-sync/src/tokens.js`. `hq_repo` is the fixture repo. The worker resolves that repo to the dry-run brain, then to the active project row for that email, then to `roots`. A `pbt_` token on B or C fails the check.

Steps:

A. A brain that records **Keep on this computer**, and a brain that never answers, make no call to `/v1/media/` and have no `userData/media/` directory.
B. Render the fork screen fixture: `choice-stack` contains exactly the three buttons Sign in, I have a code, and This computer only. `storage-ask` is not rendered when the session role is team or project. With storage on and with it off, `chooseWatcher` is called the same number of times and `startBrainSync` is called the same number of times.
1. Make a temp local-only brain from the dry-run fixture (`copyDryRunFixture`) with `projects/alpha/` and `projects/beta/`, `syncMode: 'local'`, an owner `pbt_` seat in the dry-run store.
2. Owner device (temp userData A) turns storage on through the `media:enable` IPC handler. Capture the recovery key through the one-shot IPC, then assert a second call returns nothing.
3. Before any cap is set, the owner tries to add a file. Expect `409 no_cap` and no object. Then Joe's platform call sets a 10 MB cap and turns the bucket on in the in-process worker, which only creates `userData/media-dry-bucket/<bucket>/` (no Cloudflare call).
4. Owner adds one file under `projects/alpha/` through `media:add`. The file is at least 5 chunks at the 64 KiB dry-run chunk size (at least 320 KiB). With the 64 KiB dry-run part size and the 256 KiB cut-over, that file is sent as at least 3 multipart parts. Its bytes contain the marker `PLAINTEXT-MARKER-7f3c`.
5. Mint a project seat for `alpha-person@example.test` with roots `projects/alpha/`, one for `alpha-keeper@example.test` with the same roots, and one for `beta-person@example.test` with `projects/beta/`, using the HMAC tokens described above. Device B (temp userData B), device F (temp userData F, the alpha keeper), and device C (temp userData C) register with those tokens. Owner check-in auto-wraps B and F for alpha because both invites were minted on A. C gets a beta key only.
6. Slice 3 runs this play as device A, the owner, who already holds the key. Slice 5 runs it again as device B after step 5. The bytes equal the source file (SHA-256 match). A Range request starts inside one chunk and ends on the last byte of the file, crossing at least one chunk boundary, and those bytes match the same span of the source.
7. C fetches the same id with C's HMAC token: `403 wrong_project`, and C's `wraps.json` has no alpha scope. The same fetch with a `pbt_` token is not part of this step and is not accepted as a substitute.
8. Read the object from `userData/media-dry-bucket/`: marker absent, header magic `BRMEDIA1`, SHA differs from plaintext.
9. Read the pointer at `projects/alpha/media/*.media.md`: exactly the six keys, no base64 run of 40+ characters, no `pbt_`, `pms_`, `X-Amz-`, or `bm-`.
10. Every IPC return seen in the run passed `assertRendererSafe`.
11. No socket opened. The harness replaces `fetch`, `net.connect`, `tls.connect`, and `https.request` with throwers. `r2-admin.js` is absent from the module registry at the end of the run.
12. Dump every `memoryMediaStore` row and walk the whole dry-run `userData` tree. None of them contain the raw brain key, any project key, any DEK, or the recovery key, as raw bytes, hex, or base64. The harness knows those values from memory during the run and searches for them. Separately, take `dek_wrap` and the project-key wrap from the store, without `device.key`, and assert they do not decrypt the object.
13. Copy the dry-run object, flip one byte in the first ciphertext chunk, and play it: the file tab error is "This file could not be opened." and the cache entry is gone. Repeat on a fresh copy with the last chunk deleted. Same error, cache entry gone.
14. Start two uploads whose ciphertext sizes sum to more than the remaining cap. Exactly one receives a reservation. The other is `413 over_cap`, and no second object is written.
15. Revoke B, a project device. This route carries no passphrase signature. B's next `GET /v1/media/state` with B's HMAC token returns 410 `device_revoked`, and B's `userData/media/<id>/` directory is deleted. A 401 would not delete it. Copy B's `wraps.json` and sealed `device.key` aside before that wipe. The owner's next check-in bumps the alpha key version, wraps that new project key to F, and the worker has deleted B's old wraps. The brain key version does not change. Upload a second file into alpha and assert its `dek_wrap` uses the new project key version. The saved old wrap cannot unwrap that new file. A download request with B's HMAC token is refused. F still plays the file from step 4.
16. Device D has no files yet. `reclaim/start` with the owner's email code and D's device public key returns the salt, the parameters, the wraps, and a challenge. The body has no private key, no `pbt_`, no `pms_`, and no download URL. The same call returns 403 and no wrap for the project email, a team email, a revoked owner, and an email that is not a member. No response in the whole run contains the passphrase, the recovery key, the scrypt output, or an Ed25519 private key.
17. `reclaim/finish` reuses that token with a signature from the brain key. It returns 403. No device row is written. The passphrase wrap bytes are unchanged. Using the token a second time also returns 403.
18. A new code, then `reclaim/finish` with a signature from the passphrase key, approves D and returns a builder token to the main process only. Playback of the alpha file matches the source. `media:takePassphrase` and `media:takeRecoveryKey` each returned their secret once during step 2, and a second call for either returned nothing. The fixture folder, tracked and untracked, and the artifact do not contain the six words or the `RK1-` string.
19. `POST /v1/media/wrap/passphrase` with only the email code returns 403. The same route with a signature from the recovery key installs a new passphrase. The passphrase from step 2 no longer unwraps. The new one does. The recovery key still unwraps the current brain key. This happens before any brain-key rotation.
20. Device E is enrolled as a second full-brain Mac with a device wrap of the current brain key and with no passphrase. While A, D, and E are all still approved, E tries rotate, revoke of D, and replace of both wraps, signing with the brain key it unwrapped from its own device wrap. All return 403 and the wrap bytes are unchanged. The same attempts with a fresh reclaim token plus that brain-key signature also return 403.
21. Device D removes device A with a signature from the passphrase installed in step 19. The brain key version increments. Every DEK is rewrapped under the new project key. That passphrase unwraps the new brain key. A's saved brain-key wrap does not unwrap the new project key. D still plays the file from step 4. Device F, a project member on alpha enrolled before step 15 and not revoked, also still plays it, because F received the new project-key wrap. B was revoked in step 15 and is not the playback check. The old recovery key's signature is rejected on finish, wrap replace, and rotate. A's next state call is 410 `device_revoked`, and only that 410 deletes A's media folder. The old recovery key does not unwrap the new brain key. A new one was returned once. E was in the kept set, so E's device receives a wrap of the new brain key and still cannot sign with it.
22. An owner email code redeems a `pbt_` token and calls `/v1/seats/:id/revoke` on a full-brain seat, with no proof signature. Devices are `blocked`. Passphrase wrap and recovery wrap bytes are unchanged. The brain key version is unchanged. A check-in does not rotate it. `rotate-scope` and a new upload return 423. No media folder is wiped. The screen string is "Type your passphrase to finish removing".

Artifact: `z-logs/media-check/medium-<YYYYMMDD-HHMMSS>.json` with `{ pass, steps, objectSha256, plaintextSha256, markerInObject: false, pointerPath, pointerKeys, seatB: { status: 200, shaMatch: true, rangeOk: true, token: "hmac" }, seatC: { status: 403, error: "wrong_project", token: "hmac" }, recoveryShownOnce: true, passphraseShownOnce: true, bareKeysInStore: false, bareKeysOnDisk: false, dekWrapAloneDecrypts: false, reclaim: { projectStart: 403, teamStart: 403, revokedOwner: 403, stranger: 403, brainKeySignature: 403, tokenReuse: 403, finishPlays: true, emailCannotReplaceWrap: true, recoveryCanReplacePassphrase: true, deksRewrapped: true, fStillPlays: true, dStillPlays: true, oldRecoveryCannotSign: true, oldBrainKeyFails: true, stolenRotate: 403, seatRevokeWithoutProof: { blocked: true, wrapBytesSame: true, brainVersionSame: true, rotateScope: 423, wiped: false } }, tamper: { flipped: "refused", truncated: "refused" }, cap: { before: 409, over: 413, raced: 1 }, revoke: { state: 410, wiped: true, rotated: true, oldWrapFails: true, downloadRefused: true }, forkButtons: 3, watcherDelta: 0, rendererChecks, network: 0 }`. Last stdout line `MEDIA_PASS` or `MEDIA_FAIL <step>`. The artifact never contains a key, a token, or the recovery key.

The Settings block is checked in `settings-check-entry.tsx` for both `biz current` branches (the new block sits between `localSyncOffer` and the next element, nothing else moved). That check lands with slice 2.

## 18. Files to touch

**brain-app**
- New: `src/main/media/crypto.ts`, `format.ts`, `keys.ts`, `device-key.ts`, `pointer.ts`, `cache.ts`, `transport.ts`, `dry-worker.ts`, `protocol.ts`, `state-poll.ts`, `ipc.ts`, `renderer-safe.ts`, plus `*.test.ts` for crypto, format, pointer, renderer-safe; `src/shared/media.ts` (renderer-safe types and copy); `src/renderer/src/MediaStoragePanel.tsx`; `scripts/check-media.ts`.
- Changed: `src/renderer/src/SettingsPanel.tsx` (import, `mediaStorageOffer()`, two inserted lines, superadmin cap field under `PackSelect`); `src/renderer/src/FirstRun.tsx` (`goChat`, `storage-ask` screen); `src/renderer/src/TerminalWorkspace.tsx` (`openFile` media branch, file tab body); `src/main/files.ts` (`readSafe` `media` kind); `src/preload/index.ts` (`media` namespace); `src/main/index.ts` (register `brain-media` scheme before ready, `registerMediaIpc`); `src/main/ipc-stubs.ts` (record minted project invites in `plyntr:invite` and hq `addProjectSeat`, call media wipe after `plyntr:revokeSeat` and `hqSync:revoke`); `src/renderer/src/settings-check-entry.tsx`; `GOAL.md` Inbox line when slice 1 starts.

**brain-sync**
- New: `src/media-v1.js`, `src/media-store.js`, `src/r2-presign.js`, `src/r2-admin.js`, `migrations/0004_media.sql`, `test/media-v1.test.js`.
- Changed: `src/worker.js` (dispatch `/v1/media/`), `src/plyntr-v1.js` (call `markMediaRevoked` in `/v1/seats/:id/revoke`), `src/index.js` (same after an `/owner/seats` revoke). `wrangler.toml`: comment listing the secret names only; secrets are set with `wrangler secret put` by Joe later.

## Conflicts with the locked decisions

1. **Decisions 4 and 16 vs 7.** The recovery key and the generated passphrase are each shown once. Smallest change: one-shot IPC `media:takeRecoveryKey` and `media:takePassphrase`. Each returns its secret a single time, then main zeroes it. Never logged, never persisted, never sent again. These are the only exceptions. A passphrase the person typed goes from the renderer to main and is not returned.
2. **Decision 8's framing.** "This computer only" already redeems a Plyntr code and stores a `pbt_` seat (`onLocal` → `plyntr-code` with `channel: 'local'` → `putFolderLocal` requires `brainId`). So local-only from the wizard reuses its seat. The email-code storage seat is needed only for Ads2AI folders and keyless local folders. No code change; the plan follows the decision where it applies.
3. **Decision 12 names `projects/<name>/`.** Project seat roots may also be `clients/<name>/` (`normalizeRoot` in `acl.js`). Smallest change: the pointer sits under whichever root the file belongs to (`<root>media/`).
4. **Decision 16, "same rule as today's seat tokens."** Today's seat tokens are plain JSON in `userData/vault.json` (`shell-vault.ts`, no chmod). The rule is applied as the process boundary it is. The device private key goes further (sealed by `safeStorage`). This plan does not change `vault.json`.
5. **Decision 11, "downloaded and decrypted."** The cache keeps ciphertext and decrypts on play, so nothing plaintext sits on disk. Offline playback still works for anything cached. Smallest change that keeps the promise and makes a stolen disk worth less.
6. **Decision 2 names Settings and setup as the only places.** Playback needs a surface. Smallest option: the existing file tab renders a player for a `.media.md` pointer, same tab and same layout (preference 13 holds).
7. **Decision 5, "being invited unlocks."** A device key cannot exist at invite time, so the owner Mac wraps later. Auto-wrap happens only for invites minted on that Mac; anything else needs one Allow click. A worker we changed could still pre-register a device for an invited email (named in the threat model).
8. **Decision 9 for Ads2AI project seats.** Their HQ repo is not in `plyntr_brains`, so project roots come from the HqRepo Durable Object snapshot linked through `media_brains.hq_repo`. ASSUMED (`brain-sync/src/index.js` `/auth/exchange`); verify in slice 6 before building.
