You are implementing a REJECT fix in Brain.app. You are Opus 5.5 medium via Claude CLI. You may edit files. Do not pack, notarize, bump version, commit, or push.

Repo: /Users/joewine/Projects/brain-app
Cwd: that repo. Stay on main.

Locked plan: plans/20260928-factory-find-and-guide.md
Independent Opus REJECT (GAPS: 3). Fix all three. Do not reopen reviewAccept leftover gates. Do not touch chat-reach.ts, Chat, Skin, pack, version.

## Gap 1 (blocker)

Joe's sentence still picks `/Users/joewine/Projects/lotline-network` (`from: 'name'`) because the folder-name `nameHit` loop does not skip stopwords. Task order is `want, work, email, ...`. `work` unique-contains `lotline-network` and returns before `email` → `mail` can find `mail-desk`. Tests passed only because the fixture had no folder containing "work".

Fix:
- In the folder-name `nameHit` loop (and the exact folder-token loop if a stopword could exact-match a folder), skip tokens where `!topic(tok)`. Synonyms still run on topic words (`email` → `mail`).
- Add a git fixture folder named `lotline-network` (or similar unique-contains of `work`) in `resolve-repo.test.ts`. Joe's exact sentence with lastRepo = gutter-iq must pick `mail-desk`, not that folder.
- Re-check mentally against real ~/Projects: `work` must not pick lotline-network when the task also names email/Plyntr.

## Gap 2

Guide during triage must not call `afterTriage` (that skips LLM triage raise and critical Proceed). Triage is short. If `state.busy` and `run.phase === 'triage'` (or needsPrep / needsProceed): store the note unsent and return. Do not interrupt. Do not start a builder. The note drains into the plan or build when triage finishes, as a queued note already does after other turns.

Remove triage from INTERRUPTIBLE. Update FACTORY check if it assumed triage interrupt.

## Gap 3

`aliasMap`: cap 80 **git** folders that are not the brain, even if they have no README words. Do not let the brain occupy a slot. Count skipped-empty vs filled however you need as long as at most 80 non-brain git folders are considered.

Then:
1. npm run typecheck
2. node --test --experimental-strip-types src/main/factory/*.test.ts
3. node --experimental-strip-types scripts/check-factory.ts

Print a short summary and the three check results. Do not print secrets.
