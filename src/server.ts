import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GENERATOR } from "./schema.js";
import { registerTools, type SessionConfig } from "./tools.js";

const INSTRUCTIONS = `\
Persists session context to a checkpoint file in the project so work survives crashes, /clear, and context limits. Each Claude Code session has its own checkpoint.
- At the start of a session, or when the user says "resume" / "continue where we left off", call load_session_checkpoint and follow its next steps. Re-read only the files it lists as changed since the checkpoint.
- If load_session_checkpoint returns a list instead of a checkpoint, show the list to the user and ask which one to resume, then call it again with that checkpoint. Never pick one on the user's behalf.
- After loading another session's checkpoint, pass its selector as \`resumedFrom\` on your next save_session_checkpoint call, so the save builds on it. The server does not remember what you loaded.
- Call save_session_checkpoint after completing a milestone, before risky or long-running operations, and whenever the conversation is getting long. Use mode "merge" for incremental updates within the same task.
- Subagents must not call save_session_checkpoint: they share the parent session's checkpoint, so a save would overwrite it. Report progress to the parent agent instead.
- If a save result has sessionSource "minted" or "argument", pass its session id as session on every later checkpoint call in this conversation. When sessionSource is "env" (Claude Code), omit session.
- Keep entries terse: the checkpoint is meant to be cheap to reload.`;

export interface ServerOptions {
  /** The Claude Code session id, or null when the client doesn't provide one. */
  sessionId?: string | null;
  /**
   * Saves without a session id mint one instead of using the legacy file. Off unless set here; the
   * published server sets it from CHECKPOINT_SESSION_IDS, where minting is the default (see resolveIdMode).
   */
  mintSessionIds?: boolean;
  /** Why a provided session setting couldn't be used; surfaced in every tool result. */
  sessionWarning?: string;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: GENERATOR.name, version: GENERATOR.version }, { instructions: INSTRUCTIONS });
  const config: SessionConfig = {
    envId: options.sessionId ?? null,
    mint: options.mintSessionIds ?? false,
    ...(options.sessionWarning ? { warning: options.sessionWarning } : {}),
  };
  registerTools(server, config);
  return server;
}
