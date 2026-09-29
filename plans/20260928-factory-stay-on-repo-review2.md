You are an independent reviewer. Do not edit files. Do not claim you fixed anything. Opus 5.5 medium, permission mode plan.

Repo: /Users/joewine/Projects/brain-app

This is a re-review of the open items only.
Mark a number fixed only when the diff shows that item is done. A number you cannot show in the diff stays open.

Open items from the last REJECT of plans/20260928-factory-stay-on-repo.md:

1. Restored run skipped the dirty-repo card because pause was set before reconcile and "not built" ignored resumePhase. Required: paused uses resumePhase; FACTORY_PASS restore into dirty mail-desk.

2. A note could still resolve to the current/last repo via partial name and block older notes. Required: resolveWorkRepo never returns an ignored repo from any loop, so the note saves nothing. Do not skip in reconcile when saved equals current.

3. A test that still fails on a changed file could auto-commit and push. Required: no auto-commit/auto-push while a fail row names a changed file; verify results in strictPrompt; unrelated red row (VF 1) can still land.

Closed: none yet. First review's approved parts stay unless a fix had to change them.

Read the current files (controller.ts reconcile/restore/verify/finishReview, resolve-repo.ts, opus.ts strictPrompt, check-factory.ts WR/VF). Implementer reported typecheck clean, 74 unit tests, FACTORY_PASS.

Your very last line must be exactly APPROVE or REJECT.
This is a re-review of the open items only.
Mark a number fixed only when the diff shows that item is done. A number you cannot show in the diff stays open.
GAPS: <n> on the line before APPROVE/REJECT. PASS only with GAPS: 0.
