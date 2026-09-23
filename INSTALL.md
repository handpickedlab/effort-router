# Installing effort-router (for an AI agent)

Run each step and check it before moving on. Stop and tell the user if a check fails.

1. **Check.** `node --version` must print 20 or later. `claude --version` must work.

2. **Install.**
   ```bash
   claude plugin marketplace add handpickedlab/effort-router
   claude plugin install effort-router@effort-router
   ```
   If `claude plugin list` already shows another `effort-router`, for example `@skills-dir`, ask the user which one to keep.

3. **Verify.** `claude plugin list` shows `effort-router@effort-router` as enabled.

4. **Ask the user** whether they have a TypeSafe API key for Jev. It's optional.
   - Yes: write it to `~/.config/effort-router/typesafe-api-key`, containing only the key. Use `chmod 700` on the folder and `chmod 600` on the file. Never print or commit it.
   - Then ask which projects must never send data to Jev, such as client work. List them in `~/.config/effort-router/config.json` as `{ "jev": "on", "exclude": ["~/path/to/project"] }`.
   - No: skip this step.

5. **Tell the user** to start a new session or run `/reload-plugins`.

Don't set `ANTHROPIC_API_KEY` for the user. Claude Code may then bill that key instead of their subscription.
