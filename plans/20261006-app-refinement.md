# App refinement to mockup E (whole app), independent rail scroll, Also touching fold

Joe 2026-10-06: "the level of refinement in the mockup is way better than what is in the actual app update ... the model, effort, folder etc in the live app is nice but still very not refined compared to the beautiful layout in the mockup for this section. also the buttons etc are so much more refined on the mockup and i would like the entire app to follow that refinement." Then: "each individual section in the right sidebar to scroll independent of the other sections so i can be at the bottom of one section but at the top of another. also i want to be able to expand and contract the also touching section. It should just show also touching and how many rows rather than the 2-3 rows."

Spec source: `plans/mockups/20261006-factory/base.css` and `e-app-touchup.html` (mockup E, approved), plus `a-team-chat.html` and `d-chat-rail.html` for the rail cards. Styling only: every screen keeps its layout and every control stays where it is (AGENTS.md preference 13). Nothing is removed (edge buttons, Discard my changes, Times, Log out, tab ×, +, Speed, Mode all stay).

## Measured gap (dev app, computed styles, 1100x740 window)

- Body is Source Serif 4 at 16px for all UI. Mockup: Schibsted Grotesk 13px/1.45 for UI; serif only for agent answer prose (14.5px/1.55).
- Global `button`: 15.2px, padding 8px 14.4px, radius 3px, ghost border ink 55%. Mockup `.btn`: 13px/600, 5px 11px, radius 6px, 1px `--line` border on `--card`; `.sm` 12px 3px 8px.
- Inputs and composer: serif 16.8px, radius 3px (composer 8px). Mockup: sans 13px, radius 8px (composer 10px).
- `--radius: 3px` everywhere. Mockup: 6 buttons, 8 inputs, 10 cards, 12 user bubble, 999 pills.
- Title bar 52px; tab bar edge buttons 44px tall; `+` a 1.55rem orange glyph. Mockup: 40px title, 36px tabs, active tab card with a 2px orange underline.
- Session block (`.runmeta`): border-top strip, labels 0.68rem stacked over 1.02rem/700 values. Mockup: a card with an uppercase SESSION label and a two-column label/value grid at 12px (value 600).
- Explorer folder title is h2 size (~1.6rem). Mockup 15px; tree 12.5px.
- Chat `sys` rows (Session loaded, compact notes, older saved "Read · x" rows) render as large grey boxes with an orange "Command" kicker.
- A ~3px black strip shows above the composer in Skin: the hidden xterm viewport overflows `.skin-term` (no overflow clip).
- Glass mode (`:root.glass`, on in the Mac app) has its own overrides for titlebar, tabs, rail, runmeta, composer, popovers.

## 1. Behavior when done

