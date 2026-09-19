# HQ project sync (vendored)

Copied from `~/Projects/brain-sync`. The Cloudflare Worker stays there. This folder is the member agent: compose a mini folder, sync only allowed `projects/` trees, wipe on revoke.

Do not edit the lock (`src/acl.js`, `src/threeway.js`, `src/tokens.js`) here. Change it in brain-sync and copy again.

Brain.app runs this agent. Launchd / Scheduled Task keep syncing after the window closes, using Electron as Node (`ELECTRON_RUN_AS_NODE=1`).
