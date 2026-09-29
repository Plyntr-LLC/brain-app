You are an independent reviewer. Plan mode only. Do not edit files. Do not pack. Do not call Anthropic HTTP.

Repo: `/Users/joewine/Projects/brain-app`
Locked plan: `/Users/joewine/Projects/brain-app/plans/20260928-factory-files-ack-fallback.md`

Read the plan, then the working tree (git diff and the files it names). Judge the implementation against the locked decisions, not against a redesign.

Known implement notes (verify, do not trust):
- Factory files moved to In use; `.factory-files` cards gone.
- Guide ack persisted on the note; two copy strings.
- Grok → Factory Cursor Grok extra high → Opus bypassPermissions builder.
- reviewCycles >= 3 uses Opus builder for the fix.
- Extra: Factory Cursor session/new does not send Grok `_meta.rules`; rules prepended to the brief. Pre-warm billing check for creditUsagePercent.
- Checks claimed: typecheck, 90 tests, FACTORY_PASS including IN 1, ACK 1–2, FB 1–4 plus FB 5, CHAT_REACH_PASS, SLASH_SKILLS_PASS.

Look for: Chat/Skin/chat-reach.ts touched; Factory Cursor using Chat reach (`--sandbox disabled`, `--add-dir` home, always-approve); plan/review using bypassPermissions; track() failing a run on FACTORY_NEED_OPUS; In use still keyed only to lastChatId; ack dropped on note rewrite; factorySetEffort still throwing on cursor; factoryPrompt still hardcoded to grok pool; third review-fix still Grok; version bump or pack.

End with two lines: GAPS: <n> (how many gaps you found), then exactly PASS or FAIL. PASS only with GAPS: 0.
If the implementation matches the locked plan, last line APPROVE. If not, last line REJECT and list the gaps.
