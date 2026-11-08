import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { hookOutput, nudge, nudgeDisabled } from "../src/nudge.js";
import { createServer } from "../src/server.js";
import { checkpointPath, selectorPath, serialize } from "../src/store.js";
import { gitRepo, makeCheckpoint, tempDir } from "./helpers.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-10-08T12:05:00.000Z");
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

function writeSlot(root: string, selector: string, updatedAt = "2026-10-08T12:00:00.000Z"): void {
  const file = selectorPath(root, selector);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serialize(makeCheckpoint({ updatedAt })));
}

/** A server connected to a client whose only root is `dir`, as Claude Code started in `dir` would be. */
async function serverStartedIn(dir: string): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ sessionId: SESSION }).connect(serverTransport);
  const c = new Client({ name: "nudge-test", version: "0.0.0" }, { capabilities: { roots: {} } });
  c.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(dir).href }] }));
  await c.connect(clientTransport);
  clients.push(c);
  return c;
}

async function loadText(c: Client): Promise<string> {
  const result = (await c.callTool({ name: "load_session_checkpoint", arguments: {} })) as CallToolResult;
  return result.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

describe("nudge", () => {
  it("says nothing in a project without checkpoints", async () => {
    const dir = tempDir();
    expect(await nudge({ cwd: dir }, {}, NOW)).toBeNull();
  });

  it("reports the legacy file", async () => {
    const dir = tempDir();
    writeFileSync(checkpointPath(dir), serialize(makeCheckpoint()));
    const message = await nudge({ cwd: dir }, {}, NOW);
    expect(message).toContain(`A session checkpoint exists in ${dir} (latest saved 5m ago)`);
    expect(message).toContain("Call load_session_checkpoint");
  });

  it("counts session slots and reports the newest", async () => {
    const dir = tempDir();
    writeSlot(dir, "aaa", "2026-10-08T10:00:00.000Z");
    writeSlot(dir, "bbb", "2026-10-08T12:04:00.000Z");
    expect(await nudge({ cwd: dir }, {}, NOW)).toContain(`2 session checkpoints exist in ${dir} (latest saved 1m ago)`);
  });

  it("prefers CLAUDE_PROJECT_DIR over the input cwd", async () => {
    const project = tempDir();
    const elsewhere = tempDir();
    writeSlot(project, "aaa");
    expect(await nudge({ cwd: elsewhere }, { CLAUDE_PROJECT_DIR: project }, NOW)).toContain(project);
    expect(await nudge({ cwd: project }, { CLAUDE_PROJECT_DIR: elsewhere }, NOW)).toBeNull();
  });

  it("honors CHECKPOINT_PROJECT_ROOT first, like the server", async () => {
    const pinned = tempDir();
    const start = tempDir();
    writeSlot(pinned, "aaa");
    expect(await nudge({ cwd: start }, { CHECKPOINT_PROJECT_ROOT: pinned, CLAUDE_PROJECT_DIR: start }, NOW)).toContain(pinned);
  });

  it("can be turned off with SESSION_CHECKPOINT_NUDGE", async () => {
    const dir = tempDir();
    writeSlot(dir, "aaa");
    for (const value of ["off", "0", "false", "NO"]) {
      expect(nudgeDisabled({ SESSION_CHECKPOINT_NUDGE: value })).toBe(true);
      expect(await nudge({ cwd: dir }, { SESSION_CHECKPOINT_NUDGE: value }, NOW)).toBeNull();
    }
    expect(nudgeDisabled({ SESSION_CHECKPOINT_NUDGE: "on" })).toBe(false);
  });

  it("says nothing when the start directory is missing or not absolute", async () => {
    expect(await nudge({ cwd: path.join(tempDir(), "gone") }, {}, NOW)).toBeNull();
    expect(await nudge({ cwd: "relative/dir" }, {}, NOW)).toBeNull();
  });

  it("wraps the message as SessionStart additional context", () => {
    expect(JSON.parse(hookOutput("hi"))).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hi" } });
  });
});

describe("hook and server agree on the project root", () => {
  it("on a subdirectory start, ignores checkpoints at the git top-level, as the server does", async () => {
    const repo = gitRepo();
    const sub = path.join(repo, "packages", "app");
    mkdirSync(sub, { recursive: true });
    writeSlot(repo, "aaa");

    expect(await nudge({ cwd: sub }, { CLAUDE_PROJECT_DIR: sub }, NOW)).toBeNull();
    expect(await loadText(await serverStartedIn(sub))).toMatch(/^No checkpoint found/);
  });

  it("on a subdirectory start, finds what the server saved there", async () => {
    const repo = gitRepo();
    const sub = path.join(repo, "packages", "app");
    mkdirSync(sub, { recursive: true });

    const server = await serverStartedIn(sub);
    await server.callTool({ name: "save_session_checkpoint", arguments: { goal: "Work in a subdirectory" } });
    expect(existsSync(selectorPath(sub, SESSION))).toBe(true);

    expect(await nudge({ cwd: sub }, { CLAUDE_PROJECT_DIR: sub }, NOW)).toContain(`exists in ${sub}`);
    expect(await nudge({ cwd: repo }, { CLAUDE_PROJECT_DIR: repo }, NOW)).toBeNull();
    expect(await loadText(server)).toContain("Work in a subdirectory");
  });
});

describe("built hook", () => {
  const hook = path.resolve("plugin/dist/hook.js");
  const run = (input: string, env: NodeJS.ProcessEnv = {}) =>
    execFileSync(process.execPath, [hook], { input, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

  it.skipIf(!existsSync(hook))("prints nothing without checkpoints and JSON with them", () => {
    const dir = tempDir();
    expect(run(JSON.stringify({ cwd: dir }))).toBe("");
    writeSlot(dir, "aaa");
    const out = JSON.parse(run(JSON.stringify({ cwd: dir })));
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain(dir);
    expect(run("not json", { CLAUDE_PROJECT_DIR: dir })).toContain(dir);
  });
});
