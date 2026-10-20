import { randomUUID } from "node:crypto";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { drift as computeDrift, isIgnored, snapshot, type Drift } from "./git.js";
import { createRedactor, type Redactor } from "./redact.js";
import { renderBrief } from "./render.js";
import {
  CHECKPOINT_FILENAME,
  CHECKPOINT_VERSION,
  GENERATOR,
  LIMITS,
  MAX_FILE_BYTES,
  Task,
  type Checkpoint,
  type ModifiedFile,
  type RecentCommand,
} from "./schema.js";
import {
  BACKUP_SUFFIX,
  CheckpointError,
  checkpointPath,
  fitToSize,
  readCheckpoint,
  resolveRoot,
  rootUriToPath,
  writeCheckpoint,
} from "./store.js";

/** Upper bound on git-detected files hashed per save; beyond this, drift falls back to diff vs HEAD. */
const MAX_HASHED_CHANGES = 500;
const CLIENT_ROOTS_TIMEOUT_MS = 2000;

const projectRootArg = z
  .string()
  .optional()
  .describe("Absolute path of the project. Defaults to the client's workspace root or the server's working directory.");

const saveInput = {
  goal: z.string().min(1).max(LIMITS.goal).describe("The primary objective of the session, in one or two sentences."),
  tasks: z
    .array(Task)
    .max(LIMITS.tasks)
    .optional()
    .describe("Sub-goals with their status. In merge mode, tasks with the same description are updated."),
  summary: z
    .string()
    .max(LIMITS.summary)
    .optional()
    .describe("Where things stand: what works, what is broken, what you were in the middle of."),
  nextSteps: z
    .array(z.string().max(LIMITS.item))
    .max(LIMITS.nextSteps)
    .optional()
    .describe("Concrete next actions, in order, for whoever resumes."),
  decisions: z
    .array(z.string().max(LIMITS.item))
    .max(LIMITS.decisions)
    .optional()
    .describe("Key decisions, constraints, and dead ends to avoid repeating."),
  modifiedFiles: z
    .array(z.object({ path: z.string().min(1).max(LIMITS.path), note: z.string().max(LIMITS.item).optional() }))
    .max(LIMITS.modifiedFiles)
    .optional()
    .describe("Files you changed, with an optional note. Uncommitted git changes are detected automatically; list files here to annotate them or to include committed ones."),
  recentCommands: z
    .array(
      z.object({
        command: z.string().min(1).max(LIMITS.command),
        exitCode: z.number().int().optional(),
        note: z.string().max(LIMITS.item).optional(),
      }),
    )
    .max(LIMITS.recentCommands)
    .optional()
    .describe("Recent significant terminal commands (builds, tests, migrations), oldest first, with exit codes and a short note on the outcome. Secrets are redacted automatically."),
  mode: z
    .enum(["replace", "merge"])
    .default("replace")
    .describe("replace: overwrite the checkpoint. merge: update the existing one, appending commands, decisions and files."),
  projectRoot: projectRootArg,
};

const saveOutput = {
  path: z.string(),
  bytes: z.number(),
  mode: z.enum(["replace", "merge"]),
  counts: z.object({
    tasks: z.number(),
    modifiedFiles: z.number(),
    recentCommands: z.number(),
    redactions: z.number(),
  }),
  warnings: z.array(z.string()),
};

const loadInput = {
  format: z
    .enum(["brief", "full"])
    .default("brief")
    .describe("brief: compact markdown for resuming (recommended). full: the complete checkpoint JSON."),
  projectRoot: projectRootArg,
};

const loadOutput = {
  found: z.boolean(),
  path: z.string(),
  fromBackup: z.boolean().optional(),
  updatedAt: z.string().optional(),
  drift: z
    .object({
      branchChanged: z.boolean(),
      currentBranch: z.string(),
      commitsSince: z.number().nullable(),
      changedSince: z.array(z.string()),
    })
    .nullable()
    .optional(),
  warnings: z.array(z.string()),
  brief: z.string().optional(),
  checkpoint: z.record(z.unknown()).optional(),
};

type SaveArgs = z.infer<z.ZodObject<typeof saveInput>>;

const CHECKPOINT_FILES = new Set([CHECKPOINT_FILENAME, CHECKPOINT_FILENAME + BACKUP_SUFFIX]);
const isCheckpointFile = (p: string) => CHECKPOINT_FILES.has(p) || p.startsWith(`${CHECKPOINT_FILENAME}.tmp-`);