1. **One type system.** UI text everywhere (title bar, tabs, new-tab picker, explorer, chat chrome, composer, rail, Factory, Settings, first run, setup, media, dialogs, menus) is Schibsted Grotesk on a 13px base. Agent answer prose (`.mdbody` in chat and Skin), the thinking body, and the markdown file preview stay Source Serif 4. Code, paths in chips and the terminal stay monospace. `index.html` loads Schibsted weight 400.
2. **Buttons, inputs, cards, pills match base.css.** Buttons 13px/600, 5px 11px, radius 6px, light `--line` border on `--card`, primary ink, hover darkens the border; title-bar buttons are the small size. Inputs, selects and textareas are sans 13px, radius 8px; composer 10px. Cards (rail boxes, Settings groups, dialogs, permission ask, Factory cards) use a soft `--line-soft` border and 10px radius. Section labels are 10.5px uppercase muted. Pills 999px. User bubble: paper, soft border, 12px radius, 13.5px sans. Dark theme gets the same shapes from existing dark tokens; any new token has a dark value. Glass overrides are updated so the Mac app shows the same shapes.
3. **Chrome.** Title bar 40px, sync as a small pill with its dot, theme icon, Log out, Settings unchanged in place. Tab bar 36px; active tab is the card color with a 2px orange underline; `+` is a plain tab cell; edge buttons `‹ ›` stay, lighter. New-tab picker keeps its column of choices, compact buttons.
4. **Session card (Joe's named example).** Bottom of the right rail, same place. A card titled SESSION with a two-column grid: Model, Effort, Speed, Mode (when the CLI has them), Context, Folder, Times. Values stay buttons; a click opens the same picker above the card. Model and Effort are always visible (hard rule 8): the card never scrolls away and is never squeezed by the sections above it.
5. **Right rail sections scroll on their own.** Each section card (Now, Progress, Plan, Team, Done so far, Files/Changed, Ship) keeps its header fixed and scrolls its own rows when the column cannot fit everything. Scrolling one never moves another or the column. Long sections shrink first (in proportion to their length); short ones keep their full height. Now and Ship never shrink, so Push stays reachable. Every section still shows at least about two rows. Same component in Chat and Factory tabs.
6. **Also touching folds.** Default is one line: "Also touching" with the number of repos and a chevron; an orange dot when any file in it is live. A click opens every repo row (no three-row cap, no "N more"); a repo row still opens its files; a second click on the header folds it again. Long lists scroll inside the block.
7. **Quiet notices.** `sys` rows and the compact notice render as one muted 12px line in the agent gutter style, no grey box, no "Command" kicker.
8. **No black strip** in Skin above the composer.
9. **Background work shows in Now.** Order: a permission ask, else the active turn's action, else background jobs, else idle. Joe 2026-10-06: "if groks review is running it should show there." When the turn is over but the CLI still has background jobs (Claude's `bg:` status list, the same list the "In the background" strip uses), Now reads "In the background: <first job>" (plus "(+N more)") with a timer from the oldest job, tone live, not "Idle. Waiting for your next message." A permission ask still wins; an active turn still shows its action. When the list empties, Now goes back to idle.
10. **The Session card is one component** (`SessionCard.tsx`) holding the same picker and rows that sit inline in `TerminalWorkspace.tsx` today, so the checks mount the real card in a crowded rail. No behavior change from the move.

## 2. Ways it can fail

- F1. Model or Effort hidden, clipped, or pushed off-screen by the new rail flex (hard rule 8).
- F2. The Model/Effort/Folder picker is clipped by a new overflow container and cannot be used.
- F3. A rail section collapses to its header only, or one long section starves the others.
- F4. Scrolling one section scrolls another or the whole column; or the column scrolls instead of the section.
- F5. Serif left on UI chrome (Settings, picker, rail, composer, Factory), or answer prose loses its serif.
- F6. The composer textarea collapses or grows wrong after the font change (`field-sizing: content`).
- F7. Dark theme shows light borders or white cards from new colors without dark values.
- F8. Glass overrides bring back the old look in the Mac app while headless checks pass.
- F9. Also touching counts files instead of repos, hides a live file when folded, renders repo rows while folded, or breaks repo expand.
- F10. A control is removed or moved (preference 13).
- F11. Factory rail: Push in Ship is hidden or unreachable when sections are long.
- F12. Settings or first-run text overflows or overlaps after the size change (fixed widths sized for 16px).
- F13. Buttons inside cards or menus that should stay link-like or row-like (linkish, tab names, file links, runpick rows, away rows) get the boxed button look.

## 3. End-to-end checks and artifacts

One rule source: `scripts/render-ui/style-rules.ts` exports plain in-page functions (no imports). `scripts/style-audit.ts` sends them to the running dev app over the DevTools protocol; the render pages call them directly. Font faces are classified by the first family name: "Source Serif 4" or Georgia is serif, anything else is not (so `sans-serif` never counts as serif).

