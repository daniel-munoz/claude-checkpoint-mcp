import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHECKPOINT_VERSION, GENERATOR, type Checkpoint } from "../src/schema.js";

export function tempDir(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "ckpt-test-")));
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

export function gitRepo(): string {
  const dir = tempDir();
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

export function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    version: CHECKPOINT_VERSION,
    id: "6f1c1f0e-0b8a-4d5e-9b1a-2f0c7a3d9e11",
    createdAt: "2026-10-08T12:00:00.000Z",
    updatedAt: "2026-10-08T12:00:00.000Z",
    generator: { ...GENERATOR },
    project: { name: "demo" },
    git: null,
    goal: { primary: "Ship the thing", tasks: [] },
    summary: "",
    nextSteps: [],
    decisions: [],
    modifiedFiles: [],
    recentCommands: [],
    meta: { redactions: 0, truncated: false },
    ...overrides,
  };
}
