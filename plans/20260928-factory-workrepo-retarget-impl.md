You are implementing a locked Factory plan in Brain.app. Opus 5.5 medium via Claude CLI. You may edit files. Do not pack, notarize, bump version, commit, or push.

Repo: /Users/joewine/Projects/brain-app
Stay on main.

Read and follow all of plans/20260928-factory-workrepo-retarget.md
Also read GOAL.md (add one Inbox line; version stays 0.1.85), src/main/factory/controller.ts (startRun, guideRun, resumeRun, opusPlan, buildStep, locks), src/main/factory/resolve-repo.ts (never lastRepo on reconcile), scripts/check-factory.ts.

Joe: Factory worked on the Plyntr email project but the Work repo line stayed the Gutter IQ quote repo (gutter-iq-quote-deploy). workRepo is set at Start and never moves. Grok can still edit mail-desk because factoryWriteBlock only guards the brain.

Implement reconcileWorkRepo as specified. Call it from guideRun, resumeRun, opusPlan, and buildStep. Unique resolve without lastRepo. Note hit wins over task. Retarget lock/profile/base/rememberRepo. Dirty new repo waits on prep only if the run has not built yet.

Then:
1. npm run typecheck
2. node --test --experimental-strip-types src/main/factory/*.test.ts
3. node --experimental-strip-types scripts/check-factory.ts

Short summary of files and the three checks. Do not print secrets.