**C1. Style audit of the real app (`scripts/style-audit.ts`).** Run against `npm run dev -- --remoteDebuggingPort 9333` (dry run). That is electron-vite's own CLI option (`node_modules/electron-vite/dist/cli.js` line 42 sets `REMOTE_DEBUGGING_PORT`); the baseline below already ran over it. Surfaces: Chat (native window size, then 1440x900 at DPR 1), new-tab picker open, Model picker open, Settings open, a Factory tab opened from `+`, Chat in dark theme. It asserts `html.glass` is present (the dev app is on darwin), so every metric below is measured with the glass overrides live (F8). Rules:
- R1 serif on UI: text whose own font is serif outside `.mdbody`, `.think-body`, `.mdview` (F5).
- R2 lost serif: every visible `.mdbody` (chat and Skin answers), `.think-body` and `.mdview` paragraph computes to Source Serif 4; Skin answers at 14.5px / 1.55 (F5).
- R3 UI text over 15px outside Settings and first-run h1/h2 and markdown headings.
- R4 boxed buttons (a border or a background): radius at least 6px, text at most 13px, and a non-filled button's border closer to `--line` than to `--ink`. A filled button whose border matches its background (primary) is not border-checked (F13).
- R5 row and link controls stay unboxed (no border; transparent background): `.linkish`, `.tabname`, `.tabx`, `.tabadd`, `.think-label`, `.flink`, `.away-line`, `.away-head`, `.rail-fold`, `.rail-more`, `.runmeta-v`, `.runpick button`, `.slashmenu button`, `.modes button`, `.folderpick`, `.set-fold` (F13). A selected row keeps its fill: `.runpick button.on`, `.slashmenu button.on` and `.modes button.on` may have a background but never a border; idle rows get neither.
- R6 inputs, selects, textareas: radius at least 8px, not serif, text at most 13.5px.
- R7 chrome under glass: `.titlebar` height 40px ±1; `.tabbar` height 36px ±1; the active tab shows a 2px orange bottom line (computed box-shadow or border carries `--orange`); `.tabadd` text at most 13px (F8).
- R8 Session card on Chat and Factory: `.runmeta` has an h5 "Session"; radius at least 8px; each label sits on the same row as its value (tops within 4px); values compute to 12px ±0.5 at weight 600; labels 12px muted; Model and Effort are buttons fully inside the viewport (F1).
- R9 Model picker: clicking Model opens `.runpick`; `elementFromPoint` at the first option's center hits that option (F2).
- R10 Skin strip: in the Chat tab with Skin on, sample `elementFromPoint` on every pixel row from the bottom of `.skin-thread` to the top of `.chatpane .composer` at three x positions; any hit inside `.skin-term` fails. Checked at the native window size, where the bug shows today (rows 640 to 642 hit the terminal on the 1100x740 window), and at 1440x900.
- R11 composer: idle textarea `clientHeight` between 34 and 48px; four typed lines grow it by at least 30px; the value is cleared after (F6).
- R12 dark theme: no visible background or border computes to a light surface token that must invert (`--paper` #f3eee8, `--card` #fffdf9, `--chrome` #efe8df, `--line` #d9d0c6, `--line-soft` #e6ddd2). `--orange` and ink-on-ink buttons are not in the list (F7).
- R13 inventory (F10): before the change the audit saves `inventory.json` (Chat surface): title bar has the theme icon, Log out, Settings, and the sync pill; tab bar has `‹`, `›`, `+` and a `×` per tab; the Session block has Model, Effort, Folder, Times, plus Speed, Mode and Context when shown. After the change every entry is present in the same parent.
Output: `STYLE_AUDIT_PASS` or `STYLE_AUDIT_FAIL` with each violation, a screenshot per surface, and `compare.html` with mockup E next to the Chat tab at 1440x900. Baseline already run on today's app: **293 violations on 6 surfaces** (before R2, R5, R7 to R13 existed). After: 0. Mutations that must fail it: button radius back to 3px; body back to serif; `.skin-term` overflow clip removed; `.tab.on` underline dropped from the glass override.

**C2. Crowded rail, driven (`scripts/render-ui/rail.tsx`, new).** The page mounts the real column twice: `<aside class="refs">` 760px tall with `ActivityRail` (flex 1) and `SessionCard` (no shrink) as siblings. Chat fixture (a chat Activity): 12 Plan steps, 30 Done so far lines, 20 files with the Files fold opened and "more" clicked. Factory fixture (a Factory Activity): Progress (5), Team (5), Changed (26 files with +N, with "more" clicked so all 26 list; asserted), Done so far (30), and Ship with Push not yet pushed.
- Shared, both fixtures: every section header and Now fully inside `.refs`; Session's Model and Effort buttons fully inside `.refs`; `.activity-rail` scrollHeight ≤ clientHeight + 1 (the column is not a second scroller); scroll the two named long bodies (below), then every other body, the column and every header are unmoved.
- Chat only: Plan, Done so far and Files bodies each at least two rows tall; Done so far and Files have scrollHeight > clientHeight; the two scrolled bodies are Done so far (to its bottom) and Files (to its middle).
- Factory only: after "more", Changed lists 26 files; Progress, Team, Changed and Done so far bodies each at least two rows tall; Changed and Done so far have scrollHeight > clientHeight; Ship and its Push button fully inside `.refs`; the two scrolled bodies are Changed (to its bottom) and Done so far (to its middle).
(F1, F3, F4, F11.) Mutations: drop the body overflow rule; let Session shrink.

**C3. Also touching (`scripts/render-ui/away.tsx`).** Five repos, one live file: folded shows one header reading "Also touching" with count 5, zero repo rows, and the live dot; click opens five repo rows (no more row); the lotline row opens its 26 files in order; a header click folds back to zero repo rows. These replace the 3 + "N more" asserts because Joe changed that behavior. Mutation: default open.

**C4. Quiet notices and background Now (`scripts/render-ui/chat-look.tsx`, `chat.tsx`).** chat-look adds a `sys` row and a CompactNotice: each computes to 12px, muted color, transparent background, no border, and contains no "Command" text. chat.tsx: first, while a turn is busy on a `work:` label (live, timer), send the `bg:` list below; Now stays on that action with its timer (an active turn wins over background jobs). Then after the turn's done event, send `status bg:[{label:"Started in the background: asking Grok 4.6 (xhigh)",at:now-90000}]`; Now reads "In the background: asking Grok 4.6 (xhigh)" with a running timer and the live tone; a second job adds "(+1 more)"; a permission ask during it shows the ask; `bg:[]` returns Now to idle (behavior 9). Mutation: Now ignoring `bg`.

**C5. First run (`scripts/render-ui/first-run.tsx`, new).** Mounts `FirstRun` with a fake bridge whose every call resolves empty, and runs the same R1, R3, R4, R5, R6 rules in the page on its first screen (Enter your code). The setup steps behind it inherit the same primitives; their per-step screens are not visited in this slice, and the handback says so (F12).

**C6.** `npm run typecheck`, the `node --test` suite, render pages chat-look, chat-paste, chat, factory, away, rail, first-run all pass; `npm run eval:factory` FACTORY_PASS. Click-check in the dev window (Chat, Factory, Settings, picker, Also touching fold, two rail sections scrolled apart); screenshots in `/tmp/refine/after/`.

## 4. Files

- `src/renderer/index.html` (Schibsted 400)
- `src/renderer/src/styles/tokens.css` (type base, button, input, radius and card tokens, dark values)
- `src/renderer/src/styles/shell.css` (title bar, tabs, picker, explorer, away, thread rows, user bubble, composer, Skin strip fix, rail cards and scroll, Session card, runpick, Settings, first run, Factory, glass overrides)
- `src/renderer/src/SessionCard.tsx` (new: the Session card moved out of `TerminalWorkspace.tsx`, same picker and rows)
- `src/renderer/src/TerminalWorkspace.tsx` (mount `SessionCard`; `sys` row class; pass `bgTasks` to the rail)
- `src/renderer/src/chat-activity.ts` (Now reads background jobs)
- `src/renderer/src/ActivityRail.tsx` (a body wrapper per section so the header stays and the rows scroll)
- `src/renderer/src/AwayBlock.tsx` (fold: header with count and chevron, open shows all repos)
- `src/renderer/src/WorldClocks.tsx` (Times as a grid row inside the card)
- `src/renderer/src/skin/Registry.tsx` (compact notice as a quiet line)
- `src/renderer/src/TitleBar.tsx` (sync dot inside the pill, if needed)
- `scripts/style-audit.ts` (new), `scripts/render-ui/style-rules.ts` (new), `scripts/render-ui/first-run.tsx` (new), `scripts/render-ui/rail.tsx` (new), `scripts/render-ui/chat.tsx`, `chat-look.tsx`, `away.tsx`
- `GOAL.md` (Inbox line)

Not in this slice: packing, signing or publishing (ask Joe first); any layout move; the missing space where two answer chunks join ("mockup.Reading"), which goes to the backlog as its own fix.
