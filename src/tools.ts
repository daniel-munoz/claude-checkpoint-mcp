import { randomUUID } from "node:crypto";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { drift as computeDrift, isIgnored, snapshot, type Drift, type GitSnapshot } from "./git.js";
import { listCheckpoints, renderListing, type Listing } from "./listing.js";
import { createRedactor, type Redactor } from "./redact.js";
import { renderBrief, shortSha } from "./render.js";
import {
  CHECKPOINT_FILENAME,
  CHECKPOINT_VERSION,
  GENERATOR,
  LIMITS,
  MAX_FILE_KB,
  type Checkpoint,
  type ModifiedFile,
  type RecentCommand,
  type Task,
} from "./schema.js";
import { LEGACY_SELECTOR, resolveCallSession, type CallSession } from "./session.js";
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
import { DEFAULT_LIST_LIMIT, listTool, loadTool, saveTool, type ListArgs, type LoadArgs, type SaveArgs } from "./toolSchemas.js";

/** Server-wide session settings. Each call resolves its own session from these and its `session` argument. */
export interface SessionConfig {
  /** CLAUDE_CODE_SESSION_ID, or null when the client doesn't provide one. */
  envId: string | null;
  /** CHECKPOINT_SESSION_IDS=mint: a save with no session id mints one instead of using the legacy file. */
  mint: boolean;
  /** Why a provided setting couldn't be used; surfaced in every tool result. */
  warning?: string;
}

const LOST_ID_HINT = "If you saved earlier in this conversation, pass the session id that save returned.";
// Also shown to an agent that already saved and lost track of its id (e.g. after compaction), so it must
// not claim the caller has no id: its id is its own checkpoint's selector (#47).
const NO_ID_NOTE =
  "No session id was passed. If you saved earlier in this conversation, pass that save's session id as session; " +
  "it is also the selector of your checkpoint in list_session_checkpoints. " +
  "Otherwise your first save will return one; pass it as session on every later checkpoint call.";

/** Upper bound on git-detected files hashed per save; beyond this, drift falls back to diff vs HEAD. */
const MAX_HASHED_CHANGES = 500;
const CLIENT_ROOTS_TIMEOUT_MS = 2000;
const CHECKPOINT_FILES = new Set([CHECKPOINT_FILENAME, CHECKPOINT_FILENAME + BACKUP_SUFFIX]);
const isCheckpointFile = (p: string) =>
  CHECKPOINT_FILES.has(p) || p.startsWith(`${CHECKPOINT_FILENAME}.tmp-`) || p.startsWith(`${SLOTS_DIRNAME}/`);

