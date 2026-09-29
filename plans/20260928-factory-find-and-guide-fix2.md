You are implementing REJECT fix cycle 2 in Brain.app. Opus 5.5 medium. You may edit files. Do not pack, bump version, commit, or push.

Repo: /Users/joewine/Projects/brain-app
Stay on main.

Independent Opus REJECT (GAPS: 2). Joe's sentence already picks mail-desk on real ~/Projects. Do not reopen resolve-repo, triage interrupt, or alias cap unless you find a regression.

## Gap 1
`FactoryPane.tsx` shows "Interrupting this turn." under every unsent note. That is a lie during triage (queued on purpose), paused, prep, Proceed, and upgrade cards.

Show **Interrupting this turn.** only when an in-flight plan/build/verify/review turn is actually being interrupted (`running` is already true for those, and false for planWaiting / held diff). Otherwise unsent notes say **Waiting for the next turn.** Triage is never interrupting.

## Gap 2
Update the new 2026-09-28 Inbox line in GOAL.md so it no longer says triage is interrupted into the plan gate or build. Match the code: triage/prep/Proceed store the note unsent. Composer copy matches gap 1.

Then:
1. npm run typecheck
2. node --test --experimental-strip-types src/main/factory/*.test.ts
3. node --experimental-strip-types scripts/check-factory.ts

Short summary. Do not print secrets.
