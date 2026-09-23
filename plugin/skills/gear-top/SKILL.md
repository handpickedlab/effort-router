---
name: gear-top
description: "Run this one turn on the most capable model (the best alias, Fable where available) at max effort; the session model resumes at your next prompt. Type /effort-router:gear-top followed by the task."
argument-hint: "[task]"
model: best
effort: max
disable-model-invocation: true
---

You run on the most capable model at max effort for this turn only. The user asked for it because this problem is hard or the work so far didn't solve it. Treat earlier attempts as evidence, not as a plan: find the root cause before you change code, question the assumptions those attempts rested on, then fix and verify.
