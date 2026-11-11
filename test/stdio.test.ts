// Runs the committed server bundle over stdio, as clients do, to check the default for clients without
// a session id (#43). plugin/dist is committed and CI checks it matches the source.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const server = path.resolve("plugin/dist/index.js");
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** A client on the built server, with no Claude Code session id and CHECKPOINT_SESSION_IDS as given. */
async function connect(idMode?: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // These tests may themselves run inside Claude Code, which sets the session id.
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CHECKPOINT_SESSION_IDS;
  delete env.CHECKPOINT_PROJECT_ROOT;
  if (idMode !== undefined) env.CHECKPOINT_SESSION_IDS = idMode;
  const c = new Client({ name: "stdio-test", version: "0.0.0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: "ignore" }));
  clients.push(c);
  return c;
}

async function save(c: Client, dir: string) {
  const result = await c.callTool({ name: "save_session_checkpoint", arguments: { goal: "g", projectRoot: dir } });
  return result.structuredContent as Record<string, unknown>;
}

const slots = (dir: string) => {
  const d = path.join(dir, ".claude-checkpoints");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")) : [];
};

describe("built server without a session id", () => {
  it("mints a session id by default", async () => {
    const dir = tempDir();
    const data = await save(await connect(), dir);
    expect(data.sessionSource).toBe("minted");
    expect(slots(dir)).toEqual([`${data.session}.json`]);
    expect(existsSync(path.join(dir, ".claude-checkpoint"))).toBe(false);
  });

  it("shares the legacy file with CHECKPOINT_SESSION_IDS=legacy", async () => {
    const dir = tempDir();
    const data = await save(await connect("legacy"), dir);
    expect(data.session).toBeUndefined();
    expect(existsSync(path.join(dir, ".claude-checkpoint"))).toBe(true);
    expect(slots(dir)).toEqual([]);
  });
});
