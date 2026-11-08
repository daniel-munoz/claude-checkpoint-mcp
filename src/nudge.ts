// The SessionStart nudge. Bundled into the plugin's hook, so it must not import anything that
// pulls in zod (schema.ts, store.ts, listing.ts): it only checks which checkpoint files exist.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { BACKUP_SUFFIX, CHECKPOINT_FILENAME, resolveRoot, SLOTS_DIRNAME } from "./paths.js";
import { formatAge } from "./render.js";
import { LEGACY_SELECTOR, SESSION_ID_PATTERN } from "./session.js";

/** The fields of Claude Code's SessionStart hook input that the nudge uses. */
export interface HookInput {
  cwd?: unknown;
}

/** Values of SESSION_CHECKPOINT_NUDGE that turn the nudge off. */
const OFF_VALUES = new Set(["0", "off", "false", "no"]);

const SLOT_EXT = ".json";
const SLOT_BACKUP_EXT = SLOT_EXT + BACKUP_SUFFIX;

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

async function mtimeMs(file: string): Promise<number | null> {
  try {
    const s = await stat(file);
    return s.isFile() ? s.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * Counts the checkpoints under the root (a file and its backup count once, as in
 * list_session_checkpoints) and the newest file's mtime, without reading any of them:
 * load_session_checkpoint is the one that reports unreadable files.
 */
async function findCheckpoints(root: string): Promise<{ count: number; newestMs: number }> {
  const legacy = path.join(root, CHECKPOINT_FILENAME);
  const groups = new Map<string, string[]>([[LEGACY_SELECTOR, [legacy, legacy + BACKUP_SUFFIX]]]);

  let names: string[] = [];
  try {
    names = await readdir(path.join(root, SLOTS_DIRNAME));
  } catch {
    // No slots directory: only the legacy file can exist.
  }
  for (const name of names) {
    const ext = [SLOT_EXT, SLOT_BACKUP_EXT].find((e) => name.endsWith(e));
    const stem = ext === undefined ? null : name.slice(0, -ext.length);
    if (stem === null || stem === LEGACY_SELECTOR || !SESSION_ID_PATTERN.test(stem)) continue;
    groups.set(stem, [...(groups.get(stem) ?? []), path.join(root, SLOTS_DIRNAME, name)]);
  }

  let count = 0;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const files of groups.values()) {
    const times = (await Promise.all(files.map(mtimeMs))).filter((t): t is number => t !== null);
    if (times.length === 0) continue;
    count++;
    newestMs = Math.max(newestMs, ...times);
  }
  return { count, newestMs };
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
  const { count, newestMs } = await findCheckpoints(root);
  if (count === 0) return null;

  const what = count === 1 ? "A session checkpoint exists" : `${count} session checkpoints exist`;
  const age = formatAge(new Date(newestMs).toISOString(), now);
  return (
    `${what} in ${root} (latest saved ${age}). Call load_session_checkpoint. ` +
    "If it returns this session's checkpoint, briefly summarize the goal and next steps it records and confirm with the user before acting on them. " +
    "If it returns a list, show it and ask the user which one to resume."
  );
}

/** The SessionStart hook's JSON output for a nudge message. */
export function hookOutput(message: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message } });
}
