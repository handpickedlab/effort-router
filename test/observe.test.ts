import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { Observer, commandKey, errorSignature, isFrustrated, modelFromTranscript, present } from "../src/observe.js";

const fail = (command: string, error: string, agent_id = "") => ({ event: "PostToolUseFailure", tool_name: "Bash", command, error, agent_id });
const pass = (command: string) => ({ event: "PostToolUse", tool_name: "Bash", command });

describe("commandKey", () => {
  const cases: [string, string | undefined][] = [
    ["npm test", "npm test"],
    ["cd /x && npm test -- --watch=false 2>&1 | tail -50", "npm test"],
    ["FOO=1 pnpm vitest run src/a.test.ts", "pnpm vitest run"],
    ["npm run build", "npm run build"],
    ["npx tsc --noEmit", "npx tsc"],
    ["/usr/bin/env python3 -m pytest tests/test_x.py", "python3 pytest"],
    ["git push origin main", "git push origin"],
    ["grep -rn foo src", undefined],
    ["git status --short", undefined],
    ["cd app", undefined],
    ["git commit -m \"$(cat <<'EOF'\nfix: thing\n\nbody\nEOF\n)\"", "git commit"],
    ["(cd app && npm test)", "npm test"],
    ["npm run build && echo OK", "npm run build"],
    ["grep -q x f && pnpm lint", "pnpm lint"],
    ["gh pr checks 123", undefined],
  ];
  for (const [command, key] of cases) test(command, () => assert.equal(commandKey(command), key));
});

describe("errorSignature", () => {
  test("ignores numbers and colours, keeps the message", () => {
    const a = "Exit code 1\nsrc/a.ts(12,3): error TS2322: Type 'string' is not assignable\n\x1b[31mFound 1 error\x1b[0m";
    const b = "Exit code 2\nsrc/a.ts(40,9): error TS2322: Type 'string' is not assignable\nFound 1 error";
    assert.equal(errorSignature(a), errorSignature(b));
    assert.notEqual(errorSignature(a), errorSignature("Exit code 1\nError: Cannot find module 'express'"));
  });
});

describe("present", () => {
  test("treats empty and unexpanded placeholders as absent", () => {
    assert.equal(present(""), undefined);
    assert.equal(present("${agent_id}"), undefined);
    assert.equal(present("undefined"), undefined);
    assert.equal(present("abc"), "abc");
  });
});

