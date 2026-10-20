import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKPOINT_FILENAME, MAX_FILE_BYTES, parseCheckpoint, type Checkpoint } from "./schema.js";
import { LEGACY_SELECTOR, SESSION_ID_PATTERN } from "./session.js";

export const BACKUP_SUFFIX = ".prev";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Directory under the project root holding one checkpoint file per session. */
export const SLOTS_DIRNAME = ".claude-checkpoints";

/** The legacy single checkpoint file. */
export function checkpointPath(root: string): string {
  return path.join(root, CHECKPOINT_FILENAME);
}

export function backupPath(file: string): string {
  return file + BACKUP_SUFFIX;
}

/** Resolves a selector (a session id, or "legacy") to its checkpoint file; anything else is rejected. */
export function selectorPath(root: string, selector: string): string {
  if (selector === LEGACY_SELECTOR) return checkpointPath(root);
  if (!SESSION_ID_PATTERN.test(selector)) throw new CheckpointError(`unknown checkpoint selector: ${JSON.stringify(selector)}`);
  return path.join(root, SLOTS_DIRNAME, `${selector}.json`);
}

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
): Promise<string> {
  const candidate =
    explicit ??
    (process.env.CHECKPOINT_PROJECT_ROOT || undefined) ??
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

/** Converts an MCP root URI to a filesystem path, ignoring non-file roots. */
export function rootUriToPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function isCheckpoint(r: Checkpoint | "missing" | Error): r is Checkpoint {
  return typeof r === "object" && !(r instanceof Error);
}

async function readParsed(file: string): Promise<Checkpoint | "missing" | Error> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return err as Error;
  }
  try {
    return parseCheckpoint(JSON.parse(text));
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

export interface LoadResult {
  checkpoint: Checkpoint;
  fromBackup: boolean;
  warnings: string[];
}

/** Reads a checkpoint file, falling back to the .prev backup if the primary is missing or corrupt. */
export async function readCheckpoint(file: string): Promise<LoadResult | null> {
  const primary = await readParsed(file);
  if (isCheckpoint(primary)) {
    return { checkpoint: primary, fromBackup: false, warnings: [] };
  }

  const backup = await readParsed(backupPath(file));
  if (isCheckpoint(backup)) {
    const name = path.basename(file);
    const why = primary === "missing" ? "is missing" : `is unreadable (${summarizeError(primary)})`;
    return {
      checkpoint: backup,
      fromBackup: true,
      warnings: [`${name} ${why}; loaded the previous checkpoint from ${name}${BACKUP_SUFFIX}.`],
    };
  }

  if (primary === "missing" && backup === "missing") return null;
  const failure = primary instanceof Error ? primary : (backup as Error);
  throw new CheckpointError(`could not read checkpoint: ${summarizeError(failure)}`);
}

function summarizeError(err: Error): string {
  const msg = err.message.replace(/\s+/g, " ");
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

export function serialize(checkpoint: Checkpoint): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

/**
 * Drops the oldest commands, then the trailing file entries, until the serialized
 * checkpoint fits MAX_FILE_BYTES. Mutates the checkpoint; returns whether anything was dropped.
 */
export function fitToSize(checkpoint: Checkpoint): boolean {
  const size = () => Buffer.byteLength(serialize(checkpoint));
  let trimmed = false;
  while (size() > MAX_FILE_BYTES && checkpoint.recentCommands.length > 0) {
    checkpoint.recentCommands.shift();
    trimmed = true;
  }
  while (size() > MAX_FILE_BYTES && checkpoint.modifiedFiles.length > 0) {
    checkpoint.modifiedFiles.pop();
    trimmed = true;
  }
  if (trimmed) checkpoint.meta.truncated = true;
  return trimmed;
}

/**
 * Atomically writes a checkpoint file (temp file + fsync + rename, mode 0600). The current
 * file is first copied to .prev, but only if it is valid, so a corrupt file never
 * clobbers the last good backup. Returns the number of bytes written.
 */
export async function writeCheckpoint(target: string, checkpoint: Checkpoint): Promise<number> {
  const data = serialize(checkpoint);
  await mkdir(path.dirname(target), { recursive: true, mode: DIR_MODE });

  if (isCheckpoint(await readParsed(target))) {
    await copyFile(target, backupPath(target));
    await chmod(backupPath(target), FILE_MODE);
  }

  const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, FILE_MODE);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } catch (err) {
    await handle.close();
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await handle.close();
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return Buffer.byteLength(data);
}
