import { randomUUID } from "node:crypto";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { drift as computeDrift, isIgnored, snapshot, type Drift } from "./git.js";
import { listCheckpoints, renderListing, type Listing } from "./listing.js";
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
import { LEGACY_SELECTOR } from "./session.js";
import {
  BACKUP_SUFFIX,
  CheckpointError,
  fitToSize,
  readCheckpoint,
  resolveRoot,
  rootUriToPath,
  selectorPath,
  SLOTS_DIRNAME,
  writeCheckpoint,
  type LoadResult,
} from "./store.js";

/** The Claude Code session this server was started for; id is null when the client doesn't provide one. */
export interface Session {
  id: string | null;
  warning?: string;
}

/** Upper bound on git-detected files hashed per save; beyond this, drift falls back to diff vs HEAD. */
const MAX_HASHED_CHANGES = 500;
const CLIENT_ROOTS_TIMEOUT_MS = 2000;
const DEFAULT_LIST_LIMIT = 10;

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
  checkpoint: z
    .string()
    .optional()
    .describe("Which checkpoint to load, as a selector from list_session_checkpoints: a session id, or 'legacy'. Omit to load this session's own checkpoint."),
  projectRoot: projectRootArg,
};

const listEntryOutput = z.object({
  selector: z.string(),
  goal: z.string().nullable(),
  updatedAt: z.string().nullable(),
  age: z.string().nullable(),
  branch: z.string().nullable(),
  allTasksDone: z.boolean(),
  isCurrentSession: z.boolean(),
  fromBackup: z.boolean(),
  resumedFrom: z.string().optional(),
  unreadable: z.string().optional(),
});

const listInput = {
  limit: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_LIST_LIMIT)
    .describe("Maximum number of checkpoints to return, newest first. 0 returns all of them."),
  projectRoot: projectRootArg,
};

const listOutput = {
  path: z.string(),
  entries: z.array(listEntryOutput),
  total: z.number(),
  omitted: z.number(),
  warnings: z.array(z.string()),
  text: z.string(),
};

const loadOutput = {
  found: z.boolean(),
  path: z.string(),
  selector: z.string().optional(),
  candidates: z.array(listEntryOutput).optional(),
  total: z.number().optional(),
  omitted: z.number().optional(),
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
  text: z.string().optional(),
  checkpoint: z.record(z.unknown()).optional(),
};

type SaveArgs = z.infer<z.ZodObject<typeof saveInput>>;
type LoadArgs = z.infer<z.ZodObject<typeof loadInput>>;
type ListArgs = z.infer<z.ZodObject<typeof listInput>>;

const CHECKPOINT_FILES = new Set([CHECKPOINT_FILENAME, CHECKPOINT_FILENAME + BACKUP_SUFFIX]);
const isCheckpointFile = (p: string) =>
  CHECKPOINT_FILES.has(p) || p.startsWith(`${CHECKPOINT_FILENAME}.tmp-`) || p.startsWith(`${SLOTS_DIRNAME}/`);

