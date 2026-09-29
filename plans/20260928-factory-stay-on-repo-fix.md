You are implementing a Factory fix cycle. Opus 5.5 medium. You may edit files. Do not pack, notarize, bump version, commit, or push.

Repo: /Users/joewine/Projects/brain-app
Stay on main.

Independent Opus REJECT GAPS: 3 against plans/20260928-factory-stay-on-repo.md. Change only what those three require. Approved parts stay.

1. **Restored run skips dirty-repo card.** `restoreRun` sets phase `paused` before `reconcileWorkRepo`. The "not built yet" check only looks at phase `triage` or `plan`. A restore mid-plan into a dirty mail-desk never shows Commit/Stash first. Fix: when phase is `paused`, use `run.resumePhase` for that check. Add a FACTORY_PASS check that restores into a dirty mail-desk (WR 1 restore currently uses a clean repo).

2. **A note can still resolve to the current/last repo via partial name and then block older notes.** In `resolveWorkRepo`, current and last names are only stripped as whole words; only the hyphen loop checks the found repo. "kennel" still unique-contains `mykennel`, the note saves that repo, and reconcile never tries older notes/the task. Fix **inside `resolveWorkRepo`**: never return an ignored repo from any loop, so the note saves nothing. Do not skip in reconcile when saved repo equals current (that would keep the old repo on the note and pull the run back after a later move).

3. **A test that still fails on a changed file can auto-commit and push.** After one fix turn, review can still auto-commit (Approve in advance) and push (Ship in advance) while a fail row names a changed file. `strictPrompt` never sees verify. T0/T1 with no Opus review commit with no review. Fix: do not auto-commit or auto-push while a fail row names a changed file, and pass the verify results into `strictPrompt`. An unrelated red row (VF 1) can still land.

Then:
1. npm run typecheck
2. node --test --experimental-strip-types src/main/factory/*.test.ts src/main/write-guard.test.ts
3. node --experimental-strip-types scripts/check-factory.ts

Short summary. Do not print secrets.
