# Factory: files on the right, Guide ack, builder fallback

Joe 2026-09-28 after packed **0.1.87** (GitHub only). Installed Brain.app stays **0.1.86**; do not pack or replace `/Applications/Brain.app`.

Three asks:

1. Factory file hits are listed on the existing collapsible right **In use** rail, not as in-pane cards.
2. Guide Send gets an instant reply: "Just noted." or "Okay, we're filing that with the other work that's already in progress."
3. If Grok cannot run (weekly usage was the live case), fall back to Cursor Grok extra high, then Claude Opus 5.5 as last-resort builder. Grok (raw or Cursor) stays the grunt. Claude plans and reviews. After two Grok/Cursor review-fixes, Claude makes the next correction too.

Chat/Skin/`chat-reach.ts` untouched. Kennel `staging`/`main` never auto-push. Existing FactoryPane widgets stay (WP13); moving cards off the body into the existing right rail is the asked layout, not a redesign. Version stays **0.1.87**.

This file is the locked plan. Opus 5.5 medium implements it.

## Locked decisions

### 1. Files live on In use, not as Factory cards

Today `FactoryPane` keeps a local `files` list and paints `.factory-files` / `.skin-tool` cards in the middle. `TerminalWorkspace` never passes `onFiles` to Factory. When a Factory tab is active, In use still keys off `lastChatId`, so it shows the last Chat's files.

Change:

- `FactoryPane` takes the same `onFiles: (id: string, files: FileHit[]) => void` as Chat. On file events and when the list clears, call it with the Factory tab `id`. Cap stays 40 unique. Unmount / runId change sends `[]`.
- Remove the `.factory-files` card grid from the Factory body. Leave `.factory-files` CSS unused or delete it if nothing else uses it. Skin catalog `.skin-tool` stays.
- When the active tab is `factory`, In use uses `filesByTab[that tab id]`, not `lastChatId`. Chat tabs keep today's `chatId` behavior.
- Empty copy: Factory tab → "Nothing for this run yet." Chat → "Nothing for this chat yet."
- List work-repo paths even when they sit outside the open brain. Click `openFile` only for paths under the brain (`outsideProject` stays). Do not change `files.ts` (explorer stays brain-scoped).
- Edge button that already toggles `filesOpen` is the collapsible control. Do not add a second rail.

### 2. Guide Send always gets an ack bubble

Do not call a model. Persist `ack` on the `GuideNote` in `guideRun` before return, same IPC `factory:guide` / `res.run`.

Copy (US English, no em dash), pick one:

- Work is already in flight, and this Send interrupts or starts a follow-up now (`state.busy` plus interrupt, or failed/paused resume that starts a turn): **Okay, we're filing that with the other work that's already in progress.**
- Otherwise (queued on triage, dirty prep, Proceed, upgrade, waiting plan with no interrupt): **Just noted.**

Renderer: after each `.bubble.me`, if `g.ack` is set, a second `.bubble` (not `.me`) with that sentence. Restore shows it. Existing "Queued until this step finishes." can stay on an unsent note.

### 3. Builder chain: Grok → Cursor Grok extra high → Opus 5.5

Roles stay:

| Job | Who |
|---|---|
| Triage one-shot | Grok `-p` low, skip on fail (already). Usage fail skips; do not block Start. |
| Plan | Opus 5.5 medium, `--permission-mode plan` (unchanged). |
| Review | Opus 5.5 medium, `--permission-mode plan` (unchanged). `REVIEW_MAX` still 5. |
| Grunt build / most fixes | Grok Factory ACP first. |
| Grunt if Grok is unusable | Cursor Grok ACP, extra high. |
| Grunt if Cursor is unusable | Opus 5.5 medium, `--permission-mode bypassPermissions` (can edit). |
| After two Grok/Cursor review-fixes still fail | Next fix is Opus bypassPermissions. |

**Grok unusable** (then Cursor): weekly/quota/usage/credits-exhausted wording in the error; `creditUsagePercent >= 99`; Grok binary missing; Grok auth that cannot continue; `session/new` or `session/prompt` that reports usage. Helper `grokUsageBlocked(err)` in `grok-usage.ts` (or `factory/fallback.ts`). Do **not** treat cancelled, write-block, or a permission card as unusable.

**Cursor unusable** (then Opus builder): `cursor-agent` missing; boot/auth fail; picker has no Cursor Grok model; `session/new` / prompt fail after the Grok→Cursor hop.

**Factory Cursor is not Chat Cursor.** Never `cursorReachArgs`. Never `--sandbox disabled`. Never `--add-dir $HOME`. Never `--always-approve`. Never Chat's `yoloMode`. Same Factory env (shims, no Anthropic keys), same `FACTORY_RULES`, same `factoryWriteBlock` / `filterFactoryPermission`. Spawn: `--trust --workspace <brain> --add-dir <workRepo> acp` (skip add-dir when workRepo is the brain). Own pool key `factory:cursor:<brain>`.

