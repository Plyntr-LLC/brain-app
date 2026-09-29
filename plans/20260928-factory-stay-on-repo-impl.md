You are implementing a locked Factory plan in Brain.app. Opus 5.5 medium via Claude CLI. You may edit files. Do not pack, notarize, bump version, commit, or push.

Repo: /Users/joewine/Projects/brain-app
Stay on main.

Read and follow all of plans/20260928-factory-stay-on-repo.md
Also read GOAL.md (Inbox: one line for this slice; version stays 0.1.86), src/main/factory/controller.ts (reconcileWorkRepo, restoreRun, verifyStep, afterTurn), src/main/factory/resolve-repo.ts, src/main/factory/gates.ts, src/main/write-guard.test.ts, scripts/check-factory.ts.

Joe's live run run-e50ebcf3-29d: task is Plyntr email/mail-desk. Newest Guide note said "why are we now showing the work repo as mykennel" and reconcile treated mykennel as the destination. Grok wrote mykennel files. npm test died on an unrelated square-tax.test.js. He does not want Factory to fail on every anomaly.

Implement every locked decision.

Then:
1. npm run typecheck
2. node --test --experimental-strip-types src/main/factory/*.test.ts src/main/write-guard.test.ts
3. node --experimental-strip-types scripts/check-factory.ts

If a check fails, fix the implementation, not the check, unless the check contradicts the locked plan.

Short summary of files and the three checks. Do not print secrets.
