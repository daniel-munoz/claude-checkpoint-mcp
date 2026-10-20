#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GENERATOR } from "./schema.js";
import { createServer } from "./server.js";
import { resolveSessionId } from "./session.js";

// stdout carries JSON-RPC frames; anything else written there corrupts the stream.
// All diagnostics go to stderr, which Claude Code captures in its MCP logs.
function log(message: string): void {
  process.stderr.write(`[${GENERATOR.name}] ${message}\n`);
}

async function main(): Promise<void> {
  const session = resolveSessionId(process.env.CLAUDE_CODE_SESSION_ID);
  const server = createServer({ sessionId: session.id, ...(session.warning ? { sessionWarning: session.warning } : {}) });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    log(`shutting down (${reason})`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("end", () => void shutdown("stdin closed"));

  await server.connect(transport);
  log(`v${GENERATOR.version} ready on stdio (cwd: ${process.cwd()}, session: ${session.id ?? "none"})`);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