describe("Observer", () => {
  const error = "Exit code 1\nError: Cannot find module 'express'";

  test("the same error three times is stuck; it nudges once per level", () => {
    const o = new Observer();
    assert.equal(o.observe(fail("npm test", error)), undefined);
    assert.equal(o.observe(fail("cd app && npm test", error)), undefined);
    const third = o.observe(fail("npm test", error));
    assert.ok(third?.type === "stuck" && third.level === 1 && third.same === 3 && third.subject === "`npm test`");
    assert.equal(o.observe(fail("npm test", error)), undefined);
    const fifth = o.observe(fail("npm test", error));
    assert.ok(fifth?.type === "stuck" && fifth.level === 2);
    assert.equal(o.observe(fail("npm test", error)), undefined);
  });

  test("a success resets the streak", () => {
    const o = new Observer();
    o.observe(fail("npm test", error));
    o.observe(fail("npm test", error));
    o.observe(pass("npm test -- --run"));
    assert.equal(o.observe(fail("npm test", error)), undefined);
  });

  test("shifting errors only count as churning after five failures", () => {
    const o = new Observer();
    for (let i = 0; i < 4; i++) assert.equal(o.observe(fail("npx tsc", `Exit code 1\nerror TS${i}: problem ${"abcd"[i]}`)), undefined);
    const fifth = o.observe(fail("npx tsc", "Exit code 1\nerror TS9: problem e"));
    assert.ok(fifth?.type === "stuck" && fifth.level === 1 && fifth.same === 1 && fifth.total === 5);
  });

  test("user interrupts never count", () => {
    const o = new Observer();
    for (let i = 0; i < 4; i++) {
      assert.equal(o.observe({ ...fail("npm run dev", "Exit code 130\n[Request interrupted by user for tool use]") }), undefined);
      assert.equal(o.observe({ ...fail("npm test", error), is_interrupt: "true" }), undefined);
    }
  });

  test("a new error next to pre-existing ones is progress, not the same error", () => {
    const o = new Observer();
    const old = "src/legacy.ts(1,1): error TS1: old\nsrc/legacy.ts(2,1): error TS2: old";
    for (const fresh of ["a", "b", "c"]) assert.equal(o.observe(fail("npx tsc", `Exit code 2\n${old}\nsrc/new.ts(1,1): error TS3: ${fresh}`)), undefined);
  });

  test("npm's own boilerplate doesn't make different failures look the same", () => {
    const o = new Observer();
    const npm = "npm error Lifecycle script `test` failed with error:\nnpm error code 1\nnpm error path /repo/pkg";
    for (const what of ["alpha", "beta", "gamma"]) assert.equal(o.observe(fail("npm test -w pkg", `Exit code 1\n${npm}\nFAIL ${what}.test.ts`)), undefined);
  });

  test("a success after three or more failures is a hard-won fix", () => {
    const o = new Observer();
    o.observe(fail("npm test", error));
    o.observe(fail("npm test", error));
    assert.equal(o.observe(pass("npm test")), undefined);
    for (let i = 0; i < 3; i++) o.observe(fail("npm test", `Exit code 1\nError: problem ${"abc"[i]}`));
    assert.deepEqual(o.observe(pass("npm test")), { type: "solved", subject: "`npm test`", attempts: 3 });
    assert.equal(o.observe(pass("npm test")), undefined);
  });

  test("probes never count", () => {
    const o = new Observer();
    for (let i = 0; i < 6; i++) assert.equal(o.observe(fail("grep -rn nope src", "Exit code 1")), undefined);
  });

  test("subagents have their own streaks and are marked", () => {
    const o = new Observer();
    o.observe(fail("npm test", error));
    o.observe(fail("npm test", error));
    assert.equal(o.observe(fail("npm test", error, "agent-1")), undefined);
    const main = o.observe(fail("npm test", error, "${agent_id}"));
    assert.ok(main?.type === "stuck" && main.agent === undefined);
    o.observe(fail("npm test", error, "agent-1"));
    const sub = o.observe(fail("npm test", error, "agent-1"));
    assert.ok(sub?.type === "stuck" && sub.agent === "agent-1");
  });

  test("file tools are keyed by path, and a successful edit resets them", () => {
    const o = new Observer();
    const edit = { event: "PostToolUseFailure", tool_name: "Edit", file_path: "/x/a.ts", error: "String to replace not found in file." };
    o.observe(edit);
    o.observe(edit);
    o.observe({ event: "PostToolUse", tool_name: "Edit", file_path: "/x/a.ts" });
    o.observe(edit);
    o.observe(edit);
    const third = o.observe(edit);
    assert.ok(third?.type === "stuck" && third.subject === "Edit on `/x/a.ts`");
  });

  test("failures more than 30 minutes apart start a new streak", () => {
    let clock = 0;
    const o = new Observer(() => clock);
    o.observe(fail("npm test", error));
    clock += 10 * 60 * 1000;
    o.observe(fail("npm test", error));
    clock += 31 * 60 * 1000;
    assert.equal(o.observe(fail("npm test", error)), undefined);
    clock += 60 * 1000;
    o.observe(fail("npm test", error));
    const third = o.observe(fail("npm test", error));
    assert.ok(third?.type === "stuck" && third.same === 3);
  });

  test("tracks the main thread's effort only", () => {
    const o = new Observer();
    o.observe({ ...pass("ls"), effort: "xhigh" });
    o.observe({ ...pass("ls"), effort: "low", agent_id: "agent-1" });
    o.observe({ ...pass("ls"), effort: "${effort.level}" });
    assert.equal(o.effort, "xhigh");
  });

  test("takes the transcript path from main-thread events only", () => {
    const o = new Observer();
    o.observe({ ...pass("ls"), transcript_path: "/main.jsonl" });
    o.observe({ ...pass("ls"), transcript_path: "/sub.jsonl", agent_id: "agent-1" });
    o.observe({ event: "UserPromptSubmit", prompt: "hoi", transcript_path: "${transcript_path}" });
    assert.equal(o.transcriptPath, "/main.jsonl");
  });

  test("frustration signals expire after the streak window", () => {
    let clock = 0;
    const o = new Observer(() => clock);
    assert.deepEqual(o.observe({ event: "UserPromptSubmit", prompt: "werkt nog steeds niet" }), { type: "frustration", count: 1 });
    clock += 5 * 60 * 60 * 1000;
    assert.deepEqual(o.observe({ event: "UserPromptSubmit", prompt: "it's still broken" }), { type: "frustration", count: 1 });
  });

  test("a new prompt forgets the last turn's effort, and /clear forgets everything", () => {
    const o = new Observer();
    o.observe({ ...pass("ls"), effort: "max" });
    o.observe({ event: "UserPromptSubmit", prompt: "volgende taak" });
    assert.equal(o.effort, undefined);
    o.observe(fail("npm test", error));
    o.observe(fail("npm test", error));
    o.observe({ event: "SessionStart", source: "clear" });
    assert.equal(o.observe(fail("npm test", error)), undefined);
  });

  test("counts frustration signals", () => {
    const o = new Observer();
    assert.equal(o.observe({ event: "UserPromptSubmit", prompt: "voeg een knop toe" }), undefined);
    assert.deepEqual(o.observe({ event: "UserPromptSubmit", prompt: "werkt nog steeds niet" }), { type: "frustration", count: 1 });
    assert.deepEqual(o.observe({ event: "UserPromptSubmit", prompt: "same error again" }), { type: "frustration", count: 2 });
  });
});

