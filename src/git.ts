import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitState } from "./schema.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 3000;

/** Hash recorded for a path that does not exist in the working tree. */
export const DELETED = "deleted";

/** Runs git without a shell; resolves to null on any failure (not a repo, git missing, timeout). */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch {
    return null;
  }
}

export interface GitChange {
  path: string;
  status: string;
  /** Working-tree blob hash, or DELETED. */
  hash: string;
}

export interface GitSnapshot {
  state: GitState;
  changes: GitChange[];
}

/** Captures branch, HEAD and working-tree changes, or null outside a git repo / before the first commit. */
export async function snapshot(root: string, maxChanges = Infinity): Promise<GitSnapshot | null> {
  const [branch, head, status] = await Promise.all([
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  if (branch === null || head === null || status === null) return null;

  const entries = parsePorcelainZ(status);
  const hashes = await hashFiles(root, entries.slice(0, maxChanges).map((e) => e.path));
  return {
    state: { branch: branch.trim(), head: head.trim(), dirty: entries.length > 0 },
    changes: entries.map((e) => ({ ...e, hash: hashes.get(e.path) ?? DELETED })),
  };
}

/**
 * Parses `git status --porcelain=v1 -z`. Entries are NUL-separated "XY path";
 * renames and copies are followed by an extra NUL-separated original path.
 */
export function parsePorcelainZ(out: string): Array<{ path: string; status: string }> {
  const fields = out.split("\0");
  const entries: Array<{ path: string; status: string }> = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    entries.push({ path: entry.slice(3), status: xy.trim() });
    if (xy[0] === "R" || xy[0] === "C") i++;
  }
  return entries;
}

/** Blob hashes for paths that exist; missing paths are simply absent from the map. */
async function hashFiles(root: string, paths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (paths.length === 0) return result;
  const out = await git(root, ["hash-object", "--", ...paths]);
  if (out !== null) {
    out.trim().split("\n").forEach((h, i) => result.set(paths[i]!, h));
    return result;
  }
  // One missing path fails the whole batch; fall back to hashing individually.
  await Promise.all(
    paths.map(async (p) => {
      const h = await git(root, ["hash-object", "--", p]);
      if (h !== null) result.set(p, h.trim());
    }),
  );
  return result;
}

export async function isIgnored(root: string, relPath: string): Promise<boolean | null> {
  // check-ignore exits 1 when the path is not ignored, which git() maps to null;
  // distinguish that from "not a repo" by checking repo membership first.
  if ((await git(root, ["rev-parse", "--git-dir"])) === null) return null;
  return (await git(root, ["check-ignore", "-q", "--", relPath])) !== null;
}

export interface Drift {
  branchChanged: boolean;
  currentBranch: string;
  /** Commits on HEAD since the checkpoint; null if the saved commit is no longer reachable. */
  commitsSince: number | null;
  /** Files whose content differs from what it was when the checkpoint was saved. */
  changedSince: string[];
}

/**
 * Works out which files changed after the checkpoint was taken. A file's content at
 * save time is either the recorded hash (it was dirty then) or its blob at the saved
 * HEAD (it was clean), so we only need to hash candidates and compare.
 */
export async function drift(
  root: string,
  saved: GitState,
  savedHashes: ReadonlyMap<string, string>,
  ignore: (path: string) => boolean = () => false,
): Promise<Drift | null> {
  const now = await snapshot(root);
  if (now === null) return null;

  const [count, diff] = await Promise.all([
    git(root, ["rev-list", "--count", `${saved.head}..HEAD`]),
    git(root, ["diff", "--name-only", "-z", saved.head, "--"]),
  ]);

  const differsFromHead = diff === null ? null : new Set(diff.split("\0").filter(Boolean));
  const candidates = driftCandidates(savedHashes, now.changes, differsFromHead, ignore);
  const evidence: ChangeEvidence = {
    savedHashes,
    current: await hashFiles(root, candidates),
    differsFromHead,
    untrackedNow: new Set(now.changes.filter((c) => c.status === "??").map((c) => c.path)),
  };

  return {
    branchChanged: now.state.branch !== saved.branch,
    currentBranch: now.state.branch,
    commitsSince: count === null ? null : Number.parseInt(count.trim(), 10),
    changedSince: candidates.filter((p) => changedAfterSave(p, evidence)).sort(),
  };
}

/** Paths that differ from saved HEAD now, plus everything that was dirty at save time. */
function driftCandidates(
  savedHashes: ReadonlyMap<string, string>,
  changes: readonly GitChange[],
  differsFromHead: ReadonlySet<string> | null,
  ignore: (path: string) => boolean,
): string[] {
  const all = new Set([...savedHashes.keys(), ...changes.map((c) => c.path), ...(differsFromHead ?? [])]);
  return [...all].filter((p) => !ignore(p));
}

interface ChangeEvidence {
  /** Hashes of the files that were dirty at save time. */
  savedHashes: ReadonlyMap<string, string>;
  /** Hashes of the candidates now; missing files are absent. */
  current: ReadonlyMap<string, string>;
  /** Paths that differ from the saved HEAD now; null if the saved HEAD is unreachable. */
  differsFromHead: ReadonlySet<string> | null;
  untrackedNow: ReadonlySet<string>;
}

function changedAfterSave(path: string, { savedHashes, current, differsFromHead, untrackedNow }: ChangeEvidence): boolean {
  const was = savedHashes.get(path);
  if (was !== undefined) return was !== (current.get(path) ?? DELETED);
  // Clean at save time, so any difference from saved HEAD happened afterwards. Without the saved
  // HEAD there is nothing to compare against, so it counts as changed.
  return differsFromHead === null || differsFromHead.has(path) || untrackedNow.has(path);
}
