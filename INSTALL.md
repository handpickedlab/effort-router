# Installing effort-router

These are instructions for a coding agent (Claude Code, for example) installing effort-router for its user. A person can follow them too.

Run each step, check its result before the next one, and stop and report if a check fails. Two choices in step 4 belong to the user: ask, don't decide.

## 1. Check the prerequisites

```bash
claude --version   # Claude Code; tested on 2.1.280
node --version     # 20 or later, on the PATH that Claude Code sessions see
git --version
```

If `node` is missing or older than 20, stop and tell the user. The plugin's MCP server runs with `node` from `PATH`. With nvm, that means the default alias has to point at Node 20 or later.

## 2. Install the plugin

```bash
claude plugin marketplace add handpickedlab/effort-router
claude plugin install effort-router@effort-router
```

If the user already has a plugin named `effort-router` from another source, for example a local checkout in `~/.claude/skills/effort-router`, stop and ask which one to keep. Two copies of the same plugin conflict.

## 3. Verify

```bash
claude plugin list | grep -A4 effort-router
claude plugin details effort-router@effort-router
```

Expect `✔ loaded`, and components that include the skills `gear-xhigh`, `gear-max`, `gear-top` and `stats`, the agents `low`, `high`, `xhigh` and `max`, hooks, and the MCP server `router`.

## 4. Ask the user two things

**a. Jev (optional).** effort-router can ask Jev, TypeSafe AI's System One model, to judge tasks. Without it, a built-in heuristic decides and everything else still works, except the `rank` tool. Ask whether they have a TypeSafe API key and want to use it.

- Yes: have the user give you the key, or tell you where it is stored. Write it to `~/.config/effort-router/typesafe-api-key`, containing only the key, with mode `600`:

  ```bash
  mkdir -p ~/.config/effort-router && chmod 700 ~/.config/effort-router
  # write the key to ~/.config/effort-router/typesafe-api-key without echoing it, then:
  chmod 600 ~/.config/effort-router/typesafe-api-key
  ```

  Don't print the key, don't commit it, and don't put it in shell profiles or Claude Code settings. `TYPESAFE_API_KEY` in the environment works too, if the user prefers that.
- No: skip this. Nothing else to configure.

**b. Which projects may send data to Jev** (only if they said yes to a). With Jev on, task descriptions, subagent briefs and results, and Claude's final messages go to TypeSafe's API, each clipped to a few thousand characters. Ask whether some projects, such as client work, must never send data. Then write `~/.config/effort-router/config.json`:

```json
{ "jev": "on", "exclude": ["~/path/to/client-project"] }
```

Or, to make Jev opt-in per project:

```json
{ "jev": "off", "include": ["~/path/to/allowed-project"] }
```

An entry covers everything below it, including all worktrees under that path. Paths match the session's project root.

## 5. Load it

Tell the user that new Claude Code sessions load the plugin automatically, and running sessions need `/reload-plugins`.

## 6. Smoke test

In a new session, ask Claude to call effort-router's `models` tool. The first line reads `jev: on …` or `jev: off …`, with the reason.

## Don't

- Don't set `ANTHROPIC_API_KEY` in Claude Code's environment on the user's behalf. effort-router can use it to read the Models API, but Claude Code may then bill the session to that key instead of the user's subscription.
- Don't change the user's default model or effort. The README explains the trade-off; that choice is theirs.

## Update and remove

```bash
claude plugin marketplace update effort-router && claude plugin update effort-router@effort-router
claude plugin uninstall effort-router@effort-router
rm -rf ~/.config/effort-router ~/.local/state/effort-router   # settings, key, logs
```

## Troubleshooting

- `/mcp` shows `router` as failed: usually `node` isn't on the `PATH` Claude Code sees, or it's older than 20.
- Hooks report "server not connected": the MCP server didn't start. Same cause as above.
- To see every hook event the server receives, start Claude Code with `EFFORT_ROUTER_DEBUG=1`. Events, prompts included, go to `debug.jsonl` in the plugin's data directory.
