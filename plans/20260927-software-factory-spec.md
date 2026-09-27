# Software factory (Brain.app)

Joe 2026-09-27. Canonical spec for the Factory tab. Slice 1 is what to build now. Slices 2–3 stay on this page as the later shape; do not implement them in Slice 1.

`brainPath` is every Factory CLI cwd (hooks, Jev router, `.grok/hooks/`, `AGENTS.md`, skills). `workRepo` is where edits land. Same pattern as kennel-drive (talk here, ship there), but the main-process controller owns triage, phases, verify, and review. Not a disk skill.

Models implement the current phase brief. They do not pick tier, push, or “what’s next.”

## Permission (must land in Slice 1)

Chat and Skin Grok/Cursor ACP today refuse `fs/read_text_file` and `fs/write_text_file` unless the path is under `pool.cwd` (`acp-session.ts`, `underRoot`). That is why a session whose folder is the brain cannot write `brain-app/plans/` (or any other repo). Terminal is not restricted that way.

Joe: Brain.app must have the same write reach as Terminal on this Mac.

- Chat / Skin ACP: allow read/write of any absolute path this user can write. Keep `brainWriteBlock` for `skills/` and `.team-config/` when the target sits in a brain folder. The in-app file tree (`files:read` / `files:write`) stays scoped to the open brain; that is the explorer, not the CLI.
- Factory ACP: same OS reach, plus a post-turn git audit on `brainPath` and `workRepo`. Stray brain writes are dangerous because the brain auto-syncs. Show them; do not silently revert in Slice 1.
- Do not treat macOS Full Disk Access as the fix. Entitlements already omit App Sandbox. The block is Brain’s ACP allowlist.
- Factory Grok must not use Chat’s `--always-approve`. Real permission asks, filter, PATH shims, no `ANTHROPIC_API_KEY` in child env for Opus reviewers.
- Publish / push / deploy only via `gates.publish()` after a UI click. Slice 1 has commit on the work repo; no push, no deploy.

## Architecture

Factory tab (`type: 'factory'`) → IPC → controller (state machine) + triage (rules in Slice 1) + run-store (userData only) + gates (permissions, git audit, later publish buttons).

Separate warm pool from Chat: Grok without `--always-approve`, own leader socket, PATH shims.

Each turn: `wrapPromptWithHooks(brainPath, brief ≤1.2k)`. Role, tier, and phase live in the brief so resume does not depend on Grok `_meta.rules` alone. Unify RULES in `rules.ts` if Chat and Factory would otherwise drift; re-send on load for Chat. Slice 1 can keep Chat RULES as they are if Factory briefs carry role/tier/phase.

## Smart triage (size × risk)

| Size | Meaning | Rough signals |
| --- | --- | --- |
| T0 | Micro copy/style | 1 file, ≤20 lines |
| T1 | Small fix in existing patterns | 1–3 files, ≤150 lines, no new route/deps |
| T2 | Standard feature | 4–10 files or new route/API/shared types |
| T3 | Program | 10+ files, migrations, multi-slice, cross-repo |

Risk: none / elevated / critical (payments, auth, migrations, Kennel Out, etc.). Can raise after a diff, never lower.

Slice 1: deterministic `triage.ts` only (<200 ms, fixture-tested). T2/T3 asks warn and cap at T1 (do the smallest safe slice, do not run T2/T3 machinery). LLM classifier is Slice 2. Tripwires after each build turn (file/line counts, lockfile, schema) → upgrade prompt with a click; no silent tier changes.

Token discipline: no SKILL paste in RULES. Skills read by path in reviewer/build briefs only when that phase runs.

## What runs where

| | T0 | T1 | T2 | T3 |
| --- | --- | --- | --- | --- |
| Plan | — | inline in build | plan + human gate | slices + xhigh + human |
| Review | diff only | self-check | Opus strict (fresh `claude -p`) | xhigh + strict |
| Tests | typecheck | + unit | + targeted e2e | full e2e + artifact |
| Workers | 1 | 1 | 1 | up to 3 parallel, non-overlapping files |

Slice 1 implements the T0 and T1 columns only, through **commit** on `workRepo`. No push.

Nidhi (strict-code-review): T2+, elevated+ risk, MyPuppies always, or PR for someone else to merge. Interrogate/arena: not by default; name-only. Slice 1: skip Nidhi.

## Model routing (later slices; Slice 1 uses Grok for build)

| Job | Default | Escalation |
| --- | --- | --- |
| Triage LLM | Grok 4.7 low | — (Slice 2) |
| Build T0 | Grok low or Cursor fast | stuck ×2 → Grok xhigh one turn |
| Plan T2/T3 | Grok high / xhigh | plan rejected ×2 → Opus 5.5 medium CLI |
| Review T2+ | Opus 5.5 low/medium, fresh session | critical → stronger; Fable when Joe names |
| Verify | No model. Main runs scripts | — |

Reviewer ≠ builder session. Reviewers always fresh.

## Slice 1 (build this)

T0/T1 only. Rules-only triage. Controller through commit. Minimal PhaseRail. Existing Chat, Skin, Settings, Phone, and first-run screens stay (working preference 13). Add Factory as a new tab in the `+` picker, same chrome as today.

12-item gate before Slice 2 (fixture or script, not a live named tunnel, not a live Grok plan turn):

1. Typo T0 classifies as T0.
2. Deny push (no `git push`, no `gh`, no deploy from Factory).
3. Grok can edit `workRepo` via absolute path while cwd is `brainPath` (go/no-go).
4. Block `AGENTS.md` edit on the brain from a Factory run whose work repo is elsewhere (show in git audit).
5. Tripwire: oversize diff prompts upgrade; does not silently change tier.
6. Resume a run from userData after restart.
7. Lock: second Factory run on the same work repo is refused while one is active.
8. Separate pool from Chat (own leader socket, no `--always-approve`).
9. Permission ask is not auto-answered on Factory Grok.
10. Chat ACP can write a file outside the open folder (same as Terminal).
11. Typecheck green.
12. Factory run store is only under userData, not in git.

## Slice 2 (not now)

LLM triage, T2 plan + human gate, repo profiles, Opus strict by path, publish buttons, voice check.

## Slice 3 (not now)

T3 slices, parallel builders, full e2e, deploy token.

## Rejected

Session cwd = work repo. `.brain-factory/` in git. LLM triage every message. Auto tier changes. Sharing Chat pool. Phone factory tab v1.

## Kennel note (agency-brain, not this repo)

Kennel Drive merge APPROVE is Opus 5.5 Claude CLI, not Fable. Lives in `.claude/skills/kennel-drive/SKILL.md`. Factory Slice 3 must not push Kennel `staging`/`main` without that gate.