export function registerTools(server: McpServer, config: SessionConfig): void {
  // No per-process state links calls: a checkpoint being resumed is named on the save itself
  // (`resumedFrom`), so it survives a server restart between load and save (#18).

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

  server.registerTool("save_session_checkpoint", saveTool, (args) => serialized(() => save(args, config, clientRoot)));
  server.registerTool("load_session_checkpoint", loadTool, (args) => serialized(() => load(args, config, clientRoot)));
  server.registerTool("list_session_checkpoints", listTool, (args) => serialized(() => list(args, config, clientRoot)));
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

async function save(args: SaveArgs, config: SessionConfig, clientRoot: () => Promise<string | undefined>): Promise<CallToolResult> {
  let call = resolveCallSession(args.session, config.envId);
  if (call.id === null && config.mint) call = { id: randomUUID(), source: "minted" };
  const root = await resolveRoot(args.projectRoot, clientRoot);
  const warnings: string[] = config.warning ? [config.warning] : [];
  const target = await saveBase(root, call, args.resumedFrom, args.mode, warnings);
  const git = await snapshot(root, MAX_HASHED_CHANGES);

  const checkpoint = buildCheckpoint({ args, root, sessionId: call.id, target, git, redactor: createRedactor(), warnings });
  const bytes = await writeCheckpoint(target.file, checkpoint);
  await warnIfNotIgnored(root, target.file, call.id, warnings);
  return saveResult(target.file, bytes, args.mode, checkpoint, warnings, call);
}

interface CheckpointInput {
  args: SaveArgs;
  root: string;
  sessionId: string | null;
  target: SaveBase;
  git: GitSnapshot | null;
  redactor: Redactor;
  warnings: string[];
}

/** The checkpoint a save writes: the agent's input, redacted and merged onto the base, within the size limits. */
function buildCheckpoint(input: CheckpointInput): Checkpoint {
  const { args, root, sessionId, target, git, redactor, warnings } = input;
  const now = new Date().toISOString();
  const base = target.previous?.checkpoint;
  const content = mergeContent(input, base, now);
  const files = recordFiles(input, base);

  const checkpoint: Checkpoint = {
    ...identity(target, root, sessionId, now),
    git: git?.state ?? null,
    goal: { primary: redactor.scrub(args.goal), tasks: content.tasks },
    summary: content.summary,
    nextSteps: content.nextSteps,
    decisions: content.decisions,
    modifiedFiles: files.modifiedFiles,
    recentCommands: content.recentCommands,
    meta: { redactions: redactor.count, truncated: content.truncated || files.truncated },
  };
  if (fitToSize(checkpoint)) warnings.push(`Older commands or files were dropped to keep the checkpoint under ${MAX_FILE_KB} KB.`);
  if (redactor.count > 0) warnings.push(`Redacted ${redactor.count} secret-looking value(s).`);
  return checkpoint;
}

/** Version, ids and timestamps. Continuing the session's own checkpoint keeps its id and createdAt. */
function identity(
  target: SaveBase,
  root: string,
  sessionId: string | null,
  now: string,
): Pick<Checkpoint, "version" | "id" | "createdAt" | "updatedAt" | "generator" | "project" | "sessionId" | "resumedFrom"> {
  const own = target.continuing ? target.previous?.checkpoint : undefined;
  return {
    version: CHECKPOINT_VERSION,
    id: own?.id ?? randomUUID(),
    createdAt: own?.createdAt ?? now,
    updatedAt: now,
    generator: { ...GENERATOR },
    project: { name: path.basename(root) },
    ...(sessionId !== null ? { sessionId } : {}),
    ...(target.resumedFrom !== undefined ? { resumedFrom: target.resumedFrom } : {}),
  };
}

/**
 * Text and lists from the agent, merged onto the base: summary and next steps replace the base's
 * when given; tasks, decisions and commands accumulate, keeping the newest within their limits.
 */
function mergeContent({ args, redactor, warnings }: CheckpointInput, base: Checkpoint | undefined, now: string) {
  let truncated = false;
  const keepLast = <T>(items: T[], max: number, label: string): T[] => {
    if (items.length > max) {
      truncated = true;
      warnings.push(`Dropped the ${items.length - max} oldest ${label} to stay within the limit of ${max}.`);
    }
    return items.slice(-max);
  };

  const tasks = mergeTasks(base?.goal.tasks ?? [], (args.tasks ?? []).map((t) => ({ ...t, description: redactor.scrub(t.description) })));
  const decisions = dedupe([...(base?.decisions ?? []), ...(args.decisions ?? []).map(redactor.scrub)]);
  const commands = [...(base?.recentCommands ?? []), ...(args.recentCommands ?? []).map((c) => scrubCommand(c, redactor, now))];
  return {
    summary: args.summary !== undefined ? redactor.scrub(args.summary) : (base?.summary ?? ""),
    nextSteps: args.nextSteps !== undefined ? args.nextSteps.map(redactor.scrub) : (base?.nextSteps ?? []),
    tasks: keepLast(tasks, LIMITS.tasks, "tasks"),
    decisions: keepLast(decisions, LIMITS.decisions, "decisions"),
    recentCommands: keepLast(commands, LIMITS.recentCommands, "recent commands"),
    truncated,
  };
}

function scrubCommand(c: NonNullable<SaveArgs["recentCommands"]>[number], redactor: Redactor, now: string): RecentCommand {
  return {
    command: redactor.scrub(c.command),
    exitCode: c.exitCode,
    note: c.note === undefined ? undefined : redactor.scrub(c.note),
    at: now,
  };
}

function recordFiles(
  { root, git, args, redactor, warnings }: CheckpointInput,
  base: Checkpoint | undefined,
): { modifiedFiles: ModifiedFile[]; truncated: boolean } {
  const files = buildFileList(root, git?.changes ?? [], args.modifiedFiles ?? [], base?.modifiedFiles ?? [], redactor);
  const truncated = files.length > LIMITS.modifiedFiles;
  if (truncated) warnings.push(`Only the first ${LIMITS.modifiedFiles} of ${files.length} modified files were recorded.`);
  return { modifiedFiles: files.slice(0, LIMITS.modifiedFiles), truncated };
}

async function warnIfNotIgnored(root: string, file: string, sessionId: string | null, warnings: string[]): Promise<void> {
  if ((await isIgnored(root, path.relative(root, file).split(path.sep).join("/"))) !== false) return;
  const shown = sessionId !== null ? `${SLOTS_DIRNAME}/` : CHECKPOINT_FILENAME;
  warnings.push(`${shown} is not git-ignored. Add "${CHECKPOINT_FILENAME}*" to .gitignore to avoid committing it.`);
}

function saveResult(
  file: string,
  bytes: number,
  mode: SaveArgs["mode"],
  checkpoint: Checkpoint,
  warnings: string[],
  call: CallSession,
): CallToolResult {
  const counts = {
    tasks: checkpoint.goal.tasks.length,
    modifiedFiles: checkpoint.modifiedFiles.length,
    recentCommands: checkpoint.recentCommands.length,
    redactions: checkpoint.meta.redactions,
  };
  const at = checkpoint.git ? ` on ${checkpoint.git.branch}@${shortSha(checkpoint.git.head)}` : "";
  const text = [
    `Checkpoint saved to ${file} (${bytes} bytes, ${mode}).`,
    // The env var resends itself on every call; an id the agent passed or was just given must come back.
    ...(call.source === "argument" || call.source === "minted"
      ? [`Pass session: ${JSON.stringify(call.id)} on every later checkpoint call in this conversation.`]
      : []),
    `${counts.tasks} task(s), ${counts.modifiedFiles} file(s), ${counts.recentCommands} command(s)${at}.`,
    ...warnings.map((w) => `⚠ ${w}`),
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      path: file,
      bytes,
      mode,
      counts,
      warnings,
      ...(call.id !== null && call.source !== null ? { session: call.id, sessionSource: call.source } : {}),
    },
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
 * Until it exists, the checkpoint named by `resumedFrom` is the merge base and is recorded as resumedFrom.
 */
async function saveBase(
  root: string,
  call: CallSession,
  requested: string | undefined,
  mode: "replace" | "merge",
  warnings: string[],
): Promise<SaveBase> {
  const ownSelector = call.id ?? LEGACY_SELECTOR;
  const resumeSelector = requested === ownSelector ? undefined : requested;
  // Resolved first so a malformed selector fails the save before anything is read or written.
  const resumeFile = resumeSelector === undefined ? undefined : selectorPath(root, resumeSelector);

  const file = selectorPath(root, ownSelector);
  const own = await readOrWarn(file, ownSelector, warnings);
  const resumed = own === null && resumeFile !== undefined ? await readResumed(resumeFile, resumeSelector!, warnings) : null;
  const resumedFrom = own?.checkpoint.resumedFrom ?? (resumed ? resumeSelector : undefined);

  let previous: LoadResult | null = null;
  if (mode === "merge") {
    previous = own ?? resumed;
    if (previous === null) {
      warnings.push(
        "No existing checkpoint to merge into; saved a new one." +
          (call.source === "minted" ? ` ${LOST_ID_HINT}` : "") +
          (requested === undefined ? " If this session resumed another checkpoint, pass its selector as `resumedFrom`." : ""),
      );
    }
  }
  if (previous) warnings.push(...previous.warnings);
  // A checkpoint started from another one is a new checkpoint, not a continuation of that file.
  return { file, previous, resumedFrom, continuing: previous !== null && previous === own };
}

/** The checkpoint a save names as `resumedFrom`; null, with a warning, when it is missing or unreadable. */
async function readResumed(file: string, selector: string, warnings: string[]): Promise<LoadResult | null> {
  let result: LoadResult | null;
  try {
    result = await readCheckpoint(file);
  } catch (err) {
    warnings.push(`Checkpoint ${selector} could not be read and was not used: ${(err as Error).message}`);
    return null;
  }
  if (result === null) warnings.push(`resumedFrom checkpoint ${JSON.stringify(selector)} not found; saved without resuming from it.`);
  return result;
}

async function load(args: LoadArgs, config: SessionConfig, clientRoot: () => Promise<string | undefined>): Promise<CallToolResult> {
  const call = resolveCallSession(args.session, config.envId);
  const root = await resolveRoot(args.projectRoot, clientRoot);
  const ctx: LoadContext = {
    sessionWarnings: config.warning ? [config.warning] : [],
    session: call.id,
    note: noIdNote(call, config),
  };
  // With minting on, a caller without an id has no checkpoint of its own: the legacy file is one more to pick from.
  const own = call.id ?? (config.mint ? null : LEGACY_SELECTOR);

  if (args.checkpoint !== undefined) {
    const file = selectorPath(root, args.checkpoint);
    const result = await readCheckpoint(file);
    if (result === null) {
      throw new CheckpointError(`no checkpoint "${args.checkpoint}" in ${root}. Call list_session_checkpoints to see the available ones.`);
    }
    const resumeHint =
      args.checkpoint === own
        ? undefined
        : `To continue from this checkpoint, pass \`resumedFrom: ${JSON.stringify(args.checkpoint)}\` on your next save_session_checkpoint call.`;
    return loaded({ root, selector: args.checkpoint, file, result, format: args.format, resumeHint }, ctx);
  }

  // An unreadable own checkpoint shows up in the list below (marked unreadable) rather than failing the call.
  const file = own === null ? path.join(root, SLOTS_DIRNAME) : selectorPath(root, own);
  if (own !== null) {
    const result = await readCheckpoint(file).catch(() => null);
    if (result !== null) return loaded({ root, selector: own, file, result, format: args.format }, ctx);
  }

  const listing = await listCheckpoints(root, call.id, DEFAULT_LIST_LIMIT);
  if (listing.total === 0) {
    const text = withNote(`No checkpoint found at ${file}. Nothing to resume; start fresh.`, ctx.note);
    return {
      content: [{ type: "text", text }],
      structuredContent: { found: false, path: file, warnings: ctx.sessionWarnings, ...sessionField(ctx) },
    };
  }
  return candidates(root, file, listing, ctx);
}

/** What every load result carries besides the checkpoint or list: the caller's id, its note and warnings. */
interface LoadContext {
  sessionWarnings: string[];
  session: string | null;
  /** Set for a caller with no id while minting is on: how it gets one. */
  note: string | undefined;
}

function noIdNote(call: CallSession, config: SessionConfig): string | undefined {
  return call.id === null && config.mint ? NO_ID_NOTE : undefined;
}

function withNote(text: string, note: string | undefined): string {
  return note === undefined ? text : `${text}\n\n${note}`;
}

const sessionField = (ctx: LoadContext) => (ctx.session === null ? {} : { session: ctx.session });

/** The "pick one" result: this session has no checkpoint, but others exist in the project. */
function candidates(root: string, file: string, listing: Listing, ctx: LoadContext): CallToolResult {
  const warnings = [...ctx.sessionWarnings, ...listing.warnings];
  const text = withNote(
    [
      (ctx.session === null
        ? `No session id was passed, so no checkpoint was loaded. ${listing.total} checkpoint(s) exist in ${root}. `
        : `This session has no checkpoint in ${root}, but ${listing.total} other checkpoint(s) exist. `) +
        "Show this list to the user and ask which one to resume (or whether to start fresh); then call " +
        "load_session_checkpoint with `checkpoint` set to the chosen selector. Do not choose one yourself.",
      "",
      renderListing(listing),
      ...warnings.map((w) => `⚠ ${w}`),
    ].join("\n"),
    ctx.note,
  );
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      found: false,
      path: file,
      candidates: listing.entries,
      total: listing.total,
      omitted: listing.omitted,
      warnings,
      ...sessionField(ctx),
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
  /** Set when the session loaded a checkpoint other than its own: what to pass on its next save. */
  resumeHint?: string | undefined;
}

async function loaded({ root, selector, file, result, format, resumeHint }: Loaded, ctx: LoadContext): Promise<CallToolResult> {
  const { checkpoint, fromBackup } = result;
  const warnings = [...ctx.sessionWarnings, ...result.warnings];
  let drift: Drift | null = null;
  if (checkpoint.git) {
    const savedHashes = new Map(
      checkpoint.modifiedFiles.filter((f) => f.hash !== undefined).map((f) => [f.path, f.hash!] as const),
    );
    drift = await computeDrift(root, checkpoint.git, savedHashes, isCheckpointFile);
  }

  const hint = resumeHint === undefined ? {} : { resumeHint };
  const text =
    format === "full"
      ? JSON.stringify({ checkpoint, drift, warnings, ...hint }, null, 2)
      : withNote([...(resumeHint === undefined ? [] : [`> ${resumeHint}`, ""]), renderBrief(checkpoint, drift, warnings)].join("\n"), ctx.note);

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
      ...hint,
      ...sessionField(ctx),
      // Some clients (Claude Code) show the model structuredContent instead of the text content,
      // so the brief has to be here too or the model never sees it.
      ...(format === "full" ? { checkpoint } : { brief: text }),
    },
  };
}

async function list(args: ListArgs, config: SessionConfig, clientRoot: () => Promise<string | undefined>): Promise<CallToolResult> {
  const call = resolveCallSession(args.session, config.envId);
  const root = await resolveRoot(args.projectRoot, clientRoot);
  const listing = await listCheckpoints(root, call.id, args.limit);
  const warnings = [...(config.warning ? [config.warning] : []), ...listing.warnings];
  const text = withNote(
    listing.total === 0
      ? `No checkpoints in ${root}.`
      : [`${listing.total} checkpoint(s) in ${root}, newest first:`, "", renderListing(listing), ...warnings.map((w) => `⚠ ${w}`)].join("\n"),
    noIdNote(call, config),
  );
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
