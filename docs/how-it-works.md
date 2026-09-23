# How effort-router works

Claude Code offers a session three levers. The plugin uses each one for what it verifiably does (checked on Claude Code 2.1.280):

| Lever | Changes | Behaviour |
| --- | --- | --- |
| Gear skills `effort-router:gear-xhigh`, `effort-router:gear-max` | This session's effort | Works when Claude invokes them; resets at the user's next prompt |
| Agents `effort-router:low`, `high`, `xhigh`, `max` | A subagent's model (per call) and effort (frontmatter) | The call's `model` beats frontmatter and `CLAUDE_CODE_SUBAGENT_MODEL` |
| `/effort-router:gear-top <task>` | Model **and** effort, for one turn | Only when you type it: a skill's `model:` is ignored when Claude invokes the skill |

So Claude can raise its own effort for a turn, but a different model always means a subagent (or you typing `gear-top`).

The pieces:

- **MCP server `router`** (`plugin/dist/server.mjs`, one process per session)
  - `route` — Claude describes the task (kind, ambiguity, risk, scope, failed attempts, whether it needs the conversation) and gets a tier plus a `do:` line: work inline, invoke a gear, or an exact `Agent(...)` call.
  - `models` — the model catalog, and whether it came from the Models API or the bundled snapshot.
  - `observe` — internal, called by the hooks.
  - Its instructions sit in every session's system prompt and tell Claude when to call `route`.
- **Hooks** (`mcp_tool` → `observe`)
  - `PostToolUseFailure` on Bash and file edits: the same command failing three times with the same error, or five times with shifting errors, injects an escalation into Claude's context. Search commands (`grep`, `rg`, `git status`, …) never count.
  - `PostToolUse` on Bash and file edits: a success resets that streak, and the hook reports the current effort level. A streak also expires after 30 minutes without a new failure.
  - `UserPromptSubmit`: after a turn that changed code or hit failures, Jev judges whether your reply says it still doesn't work. If so, that counts as a failed attempt and injects an escalation. Slash commands and task notifications are skipped, and a signal expires after 30 minutes. A new prompt also forgets the last turn's effort, since gears reset.
  - `PostToolUse` on `Agent`: when an `effort-router:low`, `high` or `xhigh` subagent returns, Jev checks the result against its brief. A miss (below 0.35) tells Claude to retry one tier up with the same brief.
  - `Stop`: when files changed this turn, Jev gets the files, the commands that passed after the last edit, and the final message. It judges whether the change needs a check, whether one ran, and whether the message says "done". Only when all three point that way is Claude asked, once, to verify or to say plainly that it's unverified.
  - `SessionStart` after `/clear`: forget the session's streaks and signals.
  - Everything that interprets text is Jev's job. Without Jev, those checks are off; there is no keyword fallback. What remains without Jev is counting and comparing: failure streaks, parallel edits, the log.
- Interrupted commands (Esc), search commands (`grep`, `rg`, `git status`, …) and polling (`gh pr checks`) never count as failures.

## Parallel sessions

Every session's server records the files it edits in `~/.local/state/effort-router/sessions/`, one file per session, removed when the session ends. Edits older than an hour and records of dead processes don't count. After each edit it compares:

- the same file edited by another live session → a warning that the two will overwrite each other;
- the same path in another worktree of the same repo (same `git --git-common-dir`) → a softer warning about a merge conflict or duplicate work.

Each pair is reported once. `route` also lists other sessions that changed files in the repo in the last hour. None of this leaves the machine.

## Decision log

