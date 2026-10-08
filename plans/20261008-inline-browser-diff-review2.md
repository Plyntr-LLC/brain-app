# Re-review of e9cc413 (round 2)

## Fixed

**1. Fixed.** `desk/browser.ts:383-387`: the `type` step now stops before `a.type` when the target is not a `field ` line. It runs `payStop(controlName(...))`, which returns a hold or refusal for "Buy now". Any other non-field gets `refused: 'missing'`. Either way the control is never clicked. In the check, step 8 now calls browser_type on "Buy now" both by name and by `#n`, and confirms `#bought` is not `purchased`.

**2. Fixed.** `pageActiveNames` (`chrome.ts:394-413`) returns two names:
- **own:** the focused control's name, when it is a BUTTON, an A, `role=button` or `role=link`, or an input of type submit, button, image or reset.
- **submit:** the first submit control in the focused element's form.

The `key` step (`browser.ts:362-368`) runs `payStop` on `own` for Enter and Space, and on `submit` for Enter only. In the check, step 8 now covers a focused Buy now outside a form with Enter and with Space. It also covers a type=button Buy now in a form whose submit is "Search". That case is held under the right name, because `own` is checked first.

One small difference: the check puts focus on the button with `.focus()` rather than with Tab. It still tests the same thing (`document.activeElement`), so I count this as done.

**3. Fixed.** `claudeBrowserArgs` (`browser-bridge.ts:293-304`) now writes the config to `<userData>/browser-mcp/<pid>-<owner>.json`. The directory is 0700 and the file is 0600 (a `chmodSync` follows the write). The args carry only the file path. `serverSpec` keeps the token in `env` only and `args: [script]`, so the MCP child's command line has no token either. Stopping the bridge removes this run's files, and `sweep` removes files left by runs whose process is gone. Step 14 of the check confirms there is no token in the args and the file mode is 0600. Step 19 confirms the file is removed on stop.

**4. Fixed.** `keyName()` ignores case and maps the aliases to the 14 names in the inapp `KEYS` table, which are all present. Anything else returns null. The bridge (`:194-196`) then returns an error ("No key named …") before calling the page, and the `key` step also refuses null as `missing`. The pay check and `pressKey` both receive the canonical name. Step 6 checks `enter` and `Foo`.

**5. Fixed.** The `pages` set is gone. `shown(owner)` asks `browser.look(owner)`, which returns non-null whenever `shown(owner)` finds a page for this owner, however it was opened. Step 10 checks that `openSharedPage` followed by a fresh MCP client can read the page without calling browser_open.

## Still open

None of 1–5.

## New

**6. Two hunks change approved parts outside items 1–5.**
- **`src/main/browser-mcp.cjs:29`:** the browser_click tool description that agents see changed from "pays or buys" to "pays, buys, sends, posts, or changes an account … never pressed by this tool". The new text does match `PAY_HOLD`/`PAY_REFUSE` (`shared/desk.ts:93-95`), but the description belongs to approved item 9 (the tool text), not to any open item.
- **`src/main/desk/ipc.ts:57`:** a comment-only fix of the stale `makeDeskLaunch` name. It is not one of the five open items.

Both changes are correct, and I would accept them as they are. Under this round's rule, though, every hunk has to belong to an open item. To close this, either move the two hunks into their own commit, or have Joe accept them explicitly.

I counted the `describe()` hunk (`browser-bridge.ts:166-171`) under items 1 and 2. Type and key refusals now go through it, so "Not clicked" had to become "Not pressed". Its new "sends or publishes" wording for `refused: 'pay'` matches `PAY_REFUSE`.

## Summary

- **Fixed:** 1, 2, 3, 4, 5
- **Still open:** none
- **New:** 6

REJECT
