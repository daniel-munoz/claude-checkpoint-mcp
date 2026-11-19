// Workflow checkpoints through the tools (#55, design: 2026-11-19-workflow-checkpoints-design.md).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerOptions } from "../src/server.js";
import { backupPath, selectorPath, serialize } from "../src/store.js";
import { makeCheckpoint, tempDir } from "./helpers.js";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
let clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function connect(options: ServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(serverTransport);
  const c = new Client({ name: "workflow", version: "0.0.0" });
  await c.connect(clientTransport);
  clients.push(c);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const result = (await c.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  return { result, text, data: result.structuredContent as Record<string, any> };
}

const save = (c: Client, dir: string, args: Record<string, unknown> = {}) =>
  call(c, "save_session_checkpoint", { goal: "g", projectRoot: dir, ...args });
const readJson = (dir: string, sid: string) => JSON.parse(readFileSync(selectorPath(dir, sid), "utf8"));

describe("save records the workflow", () => {
  it("records the workflow from its arguments", async () => {
    const dir = tempDir();
    await save(await connect({ sessionId: S1 }), dir, { workflowId: "run-1", step: "analyse" });
    const json = readJson(dir, S1);
    expect([json.version, json.workflowId, json.step]).toEqual([1, "run-1", "analyse"]);
  });

  it("falls back to the environment, and an argument wins", async () => {
    const dir = tempDir();
    const c = await connect({ sessionId: S1, workflowId: "run-env", workflowStep: "work" });
    await save(c, dir);
    expect([readJson(dir, S1).workflowId, readJson(dir, S1).step]).toEqual(["run-env", "work"]);
    await save(c, dir, { step: "groom" });
    expect([readJson(dir, S1).workflowId, readJson(dir, S1).step]).toEqual(["run-env", "groom"]);
  });

  it("keeps the base's workflow on a merge save, and when resuming another session", async () => {
    const dir = tempDir();
    await save(await connect({ sessionId: S1 }), dir, { workflowId: "run-1", step: "work" });
    await save(await connect({ sessionId: S1 }), dir, { mode: "merge", summary: "more" });
    expect([readJson(dir, S1).workflowId, readJson(dir, S1).step]).toEqual(["run-1", "work"]);
    await save(await connect({ sessionId: S2 }), dir, { mode: "merge", resumedFrom: S1 });
    expect([readJson(dir, S2).workflowId, readJson(dir, S2).step]).toEqual(["run-1", "work"]);
  });

  it("merges onto a file 1.0.0 wrote", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, ".claude-checkpoints"), { recursive: true });
    writeFileSync(selectorPath(dir, S1), serialize(makeCheckpoint({ sessionId: S1 })));
    const { result } = await save(await connect({ sessionId: S1 }), dir, { mode: "merge", workflowId: "run-1" });
    expect(result.isError).toBeFalsy();
    expect(readJson(dir, S1).workflowId).toBe("run-1");
    expect(readJson(dir, S1).goal.primary).toBe("g");
  });

  it("rejects an invalid workflowId argument and writes nothing", async () => {
    const dir = tempDir();
    const { result } = await save(await connect({ sessionId: S1 }), dir, { workflowId: "a b" });
    expect(result.isError).toBe(true);
    expect(existsSync(selectorPath(dir, S1))).toBe(false);
  });

  it("writes no workflow fields when none are given", async () => {
    const dir = tempDir();
    await save(await connect({ sessionId: S1 }), dir);
    const json = readJson(dir, S1);
    expect("workflowId" in json || "step" in json).toBe(false);
  });
});

