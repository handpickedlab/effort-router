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
   - Yes: don't ask for the key itself. Give the user this command to run in their own terminal. It prompts for the key without echoing it, saves it with mode 600, and creates `config.json`:

     ```sh
     sh -c 'umask 077; d="$HOME/.config/effort-router"; mkdir -p "$d"; printf "TypeSafe API key: "; stty -echo 2>/dev/null; read -r k; stty echo 2>/dev/null; echo; [ -n "$k" ] || { echo "No key entered, nothing saved."; exit 1; }; printf "%s" "$k" > "$d/typesafe-api-key"; [ -f "$d/config.json" ] || printf "{ \"jev\": \"on\", \"exclude\": [] }\n" > "$d/config.json"; echo "Saved to $d. Start a new Claude Code session, or run /reload-plugins."'
     ```

     Then ask which projects must never send data to Jev, such as client work, and add their paths to `"exclude"` in `~/.config/effort-router/config.json`.
   - No: skip this step.

5. **Tell the user** to start a new session or run `/reload-plugins`.

Don't set `ANTHROPIC_API_KEY` for the user. Claude Code may then bill that key instead of their subscription.
