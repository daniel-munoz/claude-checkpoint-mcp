import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { selectorPath, serialize } from "../src/store.js";
import { git, gitRepo, makeCheckpoint, tempDir } from "./helpers.js";

let client: Client;
let clients: Client[] = [];

/** Connects a client to a fresh server, as if started by a Claude Code session with this id. */
async function connect(sessionId: string | null): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ sessionId }).connect(serverTransport);
  const c = new Client({ name: "e2e", version: "0.0.0" });
  await c.connect(clientTransport);
  clients.push(c);
  return c;
}

beforeEach(async () => {
  client = await connect(null);
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function callAs(c: Client, name: string, args: Record<string, unknown>) {
  const result = (await c.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return { result, text, data: result.structuredContent as Record<string, any> };
}

const call = (name: string, args: Record<string, unknown>) => callAs(client, name, args);

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
    expect(Object.keys(byName).sort()).toEqual(["list_session_checkpoints", "load_session_checkpoint", "save_session_checkpoint"]);
    expect(byName.list_session_checkpoints?.annotations?.readOnlyHint).toBe(true);
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

/** Writes a checkpoint file directly, as another session (or 0.1.x, for "legacy") would have. */
function seed(root: string, selector: string, goal: string, updatedAt = "2026-10-20T10:00:00.000Z"): void {
  const file = selectorPath(root, selector);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serialize(makeCheckpoint({ goal: { primary: goal, tasks: [] }, updatedAt, ...(selector === "legacy" ? {} : { sessionId: selector }) })));
}

describe("per-session load", () => {
  it("loads the session's own checkpoint directly", async () => {
    const dir = tempDir();
    seed(dir, "s1", "my own work");
    const { data } = await callAs(await connect("s1"), "load_session_checkpoint", { projectRoot: dir });
    expect(data).toMatchObject({ found: true, selector: "s1" });
    expect(data.brief).toContain("my own work");
  });

  it("returns the list instead of loading another session's checkpoint, even when it is the only one", async () => {
    const dir = tempDir();
    seed(dir, "s1", "someone else's work");
    const { data, text } = await callAs(await connect("s2"), "load_session_checkpoint", { projectRoot: dir });
    expect(data.found).toBe(false);
    expect(data.candidates.map((e: { selector: string }) => e.selector)).toEqual(["s1"]);
    expect(data.brief).toBeUndefined();
    expect(text).toContain("someone else's work");
    expect(JSON.stringify(data)).toContain("someone else's work");
    expect(text).toMatch(/ask/i);
  });

  it("loads another session's checkpoint when it is selected explicitly", async () => {
    const dir = tempDir();
    seed(dir, "s1", "someone else's work");
    const { data } = await callAs(await connect("s2"), "load_session_checkpoint", { projectRoot: dir, checkpoint: "s1" });
    expect(data).toMatchObject({ found: true, selector: "s1" });
    expect(data.brief).toContain("someone else's work");
  });

  it("returns a tool error for unknown or unsafe selectors", async () => {
    const dir = tempDir();
    const c = await connect("s2");
    const unknown = await callAs(c, "load_session_checkpoint", { projectRoot: dir, checkpoint: "nope" });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.text).toMatch(/list_session_checkpoints/);
    const unsafe = await callAs(c, "load_session_checkpoint", { projectRoot: dir, checkpoint: "../x" });
    expect(unsafe.result.isError).toBe(true);
  });

  it("reports nothing to load for an empty slots directory", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, ".claude-checkpoints"));
    const { data } = await callAs(await connect("s1"), "load_session_checkpoint", { projectRoot: dir });
    expect(data.found).toBe(false);
    expect(data.candidates).toBeUndefined();
  });

  it("without a session id, loads the legacy checkpoint as 0.1.x did", async () => {
    const dir = tempDir();
    seed(dir, "legacy", "legacy work");
    seed(dir, "s1", "slot work", "2026-10-20T11:00:00.000Z");
    const { data } = await call("load_session_checkpoint", { projectRoot: dir });
    expect(data).toMatchObject({ found: true, selector: "legacy" });
    expect(data.brief).toContain("legacy work");
  });

  it("without a session id and no legacy checkpoint, lists the slots", async () => {
    const dir = tempDir();
    seed(dir, "s1", "slot work");
    const { data } = await call("load_session_checkpoint", { projectRoot: dir });
    expect(data.found).toBe(false);
    expect(data.candidates.map((e: { selector: string }) => e.selector)).toEqual(["s1"]);
  });

  it("lists every checkpoint with limit 0 and marks the caller's own", async () => {
    const dir = tempDir();
    for (let i = 0; i < 12; i++) seed(dir, `s${i}`, `goal ${i}`, `2026-10-20T${String(i).padStart(2, "0")}:00:00.000Z`);
    const c = await connect("s3");
    const all = await callAs(c, "list_session_checkpoints", { projectRoot: dir, limit: 0 });
    expect(all.data.entries).toHaveLength(12);
    expect(all.data.entries.find((e: { selector: string }) => e.selector === "s3").isCurrentSession).toBe(true);
    const some = await callAs(c, "list_session_checkpoints", { projectRoot: dir });
    expect(some.data).toMatchObject({ total: 12, omitted: 2 });
    expect(some.data.text).toBe(some.text);
  });
});
