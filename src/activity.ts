import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Repo {
  /** The shared .git directory: the same for every worktree of one repository. */
  common: string;
  /** This worktree's root. */
  top: string;
  branch: string;
}

const repos = new Map<string, Promise<Repo | undefined>>();

/** The git repository a directory belongs to, cached per directory. */
export function repoOf(dir: string): Promise<Repo | undefined> {
  let repo = repos.get(dir);
  if (!repo) {
    repo = run("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel", "--abbrev-ref", "HEAD"], {
      timeout: 2000,
    }).then(
      ({ stdout }) => {
        const [common, top, branch] = stdout.trim().split("\n");
        return common && top ? { common, top, branch: branch ?? "" } : undefined;
      },
      () => undefined,
    );
    repos.set(dir, repo);
  }
  return repo;
}

interface Edit {
  file: string;
  repo?: string;
  /** Path inside the worktree, so the same file in two worktrees compares equal. */
  rel?: string;
  branch?: string;
  at: number;
}

interface Record_ {
  pid: number;
  session: string;
  projectDir: string;
  updatedAt: number;
  edits: Record<string, Edit>;
}

export interface Overlap {
  kind: "same-file" | "other-worktree";
  file: string;
  otherProject: string;
  otherBranch?: string;
  minutesAgo: number;
}

/** Edits older than this don't count as parallel work. */
const WINDOW_MS = 60 * 60 * 1000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Which files each live session edited in the last hour, in one JSON file per session. Lets a
 * session notice another one, or another worktree of the same repo, working on the same file.
 */
export class Activity {
  private readonly own: Record_;
  private readonly warned = new Set<string>();

  constructor(
    private readonly dir: string,
    session: string,
    projectDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.own = { pid: process.pid, session, projectDir, updatedAt: now(), edits: {} };
  }

  private get file() {
    return path.join(this.dir, `${this.own.session}.json`);
  }

  private async others(): Promise<Record_[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: Record_[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name === `${this.own.session}.json`) continue;
      try {
        const record = JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as Record_;
        if (this.now() - record.updatedAt > WINDOW_MS || !alive(record.pid)) {
          await rm(path.join(this.dir, name), { force: true });
          continue;
        }
        records.push(record);
      } catch {
        // Half-written or foreign file: skip it.
      }
    }
    return records;
  }

  /** Records an edit and returns other sessions' recent edits to the same file, each reported once. */
  async edited(file: string): Promise<Overlap[]> {
    const at = this.now();
    const repo = await repoOf(path.dirname(file));
    this.own.edits[file] = { file, repo: repo?.common, rel: repo && path.relative(repo.top, file), branch: repo?.branch, at };
    for (const [key, edit] of Object.entries(this.own.edits)) if (at - edit.at > WINDOW_MS) delete this.own.edits[key];
    this.own.updatedAt = at;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify(this.own));
      await rename(`${this.file}.tmp`, this.file);
    } catch {
      // Without the registry there is nothing to compare; carry on.
    }

    const mine = this.own.edits[file];
    const overlaps: Overlap[] = [];
    for (const other of await this.others()) {
      for (const edit of Object.values(other.edits)) {
        if (at - edit.at > WINDOW_MS) continue;
        const kind = edit.file === file ? "same-file" : mine.repo && edit.repo === mine.repo && edit.rel === mine.rel ? "other-worktree" : undefined;
        const key = `${other.session}|${file}`;
        if (!kind || this.warned.has(key)) continue;
        this.warned.add(key);
        overlaps.push({ kind, file, otherProject: other.projectDir, otherBranch: edit.branch, minutesAgo: Math.round((at - edit.at) / 60000) });
      }
    }
    return overlaps;
  }

  /** Other live sessions that edited files in this repository in the last hour. */
  async inRepo(common: string): Promise<{ projectDir: string; branch?: string; files: string[] }[]> {
    const at = this.now();
    return (await this.others())
      .map((other) => {
        const edits = Object.values(other.edits).filter((e) => e.repo === common && at - e.at <= WINDOW_MS);
        return { projectDir: other.projectDir, branch: edits[0]?.branch, files: edits.map((e) => e.rel ?? e.file) };
      })
      .filter((s) => s.files.length > 0);
  }

  /** Removes this session's record, on exit. */
  async close(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

export function describeOverlap(overlap: Overlap): string {
  const where = `${overlap.otherProject}${overlap.otherBranch ? ` (branch ${overlap.otherBranch})` : ""}`;
  const when = overlap.minutesAgo < 1 ? "just now" : `${overlap.minutesAgo} min ago`;
  if (overlap.kind === "same-file") {
    return `[effort-router] Another live Claude Code session edited this same file ${when}: ${overlap.file}, from ${where}. Two sessions writing one file overwrite each other's changes. Re-read the file before editing further, and tell the user so they can decide which session owns it.`;
  }
  return `[effort-router] ${path.basename(overlap.file)} was also changed ${when} in another worktree of this repo: ${where}. Parallel edits to one file mean a merge conflict later, and maybe duplicate work. Mention it to the user if the two changes could overlap in purpose.`;
}
