Item 15 is fixed. The ported-harness hunk now states both halves of each check the last review said a wrong run could pass.

The queued click requires `mouse 9 8 <a>` present and `mouse 9 8 <wa>` absent. The preparing close goes through the `chat:close` handler (`closeWarm` and `stopPrompt`) and through `closeOwner('desk:late')`. Each one requires the new `pages` entry to end `_closed`, `entered` not to grow, and the `wa` webContents to stay alive. `holdPrepare` is the focus call after `loadURL('about:blank')` has finished and before `goTo` calls `loadURL(target)`, so the new webContents exists, the target is not in `entered`, and the call is after a load. A small click must widen only that chat, add nothing to `actions`, and not call `browser:showWindow`.

Fixed: 15

Still open: none

New: none

APPROVE
