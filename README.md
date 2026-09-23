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

With a [TypeSafe](https://typesafe.ai) API key, Jev judges each task; without one, a built-in heuristic does.

In any Claude Code session, type `! jev key`. It prints a command to run in your terminal, where you enter the key without it being shown.

Jev receives task descriptions. For projects that mustn't send anything, such as client work, type `! jev off` in that project (`! jev on` undoes it, `! jev status` shows the state).

## Use

It works on its own. `/effort-router:stats` shows what it decided.

## Remove

```bash
claude plugin uninstall effort-router@effort-router
```

How it works and how to develop it: [docs/how-it-works.md](docs/how-it-works.md). MIT licensed.