describe("Observer: checks after edits", () => {
  const edit = (file_path: string, agent_id = "") => ({ event: "PostToolUse", tool_name: "Edit", file_path, agent_id });
  const stop = (last_message = "Klaar, het werkt nu.", stop_hook_active = "false") => ({ event: "Stop", last_message, stop_hook_active });
  const prompt = { event: "UserPromptSubmit", prompt: "doe iets" };

  test("edits without a passing check flag the stop, once per turn", () => {
    const o = new Observer();
    o.observe(prompt);
    o.observe(edit("/repo/src/a.ts"));
    const signal = o.observe(stop());
    assert.ok(signal?.type === "unverified" && signal.files.join() === "/repo/src/a.ts" && signal.lastMessage === "Klaar, het werkt nu.");
    assert.equal(o.observe(stop()), undefined);
  });

  test("a passing check after the last edit clears it; an edit after the check doesn't", () => {
    const o = new Observer();
    o.observe(prompt);
    o.observe(edit("/repo/src/a.ts"));
    o.observe(pass("cd /repo && pnpm vitest run"));
    assert.equal(o.observe(stop()), undefined);
    o.observe(prompt);
    o.observe(edit("/repo/src/a.ts"));
    o.observe(pass("npx tsc --noEmit"));
    o.observe(edit("/repo/src/b.ts"));
    assert.equal(o.observe(stop())?.type, "unverified");
  });

  test("docs, scratch files, subagent edits and hook-continued stops don't count", () => {
    const o = new Observer();
    o.observe(prompt);
    o.observe(edit("/repo/README.md"));
    o.observe(edit("/private/tmp/scratch/x.ts"));
    o.observe(edit("/repo/src/a.ts", "agent-1"));
    assert.equal(o.observe(stop()), undefined);
    o.observe(edit("/repo/src/a.ts"));
    assert.equal(o.observe(stop("done", "true")), undefined);
  });

  test("a new prompt starts a new turn", () => {
    const o = new Observer();
    o.observe(edit("/repo/src/a.ts"));
    o.observe(prompt);
    assert.equal(o.observe(stop()), undefined);
  });
});

