---
name: stats
description: "Show effort-router's decision statistics: tiers, Jev verdicts, nudges and overlaps. Type /effort-router:stats, optionally with a number of days."
argument-hint: "[days]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/stats.mjs *)
---

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/stats.mjs $ARGUMENTS`

Show these statistics to the user as they are. Then, in two or three lines, point out anything that suggests a threshold needs tuning: a nudge that fires in most sessions, Jev often unsure or unanswered, delegated results often retried, or the done check nudging most turns. If there is too little data to tell, say so.