export function registerTools(server: McpServer): void {
  // The SDK dispatches requests concurrently and models may issue parallel tool calls;
  // run checkpoint operations one at a time so merges and reads never interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    const next = queue.then(() => guard(fn));
    queue = next;
    return next;
  };

  const clientRoot = async (): Promise<string | undefined> => {
    if (!server.server.getClientCapabilities()?.roots) return undefined;
    const { roots } = await server.server.listRoots(undefined, { timeout: CLIENT_ROOTS_TIMEOUT_MS });
    return roots.map((r) => rootUriToPath(r.uri)).find((p) => p !== undefined);
  };

  server.registerTool(
    "save_session_checkpoint",
    {
      title: "Save session checkpoint",
      description:
        "Save the current session's goal, progress, touched files and recent commands to a .claude-checkpoint file in the project, " +
        "so a new session can resume after a crash, /clear, or context limit without re-exploring. " +
        "Call after finishing a milestone, before risky operations, and when the conversation is getting long. " +
        "Git branch, HEAD and uncommitted files are captured automatically.",
      inputSchema: saveInput,
      outputSchema: saveOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => serialized(() => save(args, clientRoot)),
  );

  server.registerTool(
    "load_session_checkpoint",
    {
      title: "Load session checkpoint",
      description:
        "Load the project's .claude-checkpoint and return a compact brief of the previous session's goal, progress, next steps, " +
        "touched files and recent commands, plus which files changed since it was saved. Call at the start of a session " +
        "or when the user asks to resume.",
      inputSchema: loadInput,
      outputSchema: loadOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => serialized(() => load(args.format, args.projectRoot, clientRoot)),
  );
}

/** Turns expected failures into tool errors the model can read and act on. */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof CheckpointError ? err.message : `unexpected error: ${(err as Error).message ?? String(err)}`;
    return { isError: true, content: [{ type: "text", text: `Checkpoint error: ${message}` }] };
  }
}

async function save(args: SaveArgs, clientRoot: () => Promise<string | undefined>): Promise<CallToolResult> {
  const root = await resolveRoot(args.projectRoot, clientRoot);
  const now = new Date().toISOString();
  const redactor = createRedactor();
  const warnings: string[] = [];

  const previous = args.mode === "merge" ? await readCheckpoint(root).catch(() => null) : null;
  if (args.mode === "merge" && previous === null) warnings.push("No existing checkpoint to merge into; saved a new one.");
  if (previous) warnings.push(...previous.warnings);
  const base = previous?.checkpoint;

  const git = await snapshot(root, MAX_HASHED_CHANGES);
  const tasks = mergeTasks(base?.goal.tasks ?? [], (args.tasks ?? []).map((t) => ({ ...t, description: redactor.scrub(t.description) })));
  const newCommands: RecentCommand[] = (args.recentCommands ?? []).map((c) => ({
    command: redactor.scrub(c.command),
    exitCode: c.exitCode,
    note: c.note === undefined ? undefined : redactor.scrub(c.note),
    at: now,
  }));

  let droppedOldest = false;
  const keepLast = <T>(items: T[], max: number): T[] => {
    if (items.length > max) droppedOldest = true;
    return items.slice(-max);
  };

  const checkpoint: Checkpoint = {
    version: CHECKPOINT_VERSION,
    id: base?.id ?? randomUUID(),
    createdAt: base?.createdAt ?? now,
    updatedAt: now,
    generator: { ...GENERATOR },
    project: { name: path.basename(root) },
    git: git?.state ?? null,
    goal: { primary: redactor.scrub(args.goal), tasks: keepLast(tasks, LIMITS.tasks) },
    summary: args.summary !== undefined ? redactor.scrub(args.summary) : (base?.summary ?? ""),
    nextSteps: args.nextSteps !== undefined ? args.nextSteps.map(redactor.scrub) : (base?.nextSteps ?? []),
    decisions: keepLast(dedupe([...(base?.decisions ?? []), ...(args.decisions ?? []).map(redactor.scrub)]), LIMITS.decisions),
    modifiedFiles: [],
    recentCommands: keepLast([...(base?.recentCommands ?? []), ...newCommands], LIMITS.recentCommands),
    meta: { redactions: 0, truncated: false },
  };

  const files = buildFileList(root, git?.changes ?? [], args.modifiedFiles ?? [], base?.modifiedFiles ?? [], redactor);
  checkpoint.modifiedFiles = files.slice(0, LIMITS.modifiedFiles);
  const tooManyFiles = files.length > LIMITS.modifiedFiles;
  if (tooManyFiles) warnings.push(`Only the first ${LIMITS.modifiedFiles} of ${files.length} modified files were recorded.`);
  if (droppedOldest) warnings.push("The oldest tasks, decisions or commands were dropped to stay within per-list limits.");

  checkpoint.meta = { redactions: redactor.count, truncated: tooManyFiles || droppedOldest };
  if (fitToSize(checkpoint)) warnings.push(`Older commands or files were dropped to keep the checkpoint under ${MAX_FILE_BYTES / 1024} KB.`);
  if (redactor.count > 0) warnings.push(`Redacted ${redactor.count} secret-looking value(s).`);

  const bytes = await writeCheckpoint(root, checkpoint);
  if ((await isIgnored(root, CHECKPOINT_FILENAME)) === false) {
    warnings.push(`${CHECKPOINT_FILENAME} is not git-ignored. Add "${CHECKPOINT_FILENAME}*" to .gitignore to avoid committing it.`);
  }

  const file = checkpointPath(root);
  const counts = {
    tasks: checkpoint.goal.tasks.length,
    modifiedFiles: checkpoint.modifiedFiles.length,
    recentCommands: checkpoint.recentCommands.length,
    redactions: redactor.count,
  };
  const text = [
    `Checkpoint saved to ${file} (${bytes} bytes, ${args.mode}).`,
    `${counts.tasks} task(s), ${counts.modifiedFiles} file(s), ${counts.recentCommands} command(s)${git ? ` on ${git.state.branch}@${git.state.head.slice(0, 9)}` : ""}.`,
    ...warnings.map((w) => `⚠ ${w}`),
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    structuredContent: { path: file, bytes, mode: args.mode, counts, warnings },
  };
}

