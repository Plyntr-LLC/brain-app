# V1 contracts (read-only for feature slices)

See `src/shared/contracts.ts` and `plans/20260917-brain-app-v1-build.md` in the agency brain.

## Guards

- `BRAIN_APP_DRY_RUN` defaults on in `npm run dev`. Create-team, clone, and Agency Brain `config.json` writes do not run.
- Never change an existing active `brainPath` in Agency Brain's config.
- Never log member tokens or git tokens.

## IPC

`window.brain` as defined in `src/preload/index.ts`.
