# Factory: find the repo like Chat, Guide interrupts

Joe 2026-09-28. Packed **0.1.85**. He started Factory with: *I want to work on the email system that we're doing for Plyntr.* It used the last Factory repo (Gutter IQ). Chat already finds `mail-desk` from that wording. Guide Send waited for the in-flight turn. Existing FactoryPane layout stays (WP13). Chat/Skin/`chat-reach.ts` untouched. Factory stays gated (no `--always-approve`, shims, `factoryWriteBlock`). Kennel `staging`/`main` still never auto-pushes.

This file is the locked plan. Opus 5.5 medium implements it. Do not revert 0.1.84 Factory UX.

## Why Chat finds it and Factory did not

Chat has Mac-wide reach and reads the world. Factory `resolveWorkRepo` only matches `~/Projects` **folder names**, then lastRepo.

Joe's tokens: `email`, `system`, `plyntr`. `email` does not unique-contain `mail-desk`. `plyntr` is ambiguous across `plyntr-*`. Fallback is lastRepo (Gutter IQ). `mail-desk` README first line is `Mail desk (Plyntr dogfood, slice 1)`.

Do **not** spawn Grok or Opus to pick the folder (slow, untestable without fakes). Do **not** make the brain the work repo.

## Locked decisions

### 1. Work repo: meaning, then folder name, never a silent lastRepo steal

Keep order: path in the task, then a `~/Projects` git folder (exact token, then one of its names), then **aliases** (below), then lastRepo. Never the brain.

**Synonyms on task tokens** (tiny map in `resolve-repo.ts`): `email` / `emails` → also try `mail`. Apply during exact folder token, nameHit, and alias matching. First unique hit wins (`from: 'name'` unless it was an exact folder token, which stays `'project'`).

On Joe's wording, `email` → `mail` unique-contains `mail-desk` before `plyntr` is considered.

**Aliases** (Chat-like names without an LLM), only if folder-name matching did not unique-hit:

For each `~/Projects` git folder that is not the brain (cap 80):

- `package.json` `name` and `description` if the file exists and is ≤ 8kb
- `README.md` or `README`: first heading plus the first 80 words, if the file exists and is ≤ 8kb

Tokenize those the same way as the task. Unique fold / prefix / contains against those aliases (same three steps as `nameHit`). Unique hit: `from: 'name'`. Two+ folders: skip that token.

Cache the alias map in-module keyed by `projectsDir`, refresh if older than 30s or the dir argument changed. Intake calls resolve on every keystroke; do not re-read 80 READMEs per letter.

Tests write real README / package.json in the injected `projectsDir` (no extra resolve input). Required fixture: `mail-desk` with README `# Mail desk (Plyntr dogfood, slice 1)` and a Gmail sentence; `gutter-iq` with a Gutter IQ README; `plyntr-chat` (so `plyntr` stays ambiguous). `lastRepo` = gutter-iq.

Must pass:

- `I want to work on the email system that we're doing for Plyntr` → `mail-desk`, `from: 'name'`, not lastRepo
- `fix typo` with lastRepo still `'last'`
- `rain page` (ambiguous folder fragment, leftover topic word) does **not** steal lastRepo: `NAME_THE_REPO`
- A task that only names the brain still `BRAIN_IS_WORK`
- Exact `brain-app` still `'project'`; `kennel` still `mykennel`

**lastRepo does not steal.** After path / folder / alias matching, lastRepo is allowed only when every leftover task token is a stopword or shorter than 4 letters. Unmatched topic words (`email`, `plyntr`, `rain`, …) → `NAME_THE_REPO` (do not silently use Gutter IQ). Stopwords include at least: `the`, `that`, `this`, `with`, `from`, `for`, `and`, `want`, `work`, `working`, `doing`, `system`, `just`, `like`, `fix`, `typo`, `update`, `change`, `please`, `need`, `page`, `footer`, `label`, `stuff`, `also`, `make`, `add`, `were`, `were`, `we're` (tokenized as `were` / `re`). Keep `fix typo` on lastRepo.

