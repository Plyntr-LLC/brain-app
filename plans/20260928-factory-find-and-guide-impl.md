You are implementing a locked Factory plan in Brain.app. You are Opus 5.5 medium via Claude CLI. You may edit files. Do not pack, notarize, bump version, commit, or push.

Repo: /Users/joewine/Projects/brain-app
Cwd: that repo. Stay on main.

Read and follow all of:
- plans/20260928-factory-find-and-guide.md (locked plan: implement exactly this)
- GOAL.md (add one Inbox line for this slice; version stays 0.1.84; do not pack)
- src/main/factory/resolve-repo.ts
- src/main/factory/resolve-repo.test.ts
- src/main/factory/controller.ts (guideRun, drainGuide, pauseRun, track, stale)
- src/renderer/src/FactoryPane.tsx (guide composer copy "Waiting for the next turn.")
- scripts/check-factory.ts (UX 6 busy-guide check around the hung prompt)

Joe 2026-09-28: Factory started with "I want to work on the email system that we're doing for Plyntr" and used lastRepo Gutter IQ. Chat finds mail-desk. Guide Send waited for the in-flight turn.

Do:
1. resolveWorkRepo: synonyms email/emails → also try mail; README + package.json aliases with a 30s in-module cache keyed by projectsDir; lastRepo only when leftover tokens are stopwords or length < 4. Never the brain. Tests with injected mail-desk / gutter-iq / plyntr-chat.
2. guideRun when state.busy: store note, gen++, driver.cancel + abort + closeWorkers, immediately follow-up turn with the note. Do not pause. Do not send the note to the Opus reviewer. Fake driver.cancel in check-factory.ts must settle a hung prompt. Replace the queue-until-finish busy check with interrupt checks from the plan.
3. FactoryPane: unsent notes say "Interrupting this turn." not "Waiting for the next turn."
4. npm run typecheck
5. node --test --experimental-strip-types src/main/factory/*.test.ts
6. node --experimental-strip-types scripts/check-factory.ts
   PATH and HOME for that check are already rewritten inside the script. Do not point it at this Mac's grok/claude.

Do not touch chat-reach.ts, Chat, Skin, pack, version, Kennel auto-push, reviewAccept leftover gates.

When done, print a short summary of files changed and the pass/fail of typecheck, factory tests, and FACTORY_PASS. Do not print secrets.
