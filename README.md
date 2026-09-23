# effort-router

A Claude Code plugin that picks the model and reasoning effort per task. It raises effort when a session is stuck and keeps routine work light.

## Install

```bash
claude plugin marketplace add handpickedlab/effort-router
claude plugin install effort-router@effort-router
```

Then start a new session, or run `/reload-plugins`. Requires Node 20+.

To have an AI install it, give it this:

> Install effort-router by following https://github.com/handpickedlab/effort-router/blob/main/INSTALL.md

## Optional: Jev

With a [TypeSafe](https://typesafe.ai) API key, Jev judges each task; without one, a built-in heuristic does. Paste this in a terminal. It asks for the key without showing it, and creates the config:

```sh
sh -c 'umask 077; d="$HOME/.config/effort-router"; mkdir -p "$d"; printf "TypeSafe API key: "; stty -echo 2>/dev/null; read -r k; stty echo 2>/dev/null; echo; [ -n "$k" ] || { echo "No key entered, nothing saved."; exit 1; }; printf "%s" "$k" > "$d/typesafe-api-key"; [ -f "$d/config.json" ] || printf "{ \"jev\": \"on\", \"exclude\": [] }\n" > "$d/config.json"; echo "Saved to $d. Start a new Claude Code session, or run /reload-plugins."'
```

Jev receives task descriptions. To keep a project out, list its path in `~/.config/effort-router/config.json`:

```json
{ "jev": "on", "exclude": ["~/projects/client-x"] }
```

## Use

It works on its own. `/effort-router:stats` shows what it decided.

## Remove

```bash
claude plugin uninstall effort-router@effort-router
```

How it works and how to develop it: [docs/how-it-works.md](docs/how-it-works.md). MIT licensed.
