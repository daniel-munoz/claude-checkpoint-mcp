// Checkpoint locations and the project-root rule. Imports only node: modules, so the
// SessionStart hook can use the same rule as the server without bundling zod.
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/** The legacy single checkpoint file, written by 0.1.x and by clients without a session id. */
export const CHECKPOINT_FILENAME = ".claude-checkpoint";

/** Directory under the project root holding one checkpoint file per session. */
export const SLOTS_DIRNAME = ".claude-checkpoints";

export const BACKUP_SUFFIX = ".prev";

export class CheckpointError extends Error {
  override name = "CheckpointError";
}

/**
 * Picks the project root: explicit argument, then CHECKPOINT_PROJECT_ROOT, then the
 * client's first file:// root (if it supports roots), then the server's cwd.
 */
export async function resolveRoot(
  explicit: string | undefined,
  clientRoot: () => Promise<string | undefined>,
  envRoot: string | undefined = process.env.CHECKPOINT_PROJECT_ROOT,
): Promise<string> {
  const candidate =
    explicit ??
    (envRoot || undefined) ??
    (await clientRoot().catch(() => undefined)) ??
    process.cwd();

  if (!path.isAbsolute(candidate)) {
    throw new CheckpointError(`projectRoot must be an absolute path, got: ${candidate}`);
  }
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new CheckpointError(`projectRoot does not exist: ${candidate}`);
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new CheckpointError(`projectRoot is not a directory: ${candidate}`);
  }
  return resolved;
}
