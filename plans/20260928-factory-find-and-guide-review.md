You are an independent Opus 5.5 medium reviewer in plan mode. You cannot edit files. You did not write this code.

Repo: /Users/joewine/Projects/brain-app
Stay on main. Do not pack, commit, push, or bump version.

Read:
- plans/20260928-factory-find-and-guide.md (locked plan; this is the spec)
- git diff of: src/main/factory/resolve-repo.ts, src/main/factory/resolve-repo.test.ts, src/main/factory/controller.ts, src/renderer/src/FactoryPane.tsx, scripts/check-factory.ts, GOAL.md
- those files in full where the diff is not enough
- plans/20260928-factory-find-and-guide-impl.md (what the implementer was told)

Joe 2026-09-28: Factory started with "I want to work on the email system that we're doing for Plyntr" and used lastRepo Gutter IQ. Chat finds mail-desk. Guide Send waited for the next turn.

APPROVE only if you would ship this unchanged. Any real gap is REJECT: nits, non-blockers, leftover follow-ups, and "leave for later" all count. Do not write a PASS-with-nits.

Check at least:
1. email/emails also try mail; README + package.json aliases with 30s cache; lastRepo only when leftover tokens are stopwords or length < 4; never the brain; Joe's email-for-Plyntr wording hits mail-desk not gutter-iq.
2. Guide while busy: gen++, cancel + abort + closeWorkers, no pause, no lock release, follow-up starts at once with the note. Note never goes to the Opus reviewer. Fake cancel settles a hung prompt. Composer says "Interrupting this turn."
3. Chat/Skin/chat-reach, pack, version 0.1.84, Kennel auto-push, reviewAccept leftover gates: untouched.
4. Implementer deviations (accept only if they still match the locked plan's intent):
   - Guide during triage goes to afterTriage (plan gate for T2/T3) not a builder skip-plan.
   - track() ignores throws from a superseded gen.
   - Interrupted planner notes are handed to the next planner.
   - Alias matching skips stopwords.
   - `rain page` and `fix the notes page` no longer steal lastRepo.

End with two lines:
GAPS: <n>
then exactly APPROVE or REJECT.
PASS only with GAPS: 0. Here the last line must be APPROVE or REJECT, not PASS.

Do not print secrets. Do not implement fixes.
