import { listCheckpoints } from "./listing.js";
import { resolveRoot } from "./store.js";

/** The fields of Claude Code's SessionStart hook input that the nudge uses. */
export interface HookInput {
  cwd?: unknown;
}

/** Values of SESSION_CHECKPOINT_NUDGE that turn the nudge off. */
const OFF_VALUES = new Set(["0", "off", "false", "no"]);

export function nudgeDisabled(env: NodeJS.ProcessEnv): boolean {
  return OFF_VALUES.has((env.SESSION_CHECKPOINT_NUDGE ?? "").trim().toLowerCase());
}

/**
 * The project root the server will use for this session, so the hook never reports checkpoints
 * that a plain load_session_checkpoint wouldn't find. It goes through the server's resolveRoot:
 * CHECKPOINT_PROJECT_ROOT first, then, in place of the client's root, the directory the session
 * started in, which hooks see as CLAUDE_PROJECT_DIR (or the input's cwd).
 */
export function hookRoot(input: HookInput, env: NodeJS.ProcessEnv): Promise<string> {
  const sessionDir = env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || undefined;
  return resolveRoot(undefined, async () => sessionDir, env.CHECKPOINT_PROJECT_ROOT);
}

/**
 * The context to add at session start, or null when there is nothing to say: the nudge is turned
 * off, the root can't be resolved, or the project has no checkpoints.
 */
export async function nudge(input: HookInput, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promise<string | null> {
  if (nudgeDisabled(env)) return null;
  let root: string;
  try {
    root = await hookRoot(input, env);
  } catch {
    return null;
  }
  const listing = await listCheckpoints(root, null, 1, now);
  if (listing.total === 0) return null;

  const newest = listing.entries[0];
  const latest = newest?.age ? ` (latest saved ${newest.age})` : "";
  const count = listing.total === 1 ? "A session checkpoint exists" : `${listing.total} session checkpoints exist`;
  return (
    `${count} in ${root}${latest}. Call load_session_checkpoint. ` +
    "If it returns this session's checkpoint, briefly summarize the goal and next steps it records and confirm with the user before acting on them. " +
    "If it returns a list, show it and ask the user which one to resume."
  );
}

/** The SessionStart hook's JSON output for a nudge message. */
export function hookOutput(message: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message } });
}