describe("Observer: delegated results", () => {
  const agent = (extra: Record<string, string>) => ({
    event: "PostToolUse",
    tool_name: "Agent",
    subagent_type: "effort-router:low",
    model: "sonnet",
    brief: "rename getUser to fetchUser",
    status: "completed",
    result: JSON.stringify([{ type: "text", text: "Renamed in 3 files." }, { type: "text", text: "Tests pass." }]),
    ...extra,
  });

  test("an effort-router tier's result goes to review, with its text extracted", () => {
    const signal = o().observe(agent({}));
    assert.deepEqual(signal, {
      type: "delegated",
      agent: "effort-router:low",
      model: "sonnet",
      brief: "rename getUser to fetchUser",
      result: "Renamed in 3 files.\nTests pass.",
    });
  });

  test("max's result isn't retried, but suggests keeping the lesson", () => {
    assert.deepEqual(o().observe(agent({ subagent_type: "effort-router:max" })), { type: "solved", subject: "the effort-router:max escalation", attempts: 0 });
  });

  test("skips other agents, background launches and subagent-internal calls", () => {
    assert.equal(o().observe(agent({ subagent_type: "Explore" })), undefined);
    assert.equal(o().observe(agent({ status: "async_launched" })), undefined);
    assert.equal(o().observe(agent({ agent_id: "agent-1" })), undefined);
  });

  function o() {
    return new Observer();
  }
});

describe("isFrustrated", () => {
  const yes = [
    "werkt nog steeds niet",
    "de tests falen nog steeds",
    "zelfde fout als net",
    "het helpt niet",
    "we draaien rondjes",
    "it's still failing",
    "still getting the same error",
    "that didn't fix it",
    "we're going in circles",
  ];
  const no = [
    "Make sure it still works when the file doesn't exist",
    "Use the same error format as the REST API",
    "Return the same result for both calls",
    "Check that the migration does not change anything in prod",
    "Make sure nothing changed in the public API",
    "Zorg dat het nog altijd werkt als de gebruiker niet ingelogd is",
    "Doe nu opnieuw hetzelfde voor de andere bestanden",
    "Toon dezelfde melding als bij het inloggen",
    "De pagina blijft hangen bij het laden",
    "/effort-router:gear-top the tests still fail after your fix",
    "<task-notification>\n<summary>Agent finished</summary>\nstill failing, same error\n</task-notification>",
    "de knop werkt niet",
    "is de build nog steeds bezig?",
    "is the build still running?",
    "fix the failing test",
    'kijk hier eens naar\n<pasted_content id="p1">\nsame error: still failing\n</pasted_content id="p1">',
  ];
  for (const prompt of yes) test(`yes: ${prompt}`, () => assert.equal(isFrustrated(prompt), true));
  for (const prompt of no) test(`no: ${prompt.split("\n")[0]}`, () => assert.equal(isFrustrated(prompt), false));

  test("an unclosed paste hides the rest, and huge prompts stay fast", () => {
    assert.equal(isFrustrated('check dit <pasted_content id="p1">\nstill failing'), false);
    assert.equal(isFrustrated('nog steeds kapot <pasted_content id="p1">\nlog'), true);
    const huge = '<pasted_content id="x">'.repeat(20_000) + "a".repeat(1_000_000);
    const started = performance.now();
    isFrustrated(huge);
    assert.ok(performance.now() - started < 200, "stripping pastes must stay linear");
  });
});

describe("modelFromTranscript", () => {
  test("returns the newest main-thread model, skipping sidechains and synthetic replies", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "effort-router-")), "t.jsonl");
    const line = (entry: object) => JSON.stringify(entry);
    writeFileSync(
      file,
      [
        line({ type: "assistant", isSidechain: false, message: { model: "claude-opus-5-5" } }),
        line({ type: "user", message: { content: "hi" } }),
        line({ type: "assistant", isSidechain: false, message: { model: "claude-fable-5-1" } }),
        line({ type: "assistant", isSidechain: true, message: { model: "claude-haiku-4-5" } }),
        line({ type: "assistant", isSidechain: false, message: { model: "<synthetic>" } }),
        '{"type":"assistant", "truncated',
      ].join("\n"),
    );
    assert.equal(await modelFromTranscript(file), "claude-fable-5-1");
    assert.equal(await modelFromTranscript(path.join(tmpdir(), "does-not-exist.jsonl")), undefined);
  });
});
