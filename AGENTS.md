# Brain app

Electron desktop Chat for Agency Brain. Working set: **`GOAL.md`**. Read it before you edit. Rewrite Inbox/Now when you land work.

```bash
npm run dev        # BRAIN_APP_DRY_RUN=1
npm run typecheck
```

Code lives in `src/main` (CLIs, ACP, files), `src/renderer` (Chat UI), `src/preload`. Do not hand-edit `out/`.

Chat is the product. Do not send Grok-only ACP fields to Cursor. Do not spawn a new CLI process on every send. Do not change Agency Brain’s watched path unless GOAL.md and Joe say so.