Intake warning for `from: 'last'` stays. No picker.

### 2. Guide Send interrupts the in-flight turn

Chat: Send from the queue stops the live turn, then sends. Factory today: `guideRun` stores the note and `if (state.busy) return run`. The composer even says **Waiting for the next turn.**

**Busy + Guide Send:**

1. Append the note (same cap: last 20, 800 chars).
2. `state.gen++` so the in-flight work is `stale`.
3. `driver.cancel(run.acpTab)`, `state.abort?.abort()`, `closeWorkers(state)` (same cancel as Pause). Do **not** pause. Do **not** release the lock.
4. Immediately start the follow-up with the note (same routing as a non-busy Send):
   - Plan in flight or waiting: fresh `opusPlan` with the note (does not Approve).
   - Build / triage / verify / review-without-held-diff / T3 workers: one builder turn with the note (`buildStep` `fix` when a diff already exists or review is in flight; otherwise `build`). T3 slices are not restarted; Joe's notes already force one builder.
   - Held reject (`review` + diff + 5 fails): Keep fixing with the note, then a fresh Opus review (already true).
5. Never send Joe's note to the Opus reviewer. Abort an in-flight `runOpus` via the existing signal; the next review is a new process after the builder turn.

`track()` already replaces `state.busy`. The cancelled turn must not `afterTurn` / verify / auto-commit (`stale` already guards this). Fake `driver.cancel` in `scripts/check-factory.ts` must **settle** a hung `prompt` (today it only records the call). Fake Opus spawn must die on abort the same way `runOpus` already kills the child.

Paused / failed / prep / Proceed / terminal phases: unchanged (notes sit, or refuse if the run is over).

Composer copy: unsent notes say **Interrupting this turn.** not **Waiting for the next turn.** Do not restyle Chat. Do not redesign FactoryPane.

## File list

Edit

- `src/main/factory/resolve-repo.ts` (+ tests): synonyms, aliases + cache, lastRepo leftover gate.
- `src/main/factory/controller.ts`: `guideRun` interrupts when `state.busy`.
- `src/renderer/src/FactoryPane.tsx`: interrupting copy only.
- `scripts/check-factory.ts`: busy-guide test is interrupt, not queue-until-finish. Fake cancel settles the hung prompt.
- `GOAL.md` Inbox: one new line for this slice. Packed as 0.1.85.

Not touched: `chat-reach.ts`, Chat RULES, files.ts explorer, Phone, first-run, Settings chrome, pack, version, Kennel auto-push, leftover `reviewAccept` gates.

## Test map (no live CLI)

1. Injected projects include `mail-desk` (Mail desk README), `gutter-iq`, `plyntr-chat`, plus today's `brain-app` / `agency-brain` / `mykennel` / `lotline`. Task "I want to work on the email system that we're doing for Plyntr" with lastRepo gutter-iq → mail-desk `from: 'name'`.
2. `fix typo` still lastRepo.
3. `rain page` with lastRepo → `NAME_THE_REPO`.
4. Brain-named task still `BRAIN_IS_WORK`.
5. Guide while a hung build prompt is in flight: `cancel` is called, a second prompt with `Joe says:` starts **before** the first prompt is released; the first turn does not run verify; after the second turn settles, phase is review (or whatever afterTurn would be) and the note is `sent`.
6. Guide on a waiting plan still a new `opusPlan` with the note, still waiting (unchanged).
7. Guide on a held reject still one fix then a new reviewer (unchanged).
8. Planner pid ≠ reviewer pid still. No `--always-approve`. Ship / gaps / five-cycle checks still pass.

## Out of scope this pass

Pack / notarize / gh release. Replacing Brain.app. Grok as builder becoming Opus. A work-repo picker. Redesign of Chat or FactoryPane. Auto-deploy. Pushing `main` / `staging` / Kennel protected branches. Spawning an LLM to pick the folder.
