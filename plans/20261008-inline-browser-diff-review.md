I wouldn't ship this as it is: the agent can still buy things through two of the new tools. Most of the plan is built and checked well. That includes the real-CLI runs for all four CLIs, the shared WhatsApp window and cookies that last across a restart. But plan item 6 says a pay or buy control is never clicked by the agent, and that does not hold. Step 8 of the check only tests `browser_click` and Enter in a real form, so it misses both holes below. Both come from reading the code; I did not run them.

**Reasons:**

1. **`browser_type` can click "Buy now" with no pay check.** Its `type` step (`src/main/desk/browser.ts:370-377`) looks up the target with `findControl`, which accepts any control, including buttons. It then calls the in-app `type` (`inapp.ts`), which clicks the control before typing. So `browser_type {target: "Buy now", text: ""}` (or `"#5"`) clicks Buy now on `/form`, and the page writes `purchased`. Fix: refuse unless the control is a `field `, or run `payStop` on its name first. Add both calls to step 8 of the check.

2. **`browser_key` misses a focused buy button.** `pageActiveSubmit` (`chrome.ts:142`) only finds the first submit button in the focused element's form. Space is never checked at all.
   - On `/form`, Buy now is not in a form. If the agent tabs onto it (`browser_key Tab`), `activeSubmit` finds nothing, and `browser_key Enter` or `Space` presses it.
   - If a type=button "Buy now" sits in a form whose first submit is "Search", Enter is checked against the wrong name.
   - Fix: for Enter and Space, run `payStop` on the focused element's own name (button, link, `role=button`, submit input) as well as the form's submit. Add "Tab to Buy now, then Enter" and "then Space" to step 8.

3. **The token is in Claude's command line, not only the MCP env.** Plan item 7 says it is passed only in the MCP env. `claudeBrowserArgs` puts the whole `--mcp-config` JSON, token included, in argv, where any process of the same user can read it with `ps`. Fix: write the config to a 0600 file in userData and pass its path, or record the change in the plan.

4. **Key names are case-sensitive.** The pay check matches only `detail === 'Enter'`, and `KEYS` lookups are exact. A call like `browser_key "enter"` silently presses nothing and returns a page read, so the agent thinks it worked. Fix: normalize the name before the pay check and the lookup, or return an error for an unknown key.

5. **Most tools refuse a page this chat didn't open itself.** `browser_read`, `browser_click`, `browser_type` and `browser_key` only work after a successful `browser_open` in the same bridge run (the `pages` set in `makeBrowserTools`). A page opened by a bare-address send, or already showing in the thread, gets "No page is open in this chat." The tool text doesn't say so. Fix: ask the desk browser whether this owner has a window, or say in the tool description that `browser_open` comes first.

I wrote the same list to `/Users/joewine/.claude/plans/diff-review-in-app-twinkly-flamingo.md`. I changed no repo files.

REJECT