**Model map:** Grok 4.6 / 4.7 high or extra high → the advertised `cursor-grok` id for that family, extra high (`withCursorEffort` / Cursor model bracket). Prefer 4.7 when the Grok session had no 4.6 id. `factorySetEffort` must work on a Factory Cursor tab (today it throws if `kind === 'cursor'`). T2 high and T3 xhigh both pin extra high on Cursor Grok.

**Wiring that is currently Grok-only and must not stay that way:**

- `spawnArgs` factory currently throws `Factory runs on Grok only in this version.` Allow `cursor` with the Factory Cursor argv above.
- `factoryWarm` always `bootPool('grok', ...)`. Try Grok first. On unusable, close that Factory Grok tab, boot Factory Cursor, `session/new`, pin Cursor Grok extra high, keep going. Once a run has fallen back, stay on that builder for the rest of the run (do not flap).
- `factoryPrompt` looks up `poolKey('grok', ...)`. Resolve the tab through `tabPool` so a Cursor Factory tab prompts. Pass `pool.kind` into `deliverAcpPrompt`. If a Grok prompt dies as unusable, hop to Cursor once and retry the same brief.
- If both ACP grunts are unusable, throw a tagged error the controller catches (`FACTORY_NEED_OPUS` or similar). `track()` must not mark `failed` for that hop; the Opus builder turn runs instead.
- Persist `builder: 'grok' | 'cursor' | 'opus'` on the run. Factory head Work repo line can add `Builder: Grok` / `Cursor Grok` / `Opus` as existing tiny text, no new chrome.

**Opus as builder:** new `opusBuildArgs(prompt)` = same as `opusArgs` except `--permission-mode bypassPermissions`. Still `--model opus --effort medium`, prompt in argv, stdin closed, no Anthropic keys, no `--bare`, no HTTP, cwd = work repo, Factory `opusEnv`. Timeout same as review. Stream a status line ("Opus is building") plus stdout as Factory text events if cheap; do not invent an ACP session for Claude.

**Claude steps in on the third review-fix:** `REVIEW_MAX` stays 5. After a strict fail, `reviewCycles` increments then a fix runs if `cycles < REVIEW_MAX`. When `reviewCycles >= 3`, that fix is the Opus builder (bypassPermissions), not Grok/Cursor. So Grok/Cursor get two review-fixes; Claude makes the third (and the fourth if needed) before the fifth fail holds for Joe. Verify's existing one auto-fix stays on the current grunt. Voice `fix-copy` stays on the current grunt unless `builder` is already `opus`.

Plan and review stay plan-mode Opus. Never use bypassPermissions for plan or strict review.

## File list

Edit as needed: `src/shared/factory.ts` (`GuideNote.ack`, `builder`, `BUILDER_FIX_MAX = 3`), `src/main/grok-usage.ts` or `src/main/factory/fallback.ts`, `src/main/grok-args.ts` (Factory Cursor argv helper), `src/main/acp-session.ts` (`spawnArgs`, `factoryWarm`, `factoryPrompt`, `factorySetEffort`), `src/main/factory/opus.ts` (`opusBuildArgs`), `src/main/factory/controller.ts` (`guideRun` ack, builder hop, review-fix at cycle 3), `src/renderer/src/FactoryPane.tsx`, `src/renderer/src/TerminalWorkspace.tsx`, `src/renderer/src/styles/shell.css` (only if `.factory-files` is removed), `src/main/grok-leader.test.ts`, `src/main/factory/opus.test.ts`, `scripts/check-factory.ts`, `GOAL.md` Inbox (one line; version stays 0.1.87).

Not touched: Chat prompt path, Skin, `chat-reach.ts`, pack, Kennel auto-push, `files.ts` explorer, `reviewAccept`.

## Checks

1. `npm run typecheck`
2. `node --test --experimental-strip-types src/main/factory/*.test.ts src/main/grok-leader.test.ts src/main/write-guard.test.ts`
3. `node --experimental-strip-types scripts/check-factory.ts` → `FACTORY_PASS`

New FACTORY_PASS / tests:

- **IN 1:** FactoryPane source no longer contains `factory-files`. TerminalWorkspace Factory tab is passed `onFiles`.
- **ACK 1:** Guide during a busy build stores ack "Okay, we're filing that with the other work that's already in progress."
- **ACK 2:** Guide while waiting on dirty prep stores ack "Just noted."
- **FB 1:** `spawnArgs('cursor', brain, 'factory')` does not throw; argv has `--trust`, `--workspace` brain, `--add-dir` workRepo, `acp`; no `--always-approve`, no `--sandbox disabled`, no home add-dir.
- **FB 2:** `grokUsageBlocked` is true for a weekly-usage error and 100% credits; false for `cancelled` and a write-block sentence.
- **FB 3:** Factory Cursor `factorySetEffort` extra high does not throw.
- **FB 4:** After two Grok/Cursor review-fixes (`reviewCycles` reaches 3), the next fix spawns `claude` with `--permission-mode bypassPermissions` (not plan). Plan and strict review still use plan mode. Distinct pids.

Keep WR, VF, RT, GF checks green.

## Out of scope

Pack / notarize / replacing Brain.app. Changing Chat Cursor reach. Paying for more Grok quota. A work-repo picker.
