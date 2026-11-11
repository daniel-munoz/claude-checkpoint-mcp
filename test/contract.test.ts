// The tool contract as clients receive it from tools/list (#26). From 1.0 this is covered by semver:
// adding an optional field is a minor change and means updating these lists; removing or renaming a
// tool or field, or making an input required, breaks clients and needs a major version.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
let tools: Record<string, Tool>;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ sessionId: null }).connect(serverTransport);
  const client = new Client({ name: "contract", version: "0.0.0" });
  await client.connect(clientTransport);
  tools = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
  await client.close();
});

const props = (schema: { properties?: Record<string, unknown> } | undefined) => Object.keys(schema?.properties ?? {}).sort();
const required = (schema: { required?: string[] } | undefined) => [...(schema?.required ?? [])].sort();

// readOnly, destructive, idempotent, openWorld. Save writes only its own slot (not destructive) and records
// timestamps (not idempotent); load and list only read. None touch the network. OpenAI's directory also
// rejects tools whose four hints aren't all explicit booleans.
const CONTRACT = {
  save_session_checkpoint: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    input: ["decisions", "goal", "mode", "modifiedFiles", "nextSteps", "projectRoot", "recentCommands", "resumedFrom", "session", "summary", "tasks"],
    inputRequired: ["goal"],
    output: ["bytes", "counts", "mode", "path", "session", "sessionSource", "warnings"],
    outputRequired: ["bytes", "counts", "mode", "path", "warnings"],
  },
  load_session_checkpoint: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: ["checkpoint", "format", "projectRoot", "session"],
    inputRequired: [],
    output: ["brief", "candidates", "checkpoint", "drift", "found", "fromBackup", "omitted", "path", "resumeHint", "selector", "session", "text", "total", "updatedAt", "warnings"],
    outputRequired: ["found", "path", "warnings"],
  },
  list_session_checkpoints: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: ["limit", "projectRoot", "session"],
    inputRequired: [],
    output: ["entries", "omitted", "path", "text", "total", "warnings"],
    outputRequired: ["entries", "omitted", "path", "text", "total", "warnings"],
  },
} as const;

describe("tool contract", () => {
  it("lists exactly the three checkpoint tools", () => {
    expect(Object.keys(tools).sort()).toEqual(Object.keys(CONTRACT).sort());
  });

  describe.each(Object.entries(CONTRACT))("%s", (name, c) => {
    it("declares all four hints as explicit booleans", () => {
      expect(tools[name]!.annotations).toEqual(expect.objectContaining(c.annotations));
    });

    it("takes exactly its documented inputs, as a strict object", () => {
      const schema = tools[name]!.inputSchema as { type: string; additionalProperties?: unknown };
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(props(tools[name]!.inputSchema)).toEqual([...c.input]);
      expect(required(tools[name]!.inputSchema)).toEqual([...c.inputRequired]);
    });

    it("returns exactly its documented outputs", () => {
      expect(tools[name]!.outputSchema?.type).toBe("object");
      expect(props(tools[name]!.outputSchema)).toEqual([...c.output]);
      expect(required(tools[name]!.outputSchema)).toEqual([...c.outputRequired]);
    });
  });

  it("documents where a save's session id came from", () => {
    const sessionSource = (tools.save_session_checkpoint!.outputSchema?.properties as Record<string, { enum?: string[] }>).sessionSource;
    expect([...(sessionSource?.enum ?? [])].sort()).toEqual(["argument", "env", "minted"]);
  });
});
