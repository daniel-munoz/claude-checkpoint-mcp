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

  it("keeps the resumed checkpoint's workflow on a replace save", async () => {
    const dir = tempDir();
    await save(await connect({ sessionId: S1 }), dir, { workflowId: "run-1", step: "work" });
    await save(await connect({ sessionId: S2 }), dir, { resumedFrom: S1 }); // mode defaults to replace
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


describe("approval payloads are refused", () => {
  const PAYLOAD = '{"boundCalls": {"Claim": []}}';
  const cases: [string, Record<string, unknown>][] = [
    ["goal", { goal: `post ${PAYLOAD}` }],
    ["summary", { summary: PAYLOAD }],
    ["tasks[0].description", { tasks: [{ description: PAYLOAD, status: "pending" }] }],
    ["nextSteps[0]", { nextSteps: [PAYLOAD] }],
    ["decisions[0]", { decisions: [PAYLOAD] }],
    ["recentCommands[0].command", { recentCommands: [{ command: `echo '${PAYLOAD}'` }] }],
    ["recentCommands[0].note", { recentCommands: [{ command: "ls", note: PAYLOAD }] }],
    ["modifiedFiles[0].note", { modifiedFiles: [{ path: "a.ts", note: PAYLOAD }] }],
  ];

  it.each(cases)("in %s, with nothing written", async (field, args) => {
    const dir = tempDir();
    const c = await connect({ sessionId: S1, workflowId: "run-1" });
    await save(c, dir, { goal: "first" }); // so a refused save would have to make a .prev
    const before = readFileSync(selectorPath(dir, S1), "utf8");
    const { result, text } = await save(c, dir, args);
    expect(result.isError).toBe(true);
    expect(text).toContain(field);
    expect(readFileSync(selectorPath(dir, S1), "utf8")).toBe(before);
    expect(existsSync(backupPath(selectorPath(dir, S1)))).toBe(false);
  });

  it.each(['{"idToken" : "x"}', '{"attestation":{}}', 'curl -d "{\\"boundCalls\\": {}}"'])("%s is refused too", async (text) => {
    const { result } = await save(await connect({ sessionId: S1 }), tempDir(), { summary: text, workflowId: "run-1" });
    expect(result.isError).toBe(true);
  });

  it("a payload in a modified file's path is refused", async () => {
    const { result } = await save(await connect({ sessionId: S1, workflowId: "run-1" }), tempDir(), {
      modifiedFiles: [{ path: '{"boundCalls":1}.json' }],
    });
    expect(result.isError).toBe(true);
  });

  it("outside a workflow, a save holding those keys is accepted as in 1.0", async () => {
    const dir = tempDir();
    const { result } = await save(await connect({ sessionId: S1 }), dir, { summary: 'OIDC returns {"idToken": "…"}' });
    expect(result.isError).toBeFalsy();
    expect(existsSync(selectorPath(dir, S1))).toBe(true);
  });

  it("prose that only names the keys saves", async () => {
    const { result } = await save(await connect({ sessionId: S1 }), tempDir(), { summary: "boundCalls are bound to the card" });
    expect(result.isError).toBeFalsy();
  });
});

describe("load and list by workflow", () => {
  const S3 = "33333333-3333-4333-8333-333333333333";
  function seed(dir: string) {
    mkdirSync(path.join(dir, ".claude-checkpoints"), { recursive: true });
    const put = (sid: string, at: string, workflowId: string, step: string) =>
      writeFileSync(
        selectorPath(dir, sid),
        serialize(makeCheckpoint({ sessionId: sid, updatedAt: at, workflowId, step, goal: { primary: `goal ${sid[0]}`, tasks: [] } })),
      );
    put(S1, "2026-11-19T10:00:00.000Z", "run-1", "analyse");
    put(S2, "2026-11-19T11:00:00.000Z", "run-1", "work");
    put(S3, "2026-11-19T12:00:00.000Z", "run-2", "work");
  }
  const list = (c: Client, dir: string, args: Record<string, unknown> = {}) =>
    call(c, "list_session_checkpoints", { projectRoot: dir, limit: 0, ...args });
  const load = (c: Client, dir: string, args: Record<string, unknown> = {}) =>
    call(c, "load_session_checkpoint", { projectRoot: dir, ...args });

  it("lists a workflow's checkpoints, newest first, with their steps", async () => {
    const dir = tempDir();
    seed(dir);
    const c = await connect({ sessionId: null });
    const { data, text } = await list(c, dir, { workflowId: "run-1" });
    expect(data.entries.map((e: any) => [e.selector, e.workflowId, e.step])).toEqual([
      [S2, "run-1", "work"],
      [S1, "run-1", "analyse"],
    ]);
    expect(text).toContain("workflow `run-1` · step `work`");
    expect((await list(c, dir)).data.total).toBe(3);
  });

  it("loads the newest checkpoint of a workflow from any session", async () => {
    const dir = tempDir();
    seed(dir);
    const { data } = await load(await connect({ sessionId: null }), dir, { workflowId: "run-1" });
    expect([data.found, data.selector]).toEqual([true, S2]);
    expect(data.resumeHint).toContain(S2);
  });

  it("skips an unreadable newest checkpoint for the next readable one", async () => {
    const dir = tempDir();
    seed(dir);
    writeFileSync(selectorPath(dir, S2), "{not json");
    writeFileSync(backupPath(selectorPath(dir, S2)), "{not json");
    const { data } = await load(await connect({ sessionId: null }), dir, { workflowId: "run-1" });
    expect(data.selector).toBe(S1);
    expect(data.warnings.join(" ")).toContain(S2); // the unreadable one may be newer: say so
  });

  it("gives no resumedFrom hint when the match is the caller's own checkpoint", async () => {
    const dir = tempDir();
    seed(dir);
    const { data } = await load(await connect({ sessionId: S2 }), dir, { workflowId: "run-1" });
    expect(data.selector).toBe(S2);
    expect(data.resumeHint).toBeUndefined();
  });

  it("finds nothing for an unknown workflow", async () => {
    const dir = tempDir();
    seed(dir);
    const { data, result } = await load(await connect({ sessionId: null }), dir, { workflowId: "run-9" });
    expect(result.isError).toBeFalsy();
    expect(data.found).toBe(false);
  });

  it("refuses workflowId together with checkpoint, and an invalid workflowId", async () => {
    const dir = tempDir();
    seed(dir);
    const c = await connect({ sessionId: null });
    expect((await load(c, dir, { workflowId: "run-1", checkpoint: S1 })).result.isError).toBe(true);
    expect((await load(c, dir, { workflowId: "a/b" })).result.isError).toBe(true);
    expect((await list(c, dir, { workflowId: "a/b" })).result.isError).toBe(true);
  });
});
