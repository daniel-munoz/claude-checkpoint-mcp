import { CheckpointError } from "./paths.js";

/** Selector for the single per-project `.claude-checkpoint` file written by 0.1.x and by clients without a session id. */
export const LEGACY_SELECTOR = "legacy";

/** Session ids double as file names under `.claude-checkpoints/`, so only allow path-safe characters. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface SessionId {
  id: string | null;
  warning?: string;
}

/**
 * Validates the session id Claude Code passes in CLAUDE_CODE_SESSION_ID. A missing id means
 * the client doesn't provide one (checkpoints fall back to the legacy file, or to a minted id when
 * `mint` is on); an unusable one is treated the same way but reported.
 */
export function resolveSessionId(raw: string | undefined, mint = false): SessionId {
  if (!raw) return { id: null };
  if (SESSION_ID_PATTERN.test(raw) && raw !== LEGACY_SELECTOR) return { id: raw };
  const fallback = mint ? "each conversation gets a minted session id instead" : "checkpoints are using the shared .claude-checkpoint file";
  return { id: null, warning: `CLAUDE_CODE_SESSION_ID is not a usable session id; ${fallback}.` };
}

/** Where a call's session id came from. */
export type SessionSource = "argument" | "env" | "minted";

/** The session a tool call acts for; both fields are null when no id is known. */
export interface CallSession {
  id: string | null;
  source: SessionSource | null;
}

/**
 * The session for one call: the `session` argument, then the env var's id. An argument must be a
 * usable id and, when the env var is set, the same one: a different id almost always means the agent
 * put a checkpoint selector in the wrong argument, and honoring it would write into another session.
 */
export function resolveCallSession(arg: string | undefined, envId: string | null): CallSession {
  if (arg === undefined) return envId === null ? { id: null, source: null } : { id: envId, source: "env" };
  if (!SESSION_ID_PATTERN.test(arg) || arg === LEGACY_SELECTOR) {
    throw new CheckpointError(`session must be a session id (letters, digits, "-" and "_", up to 128), not ${JSON.stringify(arg)}`);
  }
  if (envId === null) return { id: arg, source: "argument" };
  if (arg === envId) return { id: envId, source: "env" };
  throw new CheckpointError(
    `This server runs for session ${JSON.stringify(envId)}; session: ${JSON.stringify(arg)} names a different one. ` +
      "To continue another checkpoint, load it and pass its selector as resumedFrom on your next save. " +
      "To use this server's own session, omit session.",
  );
}

/** Whether saves without a session id mint one (CHECKPOINT_SESSION_IDS=mint) or use the legacy file. */
export interface IdMode {
  mint: boolean;
  warning?: string;
}

export function resolveIdMode(raw: string | undefined): IdMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "mint") return { mint: true };
  if (value === "" || value === "legacy") return { mint: false };
  return { mint: false, warning: `CHECKPOINT_SESSION_IDS must be "mint" or "legacy"; got ${JSON.stringify(raw)}. Using legacy.` };
}
