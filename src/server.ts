import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GENERATOR } from "./schema.js";
import { registerTools } from "./tools.js";

const INSTRUCTIONS = `\
Persists session context to a .claude-checkpoint file in the project so work survives crashes, /clear, and context limits.
- At the start of a session, or when the user says "resume" / "continue where we left off", call load_session_checkpoint and follow its next steps. Re-read only the files it lists as changed since the checkpoint.
- Call save_session_checkpoint after completing a milestone, before risky or long-running operations, and whenever the conversation is getting long. Use mode "merge" for incremental updates within the same task.
- Keep entries terse: the checkpoint is meant to be cheap to reload.`;

export function createServer(): McpServer {
  const server = new McpServer({ name: GENERATOR.name, version: GENERATOR.version }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}
