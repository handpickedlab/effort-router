import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { jevAccess, projectJevAccess } from "../src/privacy.js";

describe("jevAccess", () => {
  const home = homedir();

  test("on by default, off below an excluded path, including its worktrees", () => {
    const config = { exclude: ["~/orca/workspaces/client-x"] };
    assert.equal(jevAccess({}, `${home}/anything`).allowed, true);
    assert.equal(jevAccess(config, `${home}/orca/workspaces/client-x/feature-branch`).allowed, false);
    assert.equal(jevAccess(config, `${home}/orca/workspaces/client-x`).allowed, false);
    // A shared prefix is not a parent directory.
    assert.equal(jevAccess(config, `${home}/orca/workspaces/client-xyz`).allowed, true);
  });

  test("off by default opens only for included paths", () => {
    const config = { jev: "off" as const, include: ["~/Documents/Projects/mine"] };
    assert.equal(jevAccess(config, `${home}/Documents/Projects/mine/app`).allowed, true);
    assert.deepEqual(jevAccess(config, `${home}/Documents/Projects/client`), { allowed: false, why: 'default "off"' });
  });

  test("the most specific entry wins", () => {
    const config = { exclude: ["~/Documents/Projects"], include: ["~/Documents/Projects/mine"] };
    assert.equal(jevAccess(config, `${home}/Documents/Projects/mine/app`).allowed, true);
    assert.equal(jevAccess(config, `${home}/Documents/Projects/client`).allowed, false);
  });
});

describe("projectJevAccess", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "effort-router-privacy-"));
  const project = path.join(dir, "client");
  mkdirSync(project);

  test("no config file means on", () => {
    assert.equal(projectJevAccess(project, path.join(dir, "missing.json")).allowed, true);
  });

  test("reads the file and follows edits", () => {
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ exclude: [project] }));
    assert.equal(projectJevAccess(project, file).allowed, false);
    writeFileSync(file, JSON.stringify({ exclude: [path.join(dir, "other")] }));
    // A later mtime: make sure the change is seen even within the same millisecond tick.
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    assert.equal(projectJevAccess(project, file).allowed, true);
  });

  test("an invalid config fails closed", () => {
    const file = path.join(dir, "broken.json");
    writeFileSync(file, "{ not json");
    const access = projectJevAccess(project, file);
    assert.equal(access.allowed, false);
    assert.match(access.why, /invalid/);
    writeFileSync(file, JSON.stringify({ exclude: "not-a-list" }));
    const later = new Date(Date.now() + 10000);
    utimesSync(file, later, later);
    assert.equal(projectJevAccess(project, file).allowed, false);
  });
});
