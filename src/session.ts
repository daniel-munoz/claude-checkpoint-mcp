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
 * the client doesn't provide one (checkpoints fall back to the legacy file); an unusable one
 * is treated the same way but reported.
 */
export function resolveSessionId(raw: string | undefined): SessionId {
  if (!raw) return { id: null };
  if (SESSION_ID_PATTERN.test(raw) && raw !== LEGACY_SELECTOR) return { id: raw };
  return {
    id: null,
    warning: "CLAUDE_CODE_SESSION_ID is not a usable session id; checkpoints are using the shared .claude-checkpoint file.",
  };
}
