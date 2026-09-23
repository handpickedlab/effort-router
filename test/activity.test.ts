import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { Activity, describeOverlap, repoOf } from "../src/activity.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "effort-router-activity-")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
const main = path.join(root, "repo");
const worktree = path.join(root, "worktree-b");
execFileSync("mkdir", ["-p", main]);
git(main, "init", "-q", "-b", "main");
writeFileSync(path.join(main, "a.ts"), "x");
git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
git(main, "worktree", "add", "-q", "-b", "feat-b", worktree);

const registry = path.join(root, "sessions");

describe("repoOf", () => {
  test("worktrees share the common dir and differ in top and branch", async () => {
    const a = await repoOf(main);
    const b = await repoOf(worktree);
    assert.equal(a?.common, b?.common);
    assert.notEqual(a?.top, b?.top);
    assert.equal(b?.branch, "feat-b");
    assert.equal(await repoOf(root), undefined);
  });
});

describe("Activity", () => {
  test("flags the same file in another session, and the same path in another worktree, once each", async () => {
    const one = new Activity(registry, "s1", main);
    const two = new Activity(registry, "s2", main);
    const three = new Activity(registry, "s3", worktree);
    assert.deepEqual(await one.edited(path.join(main, "a.ts")), []);

    const same = await two.edited(path.join(main, "a.ts"));
    assert.equal(same.length, 1);
    assert.equal(same[0].kind, "same-file");
    assert.match(describeOverlap(same[0]), /Another live Claude Code session edited this same file/);
    assert.deepEqual(await two.edited(path.join(main, "a.ts")), []);

    const other = await three.edited(path.join(worktree, "a.ts"));
    assert.deepEqual(other.map((o) => o.kind).sort(), ["other-worktree", "other-worktree"]);
    assert.match(describeOverlap(other[0]), /another worktree of this repo/);

    assert.deepEqual(await one.edited(path.join(main, "b.ts")), []);
    const repo = await repoOf(main);
    const nearby = await three.inRepo(repo!.common);
    assert.equal(nearby.length, 2);
    await Promise.all([one.close(), two.close(), three.close()]);
  });

  test("ignores edits older than an hour and records of dead processes", async () => {
    let clock = Date.now();
    const old = new Activity(registry, "old", main, () => clock);
    await old.edited(path.join(main, "c.ts"));
    clock += 61 * 60 * 1000;
    const now = new Activity(registry, "now", main, () => clock);
    assert.deepEqual(await now.edited(path.join(main, "c.ts")), []);

    writeFileSync(
      path.join(registry, "ghost.json"),
      JSON.stringify({ pid: 999_999_9, session: "ghost", projectDir: main, updatedAt: clock, edits: { [path.join(main, "d.ts")]: { file: path.join(main, "d.ts"), at: clock } } }),
    );
    assert.deepEqual(await now.edited(path.join(main, "d.ts")), []);
    await Promise.all([old.close(), now.close()]);
  });
});
