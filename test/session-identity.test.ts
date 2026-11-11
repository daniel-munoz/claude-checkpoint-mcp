// The per-call `session` argument and opt-in id minting (#41, design: 2026-11-10-session-identity-design.md).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { checkpointPath, selectorPath, serialize } from "../src/store.js";
import { makeCheckpoint, tempDir } from "./helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PASS_LINE = "on every later checkpoint call in this conversation.";
const NO_ID_NOTE =
  "No session id was passed. If you saved earlier in this conversation, pass that save's session id as session; " +
  "it is also the selector of your checkpoint in list_session_checkpoints. " +
  "Otherwise your first save will return one; pass it as session on every later checkpoint call.";
const NO_ID_HEADER = "No session id was passed, so no checkpoint was loaded.";
const OWN_HEADER = "This session has no checkpoint in";
const LOST_ID = "If you saved earlier in this conversation, pass the session id that save returned.";

let clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

/** A client on a fresh server, started with this env var session id and minting flag. */
async function connect(sessionId: string | null, mint = false): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ sessionId, mintSessionIds: mint }).connect(serverTransport);
  const c = new Client({ name: "session-identity", version: "0.0.0" });
  await c.connect(clientTransport);
  clients.push(c);
  return c;
}

async function callAs(c: Client, name: string, args: Record<string, unknown>) {
  const result = (await c.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  return { result, text, data: result.structuredContent as Record<string, any> };
}

const save = (c: Client, dir: string, args: Record<string, unknown> = {}) =>
  callAs(c, "save_session_checkpoint", { goal: "g", projectRoot: dir, ...args });
const slotsDir = (dir: string) => path.join(dir, ".claude-checkpoints");
const slotFiles = (dir: string) => readdirSync(slotsDir(dir)).filter((f) => f.endsWith(".json"));
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("save with a session argument and minting", () => {
  it("mints an id on the first save when the flag is on, and saves to it", async () => {
    const dir = tempDir();
    const { data, text } = await save(await connect(null, true), dir);
    expect(data.sessionSource).toBe("minted");
    expect(data.session).toMatch(UUID);
    expect(existsSync(selectorPath(dir, data.session))).toBe(true);
    expect(existsSync(checkpointPath(dir))).toBe(false);
    expect(text).toContain(`Pass session: "${data.session}" ${PASS_LINE}`);
  });

  it("merges into the minted checkpoint when the id is passed back", async () => {
    const dir = tempDir();
    const c = await connect(null, true);
    const first = await save(c, dir, { decisions: ["d1"] });
    await save(c, dir, { session: first.data.session, mode: "merge", decisions: ["d2"] });
    expect(readJson(selectorPath(dir, first.data.session)).decisions).toEqual(["d1", "d2"]);
    expect(slotFiles(dir)).toHaveLength(1);
  });

  it("warns about a lost id on a minted merge save, and starts a second checkpoint", async () => {
    const dir = tempDir();
    const c = await connect(null, true);
    const first = await save(c, dir, { goal: "first" });
    const second = await save(c, dir, { goal: "second", mode: "merge" });
    expect(second.data.warnings.join("\n")).toContain(LOST_ID);
    expect(second.data.session).not.toBe(first.data.session);
    expect(slotFiles(dir)).toHaveLength(2);
    expect(readJson(selectorPath(dir, first.data.session)).goal.primary).toBe("first");
  });

  it("keeps writing the legacy file without the flag", async () => {
    const dir = tempDir();
    const { data } = await save(await connect(null), dir);
    expect(data.session).toBeUndefined();
    expect(data.sessionSource).toBeUndefined();
    expect(existsSync(checkpointPath(dir))).toBe(true);
    expect(existsSync(slotsDir(dir))).toBe(false);
  });

  it("uses a passed session without the flag", async () => {
    const dir = tempDir();
    const { data, text } = await save(await connect(null), dir, { session: "a1" });
    expect(existsSync(selectorPath(dir, "a1"))).toBe(true);
    expect(data.sessionSource).toBe("argument");
    expect(text).toContain(`Pass session: "a1" ${PASS_LINE}`);
  });

  it("lets the env var win over the flag", async () => {
    const dir = tempDir();
    const { data, text } = await save(await connect("env1", true), dir);
    expect(data.sessionSource).toBe("env");
    expect(existsSync(selectorPath(dir, "env1"))).toBe(true);
    expect(text).not.toContain("Pass session");
  });

  it("treats a session equal to the env var as the env var", async () => {
    const dir = tempDir();
    const { data, text } = await save(await connect("env1"), dir, { session: "env1" });
    expect(data.sessionSource).toBe("env");
    expect(text).not.toContain("Pass session");
  });

  it("rejects a session that differs from the env var and writes nothing", async () => {
    const dir = tempDir();
    const { result, text } = await save(await connect("env1"), dir, { session: "other" });
    expect(result.isError).toBe(true);
    expect(text).toContain("names a different one");
    expect(existsSync(slotsDir(dir))).toBe(false);
  });

  it("rejects an invalid session and writes nothing", async () => {
    const dir = tempDir();
    const c = await connect(null, true);
    for (const session of ["legacy", "../x"]) {
      const { result } = await save(c, dir, { session });
      expect(result.isError).toBe(true);
    }
    expect(existsSync(slotsDir(dir))).toBe(false);
    expect(existsSync(checkpointPath(dir))).toBe(false);
  });
});

/** Writes a checkpoint file directly, as another session (or 0.1.x, for "legacy") would have. */
function seed(root: string, selector: string, goal: string): void {
  const file = selectorPath(root, selector);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serialize(makeCheckpoint({ goal: { primary: goal, tasks: [] }, ...(selector === "legacy" ? {} : { sessionId: selector }) })));
}

