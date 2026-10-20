import { z } from "zod";
import { LIMITS, Task } from "./schema.js";

export const DEFAULT_LIST_LIMIT = 10;

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

export type SaveArgs = z.infer<z.ZodObject<typeof saveInput>>;
export type LoadArgs = z.infer<z.ZodObject<typeof loadInput>>;
export type ListArgs = z.infer<z.ZodObject<typeof listInput>>;

export const saveTool = {
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
};

export const loadTool = {
  title: "Load session checkpoint",
  description:
    "Load this session's checkpoint and return a compact brief of its goal, progress, next steps, " +
    "touched files and recent commands, plus which files changed since it was saved. Call at the start of a session " +
    "or when the user asks to resume. If this session has no checkpoint but others exist in the project, it returns " +
    "a list instead: show it to the user, ask which one to resume, and call again with `checkpoint` set to its selector.",
  inputSchema: loadInput,
  outputSchema: loadOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export const listTool = {
  title: "List session checkpoints",
  description:
    "List the checkpoints saved in the project (one per Claude Code session, plus a legacy .claude-checkpoint if present), " +
    "newest first, with each one's goal, last-saved time, branch and whether all its tasks are done. " +
    "Use it when the user wants to resume a different or older session; load one with load_session_checkpoint's `checkpoint`.",
  inputSchema: listInput,
  outputSchema: listOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