Every route decision, Jev verdict, hook signal and overlap is appended to `~/.local/state/effort-router/decisions.jsonl` (rotated at 5 MB; task text isn't logged). `/effort-router:stats` in any Claude Code session (optionally `/effort-router:stats 7` for the last 7 days), or `npm run stats` in a checkout, summarises it: tiers and actions, how often Jev answered and agreed, the spread of its confidence, stuck, and done scores, how often each nudge fired, and overlaps. That's the data for retuning the thresholds in `src/policy.ts` and `src/server.ts`.

## Consult tools

- `knowledge` — pass candidate lessons; Jev says which would save a later session or another agent real time (keep at 0.5 or more), and where each belongs: nowhere, project memory (shared by every session and worktree of the repo), user memory, `~/.claude/CLAUDE.md` for tooling facts that hold everywhere, or the repo's `CLAUDE.md`/`AGENTS.md`. The last two change things beyond this session, so Claude asks first. It stores nothing itself; Claude writes with Claude Code's own memory.
- `rank` — pass a goal, context and 1–50 candidate approaches, plus up to three extra yes/no criteria. Each gets "viable" (sound and likely to work) and a share of the best-option vote; the list comes back sorted. One candidate makes it a sanity check. It has no heuristic fallback: without Jev it says so.
- When a command passes after three or more failed attempts, or the `max` agent returns, a hook suggests passing the lesson to `knowledge`.

## Who decides: Jev

`route` asks Jev, TypeSafe AI's System One model (`jev-latest`, `src/jev.ts`), two typed questions about the task: which tier (quick, standard, deep, max) and whether the agent looks stuck. A call takes 0.3–0.8 s.

- Jev's tier counts when its confidence is at least 0.5; below that, the heuristic below decides.
- Jev saying stuck (0.6 or more) counts as two failed attempts, on top of what the hooks count.
- Without a key, offline, or after a 3 s timeout, `route` uses the heuristic alone.

What leaves the machine: for `route`, the task fields Claude fills in; for the result check, the brief (up to 4,000 characters) and the result (up to 6,000); for the done check, the changed file paths, the commands run after the last edit, and the final message (up to 3,000); for the follow-up check, your reply (up to 2,000, pasted content removed). After a failed call Jev is skipped for five minutes.

### Turning Jev off per project

`~/.config/effort-router/config.json` decides which projects may send data to Jev, matched on the session's project root (`CLAUDE_PROJECT_DIR`). An entry covers everything below it, so one path covers every worktree of a repo, and the most specific entry wins:

```json
{ "jev": "on", "exclude": ["~/projects/client-x", "~/worktrees/client-x"] }
```

Use `"jev": "off"` with an `"include"` list to make it opt-in instead. No file means on; a file that doesn't parse means off. Edits apply on the next call, with no reload. When Jev is off, `route` uses the heuristic and says so, and the result, done and follow-up checks are skipped. The `models` tool shows the state for the current project.

The key comes from `TYPESAFE_API_KEY` or `TYPESAFE_AI_API_KEY` in the server's environment, or else from `~/.config/effort-router/typesafe-api-key` (mode 600). The hooks never call Jev, so no prompt waits on the network.

## The policy

The one table to edit is `TARGETS` in `src/policy.ts`:

| Tier | Model | Effort | Agent |
| --- | --- | --- | --- |
| quick | sonnet | low | `effort-router:low` (broad lookups: built-in `Explore` on haiku) |
| standard | sonnet | high | `effort-router:high` |
| deep | opus | xhigh | `effort-router:xhigh` |
| max | fable | max | `effort-router:max` |

The heuristic: lookup and mechanical 0, implement and debug 1, design and review 2; +1 each for high ambiguity, high risk, and a large scope on implement/debug/design. 0 is quick, 1 standard, 2–3 deep, 4+ max. Two failed attempts raise the tier by one (at least deep); three go to max.

A deep task stays inline when the session is at most one effort step below the target, because changing effort mid-session costs an uncached re-read of the conversation. Delegating leaves the main session's cache intact.

## Staying current

- Jev is addressed as `jev-latest`, so a new Jev release is used without a change.
- Models are Claude Code aliases (`sonnet`, `opus`, `fable`, `haiku`), so a new version in a family is used as soon as Claude Code resolves the alias to it.
- When Claude Code's environment has API credentials (`ANTHROPIC_API_KEY`, or an `ant auth login` profile), the server reads the Models API once a day. It learns the newest version per family and the effort levels it accepts, and flags families it has no rank for yet. Without credentials it uses the snapshot in `src/catalog.ts`.
- A new model family, the way Fable arrived, needs one line: its rank in `BUNDLED` in `src/catalog.ts`.

## Develop

```bash
npm install
npm run check   # typecheck, build plugin/dist/server.mjs, tests, claude plugin validate
```

To run a working copy instead of the marketplace install, uninstall that first, then link the plugin folder into your skills directory. It loads in every session as `effort-router@skills-dir`:

```bash
ln -s "$PWD/plugin" ~/.claude/skills/effort-router
```

After a change, run `npm run build`, then `/reload-plugins` in a running session. `plugin/dist/server.mjs` is committed, because marketplace installs don't build. Rebuild before you commit a change to `src/`.

- Token cost per session: `claude plugin details effort-router@effort-router` (or `@skills-dir`)
- Turn it off: `claude plugin disable effort-router@effort-router`

## Limits

- Claude decides when to call `route`. The instructions say when, but Claude skips it for work it considers small. The hooks are the deterministic part.
- Stuck detection names a command by its first words (`npm test`, `pnpm vitest run`), so two different invocations of the same tool count as one.
- The hooks don't carry the model, so the server reads it from the tail of the session transcript.
- Edit's own validation errors ("string to replace not found") never reach hooks, so file-edit streaks only count real write failures.
- `EFFORT_ROUTER_DEBUG=1` in Claude Code's environment appends every hook event, prompts included, to `debug.jsonl` in the plugin's data directory.
