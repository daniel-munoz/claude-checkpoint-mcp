import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GENERATOR } from "./schema.js";
import { registerTools, type Session } from "./tools.js";

const INSTRUCTIONS = `\
Persists session context to a checkpoint file in the project so work survives crashes, /clear, and context limits. Each Claude Code session has its own checkpoint.
- At the start of a session, or when the user says "resume" / "continue where we left off", call load_session_checkpoint and follow its next steps. Re-read only the files it lists as changed since the checkpoint.
- If load_session_checkpoint returns a list instead of a checkpoint, show the list to the user and ask which one to resume, then call it again with that checkpoint. Never pick one on the user's behalf.
- Call save_session_checkpoint after completing a milestone, before risky or long-running operations, and whenever the conversation is getting long. Use mode "merge" for incremental updates within the same task.
- Keep entries terse: the checkpoint is meant to be cheap to reload.`;

export interface ServerOptions {
  /** The Claude Code session id, or null when the client doesn't provide one. */
  sessionId?: string | null;
  /** Why a provided session id couldn't be used; surfaced in every tool result. */
  sessionWarning?: string;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: GENERATOR.name, version: GENERATOR.version }, { instructions: INSTRUCTIONS });
  const session: Session = { id: options.sessionId ?? null, ...(options.sessionWarning ? { warning: options.sessionWarning } : {}) };
  registerTools(server, session);
  return server;
}