export function registerTools(server: McpServer, session: Session): void {
  // Per project root: the checkpoint this session chose to resume from (by explicit selector),
  // used as the merge base until the session's own checkpoint exists.
  const adopted = new Map<string, string>();

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
        "Save the current session's goal, progress, touched files and recent commands to this session's checkpoint in the project " +
        "(.claude-checkpoints/<session-id>.json, or .claude-checkpoint when the client provides no session id), " +
        "so a new session can resume after a crash, /clear, or context limit without re-exploring. " +
        "Call after finishing a milestone, before risky operations, and when the conversation is getting long. " +
        "Git branch, HEAD and uncommitted files are captured automatically.",
      inputSchema: saveInput,
      outputSchema: saveOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => serialized(() => save(args, session, adopted, clientRoot)),
  );

  server.registerTool(
    "load_session_checkpoint",
    {
      title: "Load session checkpoint",
      description:
        "Load this session's checkpoint and return a compact brief of its goal, progress, next steps, " +
        "touched files and recent commands, plus which files changed since it was saved. Call at the start of a session " +
        "or when the user asks to resume. If this session has no checkpoint but others exist in the project, it returns " +
        "a list instead: show it to the user, ask which one to resume, and call again with `checkpoint` set to its selector.",
      inputSchema: loadInput,
      outputSchema: loadOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => serialized(() => load(args, session, adopted, clientRoot)),
  );

  server.registerTool(
    "list_session_checkpoints",
    {
      title: "List session checkpoints",
      description:
        "List the checkpoints saved in the project (one per Claude Code session, plus a legacy .claude-checkpoint if present), " +
        "newest first, with each one's goal, last-saved time, branch and whether all its tasks are done. " +
        "Use it when the user wants to resume a different or older session; load one with load_session_checkpoint's `checkpoint`.",
      inputSchema: listInput,
      outputSchema: listOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => serialized(() => list(args, session, clientRoot)),
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

async function save(
  args: SaveArgs,
  session: Session,
  adopted: Map<string, string>,
  clientRoot: () => Promise<string | undefined>,
): Promise<CallToolResult> {
  const root = await resolveRoot(args.projectRoot, clientRoot);
  const now = new Date().toISOString();
  const redactor = createRedactor();
  const warnings: string[] = session.warning ? [session.warning] : [];

  const { file, previous, resumedFrom, continuing } = await saveBase(root, session, adopted.get(root), args.mode, warnings);
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
    id: continuing ? base!.id : randomUUID(),
    createdAt: continuing ? base!.createdAt : now,
    updatedAt: now,
    generator: { ...GENERATOR },
    project: { name: path.basename(root) },
    ...(session.id !== null ? { sessionId: session.id } : {}),
    ...(resumedFrom !== undefined ? { resumedFrom } : {}),
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

  const bytes = await writeCheckpoint(file, checkpoint);
  const shown = session.id !== null ? `${SLOTS_DIRNAME}/` : CHECKPOINT_FILENAME;
  if ((await isIgnored(root, path.relative(root, file).split(path.sep).join("/"))) === false) {
    warnings.push(`${shown} is not git-ignored. Add "${CHECKPOINT_FILENAME}*" to .gitignore to avoid committing it.`);
  }
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

/** Reads a checkpoint, reporting one that exists but can't be read instead of failing the call. */
async function readOrWarn(file: string, selector: string, warnings: string[]): Promise<LoadResult | null> {
  try {
    return await readCheckpoint(file);
  } catch (err) {
    warnings.push(`Checkpoint ${selector} could not be read and was not used: ${(err as Error).message}`);
    return null;
  }
}

interface SaveBase {
  /** The session's own checkpoint file, which the save writes. */
  file: string;
  /** What a merge save builds on, if anything. */
  previous: LoadResult | null;
  resumedFrom: string | undefined;
  /** True when updating the session's own checkpoint (keeps its id and createdAt). */
  continuing: boolean;
}

/**
 * Sessions only ever write their own checkpoint (the legacy file when there's no session id).
 * Until it exists, a checkpoint the session resumed from is the merge base and is recorded as resumedFrom.
 */
async function saveBase(
  root: string,
  session: Session,
  adoptedSelector: string | undefined,
  mode: "replace" | "merge",
  warnings: string[],
): Promise<SaveBase> {
  const file = selectorPath(root, session.id ?? LEGACY_SELECTOR);
  const own = await readOrWarn(file, session.id ?? LEGACY_SELECTOR, warnings);
  const fromAdopted = own === null ? adoptedSelector : undefined;
  const resumedFrom = own?.checkpoint.resumedFrom ?? fromAdopted;

  let previous: LoadResult | null = null;
  if (mode === "merge") {
    previous = own ?? (fromAdopted === undefined ? null : await readOrWarn(selectorPath(root, fromAdopted), fromAdopted, warnings));
    if (previous === null) warnings.push("No existing checkpoint to merge into; saved a new one.");
  }
  if (previous) warnings.push(...previous.warnings);
  // A checkpoint started from another one is a new checkpoint, not a continuation of that file.
  return { file, previous, resumedFrom, continuing: previous !== null && previous === own };
}

async function load(
  args: LoadArgs,
  session: Session,
  adopted: Map<string, string>,
  clientRoot: () => Promise<string | undefined>,
): Promise<CallToolResult> {
  const root = await resolveRoot(args.projectRoot, clientRoot);
  const sessionWarnings = session.warning ? [session.warning] : [];
  const own = session.id ?? LEGACY_SELECTOR;

  if (args.checkpoint !== undefined) {
    const file = selectorPath(root, args.checkpoint);
    const result = await readCheckpoint(file);
    if (result === null) {
      throw new CheckpointError(`no checkpoint "${args.checkpoint}" in ${root}. Call list_session_checkpoints to see the available ones.`);
    }
    if (args.checkpoint !== own) adopted.set(root, args.checkpoint);
    return loaded({ root, selector: args.checkpoint, file, result, format: args.format, sessionWarnings });
  }

  // An unreadable own checkpoint shows up in the list below (marked unreadable) rather than failing the call.
  const file = selectorPath(root, own);
  const result = await readCheckpoint(file).catch(() => null);
  if (result !== null) return loaded({ root, selector: own, file, result, format: args.format, sessionWarnings });

  const listing = await listCheckpoints(root, session.id, DEFAULT_LIST_LIMIT);
  if (listing.total === 0) {
    return {
      content: [{ type: "text", text: `No checkpoint found at ${file}. Nothing to resume; start fresh.` }],
      structuredContent: { found: false, path: file, warnings: sessionWarnings },
    };
  }
  return candidates(root, file, listing, sessionWarnings);
}

/** The "pick one" result: this session has no checkpoint, but others exist in the project. */
function candidates(root: string, file: string, listing: Listing, sessionWarnings: string[]): CallToolResult {
  const warnings = [...sessionWarnings, ...listing.warnings];
  const text = [
    `This session has no checkpoint in ${root}, but ${listing.total} other checkpoint(s) exist. ` +
      "Show this list to the user and ask which one to resume (or whether to start fresh); then call " +
      "load_session_checkpoint with `checkpoint` set to the chosen selector. Do not choose one yourself.",
    "",
    renderListing(listing),
    ...warnings.map((w) => `⚠ ${w}`),
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      found: false,
      path: file,
      candidates: listing.entries,
      total: listing.total,
      omitted: listing.omitted,
      warnings,
      // As with the brief, clients may show the model only structuredContent, so the instructions go here too.
      text,
    },
  };
}

interface Loaded {
  root: string;
  selector: string;
  file: string;
  result: LoadResult;
  format: "brief" | "full";
  sessionWarnings: string[];
}

async function loaded({ root, selector, file, result, format, sessionWarnings }: Loaded): Promise<CallToolResult> {
  const { checkpoint, fromBackup } = result;
  const warnings = [...sessionWarnings, ...result.warnings];
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
      selector,
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

async function list(args: ListArgs, session: Session, clientRoot: () => Promise<string | undefined>): Promise<CallToolResult> {
  const root = await resolveRoot(args.projectRoot, clientRoot);
  const listing = await listCheckpoints(root, session.id, args.limit);
  const warnings = [...(session.warning ? [session.warning] : []), ...listing.warnings];
  const text =
    listing.total === 0
      ? `No checkpoints in ${root}.`
      : [`${listing.total} checkpoint(s) in ${root}, newest first:`, "", renderListing(listing), ...warnings.map((w) => `⚠ ${w}`)].join("\n");
  return {
    content: [{ type: "text", text }],
    structuredContent: { path: root, entries: listing.entries, total: listing.total, omitted: listing.omitted, warnings, text },
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
