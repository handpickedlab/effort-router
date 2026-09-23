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
   - Yes: don't ask for the key itself. Run `jev key` with Bash. It refuses without a terminal and prints the command for the user to run in theirs, where the key is entered hidden. Pass that command on.
   - Then ask which projects must never send data to Jev, such as client work, and run `jev off <path>` for each. `jev status` shows the result.
   - No: skip this step.

5. **Tell the user** to start a new session or run `/reload-plugins`.

Don't set `ANTHROPIC_API_KEY` for the user. Claude Code may then bill that key instead of their subscription.