async function load(
  format: "brief" | "full",
  projectRoot: string | undefined,
  clientRoot: () => Promise<string | undefined>,
): Promise<CallToolResult> {
  const root = await resolveRoot(projectRoot, clientRoot);
  const file = checkpointPath(root);
  const result = await readCheckpoint(root);

  if (result === null) {
    return {
      content: [{ type: "text", text: `No checkpoint found at ${file}. Nothing to resume; start fresh.` }],
      structuredContent: { found: false, path: file, warnings: [] },
    };
  }

  const { checkpoint, fromBackup, warnings } = result;
  let drift: Drift | null = null;
  if (checkpoint.git) {
    const savedHashes = new Map(
      checkpoint.modifiedFiles.filter((f) => f.hash !== undefined).map((f) => [f.path, f.hash!] as const),
    );
    drift = await computeDrift(root, checkpoint.git, savedHashes, isCheckpointFile);
  }

  const text = format === "full" ? JSON.stringify({ checkpoint, drift, warnings }, null, 2) : renderBrief(checkpoint, drift, warnings);

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      found: true,
      path: file,
      fromBackup,
      updatedAt: checkpoint.updatedAt,
      drift,
      warnings,
      // Some clients (Claude Code) show the model structuredContent instead of the text content,
      // so the brief has to be here too or the model never sees it.
      ...(format === "full" ? { checkpoint } : { brief: text }),
    },
  };
}

function mergeTasks(previous: Task[], incoming: Task[]): Task[] {
  const byDescription = new Map(previous.map((t) => [t.description, t]));
  for (const t of incoming) byDescription.set(t.description, t);
  return [...byDescription.values()];
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Agent-supplied paths may be absolute; store them relative to the root with forward slashes. */
function normalizePath(root: string, p: string): string {
  const rel = path.isAbsolute(p) ? path.relative(root, p) : path.normalize(p);
  return rel.startsWith("..") ? p : rel.split(path.sep).join("/");
}

/**
 * Agent-annotated files come first (they are what the model considered important),
 * then remaining git-detected changes, then — in merge mode — files from the previous
 * checkpoint that are no longer dirty (committed or reverted since).
 */
function buildFileList(
  root: string,
  gitChanges: ReadonlyArray<{ path: string; status: string; hash: string }>,
  agentFiles: ReadonlyArray<{ path: string; note?: string | undefined }>,
  previous: readonly ModifiedFile[],
  redactor: Redactor,
): ModifiedFile[] {
  const gitByPath = new Map(gitChanges.filter((c) => !isCheckpointFile(c.path)).map((c) => [c.path, c]));
  const result = new Map<string, ModifiedFile>();

  for (const f of agentFiles) {
    const rel = normalizePath(root, f.path);
    const g = gitByPath.get(rel);
    const note = f.note === undefined ? undefined : redactor.scrub(f.note);
    result.set(
      rel,
      g ? { path: rel, status: g.status, source: "git", note, hash: g.hash } : { path: rel, status: "M", source: "agent", note },
    );
  }
  for (const g of gitByPath.values()) {
    if (!result.has(g.path)) result.set(g.path, { path: g.path, status: g.status, source: "git", hash: g.hash });
  }
  for (const p of previous) {
    if (result.has(p.path)) {
      const current = result.get(p.path)!;
      if (current.note === undefined && p.note !== undefined) current.note = p.note;
      continue;
    }
    // No longer dirty: keep it as touched-this-session but drop the stale hash.
    result.set(p.path, { path: p.path, status: p.status, source: "agent", note: p.note });
  }

  return [...result.values()];
}
