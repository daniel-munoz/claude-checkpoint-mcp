import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { git, gitRepo, tempDir } from "./helpers.js";

let client: Client;

beforeEach(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return { result, text, data: result.structuredContent as Record<string, any> };
}

function seededRepo(): string {
  const dir = gitRepo();
  writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(dir, "b.ts"), "export const b = 1;\n");
  writeFileSync(path.join(dir, ".gitignore"), ".claude-checkpoint*\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

describe("tools over MCP", () => {
  it("lists both tools with schemas and annotations", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["load_session_checkpoint", "save_session_checkpoint"]);
    expect(byName.save_session_checkpoint?.inputSchema.required).toEqual(["goal"]);
    expect(byName.load_session_checkpoint?.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toMatch(/load_session_checkpoint/);
  });

  it("reports when there is nothing to load", async () => {
    const { result, data } = await call("load_session_checkpoint", { projectRoot: tempDir() });
    expect(result.isError).toBeFalsy();
    expect(data.found).toBe(false);
  });

  it("saves, detects git changes, redacts, and reports drift on load", async () => {
    const dir = seededRepo();
    writeFileSync(path.join(dir, "a.ts"), "export const a = 2;\n");
    writeFileSync(path.join(dir, "new.ts"), "new\n");

    const save = await call("save_session_checkpoint", {
      projectRoot: dir,
      goal: "Refactor a",
      tasks: [{ description: "Change a", status: "in_progress" }],
      summary: "Halfway there",
      nextSteps: ["Finish a"],
      modifiedFiles: [{ path: path.join(dir, "a.ts"), note: "bumped constant" }],
      recentCommands: [{ command: "API_KEY=supersecret npm test", exitCode: 1, note: "1 failing" }],
    });
    expect(save.result.isError).toBeFalsy();
    expect(save.data.counts).toEqual({ tasks: 1, modifiedFiles: 2, recentCommands: 1, redactions: 1 });
    expect(save.data.warnings).toEqual(["Redacted 1 secret-looking value(s)."]);

    const file = path.join(dir, ".claude-checkpoint");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.git).toMatchObject({ branch: "main", dirty: true });
    expect(onDisk.modifiedFiles).toEqual([
      expect.objectContaining({ path: "a.ts", status: "M", source: "git", note: "bumped constant" }),
      expect.objectContaining({ path: "new.ts", status: "??", source: "git" }),
    ]);
    expect(onDisk.recentCommands[0].command).toBe("API_KEY=«redacted» npm test");

    // Immediately after saving, nothing has drifted.
    const fresh = await call("load_session_checkpoint", { projectRoot: dir });
    expect(fresh.data.drift.changedSince).toEqual([]);
    expect(fresh.text).toContain("No files changed since the checkpoint");

    // Commit a.ts unchanged (should not count), edit b.ts, revert new.ts, add another file.
    git(dir, "add", "a.ts");
    git(dir, "commit", "-qm", "commit a");
    writeFileSync(path.join(dir, "b.ts"), "export const b = 2;\n");
    writeFileSync(path.join(dir, "later.ts"), "later\n");
    writeFileSync(path.join(dir, "new.ts"), "changed\n");

    const later = await call("load_session_checkpoint", { projectRoot: dir });
    expect(later.data.drift).toMatchObject({ branchChanged: false, commitsSince: 1 });
    expect(later.data.drift.changedSince).toEqual(["b.ts", "later.ts", "new.ts"]);
    expect(later.text).toContain("## Goal\nRefactor a");
    expect(later.text).toContain("- [~] Change a");
    expect(later.text).toContain("✗ exit 1 `API_KEY=«redacted» npm test` — 1 failing");
    expect(later.text).toContain("1 new commit(s) on HEAD");
  });

  it("merges into the existing checkpoint", async () => {
    const dir = seededRepo();
    await call("save_session_checkpoint", {
      projectRoot: dir,
      goal: "Goal",
      tasks: [{ description: "one", status: "in_progress" }],
      decisions: ["d1"],
      recentCommands: [{ command: "npm run build", exitCode: 0 }],
    });
    const first = JSON.parse(readFileSync(path.join(dir, ".claude-checkpoint"), "utf8"));

    await call("save_session_checkpoint", {
      projectRoot: dir,
      goal: "Goal",
      mode: "merge",
      tasks: [
        { description: "one", status: "done" },
        { description: "two", status: "pending" },
      ],
      decisions: ["d1", "d2"],
      recentCommands: [{ command: "npm test", exitCode: 0 }],
    });
    const merged = JSON.parse(readFileSync(path.join(dir, ".claude-checkpoint"), "utf8"));

    expect(merged.id).toBe(first.id);
    expect(merged.createdAt).toBe(first.createdAt);
    expect(merged.goal.tasks).toEqual([
      { description: "one", status: "done" },
      { description: "two", status: "pending" },
    ]);
    expect(merged.decisions).toEqual(["d1", "d2"]);
    expect(merged.recentCommands.map((c: { command: string }) => c.command)).toEqual(["npm run build", "npm test"]);
    expect(JSON.parse(readFileSync(path.join(dir, ".claude-checkpoint.prev"), "utf8")).id).toBe(first.id);
  });

  it("warns when the checkpoint is not git-ignored", async () => {
    const dir = gitRepo();
    const { data } = await call("save_session_checkpoint", { projectRoot: dir, goal: "g" });
    expect(data.warnings.some((w: string) => w.includes("not git-ignored"))).toBe(true);
  });

  it("works outside a git repo", async () => {
    const dir = tempDir();
    await call("save_session_checkpoint", { projectRoot: dir, goal: "g", summary: "no git here" });
    const { data, text } = await call("load_session_checkpoint", { projectRoot: dir });
    expect(data.drift).toBeNull();
    expect(text).toContain("no git here");
  });

  it("includes the brief in structuredContent, which clients may show the model instead of text", async () => {
    const dir = tempDir();
    await call("save_session_checkpoint", { projectRoot: dir, goal: "Ship it", nextSteps: ["Write tests"] });
    const { data, text } = await call("load_session_checkpoint", { projectRoot: dir });
    expect(data.brief).toBe(text);
    expect(data.brief).toContain("Ship it");
    expect(data.brief).toContain("Write tests");
  });

  it("returns a tool error for a bad projectRoot", async () => {
    const { result, text } = await call("save_session_checkpoint", { projectRoot: "relative", goal: "g" });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/absolute path/);
  });
});

describe("concurrency", () => {
  it("serializes parallel merge saves so none are lost", async () => {
    const dir = tempDir();
    await call("save_session_checkpoint", { projectRoot: dir, goal: "g" });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        call("save_session_checkpoint", { projectRoot: dir, goal: "g", mode: "merge", recentCommands: [{ command: `cmd ${i}` }] }),
      ),
    );
    const { data } = await call("load_session_checkpoint", { projectRoot: dir, format: "full" });
    expect(data.checkpoint.recentCommands.map((c: { command: string }) => c.command).sort()).toEqual(
      ["cmd 0", "cmd 1", "cmd 2", "cmd 3", "cmd 4"],
    );
  });
});
