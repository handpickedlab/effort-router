import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Runs the built bundle the plugin ships, over stdio, the way Claude Code starts it.
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin", "dist", "server.mjs");

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("");
}

const state = mkdtempSync(path.join(tmpdir(), "effort-router-state-"));

describe("server over stdio", () => {
  const client = new Client({ name: "effort-router-test", version: "0.0.0" });

  before(async () => {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [server],
        env: { ...(process.env as Record<string, string>), EFFORT_ROUTER_OFFLINE: "1", EFFORT_ROUTER_STATE_DIR: state },
      }),
    );
  });
  after(() => client.close());

  test("advertises instructions and its tools", async () => {
    assert.match(client.getInstructions() ?? "", /effort-router picks the model and reasoning effort/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["knowledge", "models", "observe", "rank", "route"]);
  });

  test("knowledge and rank say so when Jev can't be asked", async () => {
    const knowledge = textOf(await client.callTool({ name: "knowledge", arguments: { facts: ["x"], context: "y" } }));
    assert.match(knowledge, /(couldn't be asked|is off for this project)/);
    const rank = textOf(await client.callTool({ name: "rank", arguments: { goal: "g", context: "c", options: ["a", "b"] } }));
    assert.match(rank, /(no fallback|can't run here)/);
  });

  test("a hard-won fix suggests keeping the lesson", async () => {
    const call = async (args: Record<string, string>) => textOf(await client.callTool({ name: "observe", arguments: args }));
    for (const x of ["a", "b", "c"]) await call({ event: "PostToolUseFailure", tool_name: "Bash", command: "pnpm build", error: `Exit code 1\nerror ${x}` });
    const output = JSON.parse(await call({ event: "PostToolUse", tool_name: "Bash", command: "pnpm build" }));
    assert.match(output.hookSpecificOutput.additionalContext, /`pnpm build` passes after 3 failed attempts.*call knowledge/);
  });

  test("route answers with a plan", async () => {
    const text = textOf(
      await client.callTool({
        name: "route",
        arguments: { task: "design the auth flow", kind: "design", needs_context: true, current_model: "claude-opus-5-5", current_effort: "medium" },
      }),
    );
    assert.match(text, /^effort-router: DEEP \(opus @ xhigh\)/);
    assert.match(text, /do: Skill\("effort-router:gear-xhigh"\)/);
  });

  test("hook failures turn into an escalation on the third identical one", async () => {
    // The transcript says the session now runs on Sonnet, overriding the model route was told.
    const transcript = path.join(mkdtempSync(path.join(tmpdir(), "effort-router-")), "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "assistant", isSidechain: false, message: { model: "claude-sonnet-5" } }) + "\n");
    const event = {
      event: "PostToolUseFailure",
      tool_name: "Bash",
      command: "npm test",
      error: "Exit code 1\nError: Cannot find module 'express'",
      agent_id: "",
      effort: "max",
      transcript_path: transcript,
    };
    assert.equal(textOf(await client.callTool({ name: "observe", arguments: event })), "{}");
    assert.equal(textOf(await client.callTool({ name: "observe", arguments: event })), "{}");
    const output = JSON.parse(textOf(await client.callTool({ name: "observe", arguments: event })));
    assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUseFailure");
    assert.match(output.hookSpecificOutput.additionalContext, /`npm test` has failed 3× in a row, 3× with the same error/);
    assert.match(output.hookSpecificOutput.additionalContext, /session: claude-sonnet-5 @ max \(seen by hooks\)/);
    assert.match(output.hookSpecificOutput.additionalContext, /do: Agent\(subagent_type: "effort-router:max", model: "fable"\)/);
    assert.match(output.hookSpecificOutput.additionalContext, /claude-sonnet-5 is already at its highest effort, below fable @ max/);
  });

  test("without Jev, a follow-up and an unchecked stop are left alone", async () => {
    const call = async (args: Record<string, string>) => textOf(await client.callTool({ name: "observe", arguments: args }));
    await call({ event: "UserPromptSubmit", prompt: "fix de login" });
    await call({ event: "PostToolUse", tool_name: "Edit", file_path: "/repo/src/login.ts", agent_id: "" });
    assert.equal(await call({ event: "Stop", last_message: "Opgelost: de login werkt nu.", stop_hook_active: "false" }), "{}");
    assert.equal(await call({ event: "UserPromptSubmit", prompt: "werkt nog steeds niet" }), "{}");
  });

  test("a delegated result is not second-guessed when Jev can't be asked", async () => {
    const result = JSON.stringify([{ type: "text", text: "no idea" }]);
    const args = { event: "PostToolUse", tool_name: "Agent", subagent_type: "effort-router:low", brief: "rename x", status: "completed", result };
    assert.equal(textOf(await client.callTool({ name: "observe", arguments: args })), "{}");
  });

  test("route decisions and hook signals are logged locally", async () => {
    const { readFileSync } = await import("node:fs");
    const kinds = readFileSync(path.join(state, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);
    assert.ok(kinds.includes("route"));
    assert.ok(kinds.includes("signal"));
  });

  test("models reports the bundled catalog when offline", async () => {
    const text = textOf(await client.callTool({ name: "models", arguments: {} }));
    assert.match(text, /^jev: (on|off) for \S+ \(/);
    assert.match(text, /\nsource: bundled/);
    assert.match(text, /fable\s+rank 4\s+claude-fable-5-1/);
  });
});