const load = (c: Client, dir: string, args: Record<string, unknown> = {}) =>
  callAs(c, "load_session_checkpoint", { projectRoot: dir, ...args });
const list = (c: Client, dir: string, args: Record<string, unknown> = {}) =>
  callAs(c, "list_session_checkpoints", { projectRoot: dir, limit: 0, ...args });

describe("load and list with a session argument", () => {
  it("loads the passed session's own checkpoint", async () => {
    const dir = tempDir();
    seed(dir, "a1", "mine");
    const { data } = await load(await connect(null), dir, { session: "a1" });
    expect(data).toMatchObject({ found: true, selector: "a1", session: "a1" });
  });

  it("lists instead of auto-loading the legacy file when minting", async () => {
    const dir = tempDir();
    seed(dir, "legacy", "old");
    const { data, text } = await load(await connect(null, true), dir);
    expect(data.found).toBe(false);
    expect(data.candidates[0].selector).toBe("legacy");
    expect(text).toContain(NO_ID_NOTE);
  });

  it("still auto-loads the legacy file without the flag", async () => {
    const dir = tempDir();
    seed(dir, "legacy", "old");
    const { data } = await load(await connect(null), dir);
    expect(data).toMatchObject({ found: true, selector: "legacy" });
  });

  it("marks the passed session as current in the list", async () => {
    const dir = tempDir();
    seed(dir, "a1", "one");
    seed(dir, "b2", "two");
    const { data } = await list(await connect(null), dir, { session: "b2" });
    const current = data.entries.filter((e: { isCurrentSession: boolean }) => e.isCurrentSession).map((e: { selector: string }) => e.selector);
    expect(current).toEqual(["b2"]);
  });

  it("rejects a conflicting session on load and list", async () => {
    const dir = tempDir();
    const c = await connect("env1");
    for (const r of [await load(c, dir, { session: "other" }), await list(c, dir, { session: "other" })]) {
      expect(r.result.isError).toBe(true);
      expect(r.text).toContain("names a different one");
    }
  });
});

describe("wording for a caller without a session id (#47)", () => {
  it("points a caller that may have saved already to its own id, on load and list", async () => {
    const dir = tempDir();
    seed(dir, "a1", "mine");
    const c = await connect(null, true);
    expect((await load(c, dir)).text).toContain(NO_ID_NOTE);
    expect((await list(c, dir)).text).toContain(NO_ID_NOTE);
  });

  it("doesn't call the caller 'this session' in the list header when no id was passed", async () => {
    const dir = tempDir();
    seed(dir, "a1", "mine");
    const { text } = await load(await connect(null, true), dir);
    expect(text).toContain(`${NO_ID_HEADER} 1 checkpoint(s) exist in ${dir}.`);
    expect(text).not.toContain(OWN_HEADER);
  });

  it("uses the no-id header without minting too, when only session slots exist", async () => {
    const dir = tempDir();
    seed(dir, "a1", "mine");
    const { text } = await load(await connect(null), dir);
    expect(text).toContain(NO_ID_HEADER);
    expect(text).not.toContain(NO_ID_NOTE);
  });

  it("keeps the session header when the env var names the session", async () => {
    const dir = tempDir();
    seed(dir, "a1", "theirs");
    const { text } = await load(await connect("env1", true), dir);
    expect(text).toContain(`${OWN_HEADER} ${dir}, but 1 other checkpoint(s) exist.`);
    expect(text).not.toContain(NO_ID_HEADER);
    expect(text).not.toContain("No session id was passed");
  });
});
