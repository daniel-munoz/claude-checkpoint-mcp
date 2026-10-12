import { createRequire } from "node:module";
import { z } from "zod";
// Resolves from both src/ (tests) and dist/ (runtime): package.json is one level up.
const pkg = createRequire(import.meta.url)("../package.json");
export const GENERATOR = { name: pkg.name, version: pkg.version };
export const CHECKPOINT_VERSION = 1;
export const CHECKPOINT_FILENAME = ".claude-checkpoint";
export const MAX_FILE_BYTES = 64 * 1024;
export const LIMITS = {
    goal: 500,
    summary: 4000,
    item: 500,
    path: 1024,
    command: 2000,
    tasks: 30,
    nextSteps: 20,
    decisions: 20,
    modifiedFiles: 100,
    recentCommands: 50,
};
export const TaskStatus = z.enum(["pending", "in_progress", "done", "blocked"]);
export const Task = z.object({
    description: z.string().min(1).max(LIMITS.item),
    status: TaskStatus,
});
export const ModifiedFile = z.object({
    path: z.string().min(1).max(LIMITS.path),
    // Two-letter git porcelain code (e.g. "M ", "??") trimmed, or "M" for agent-reported files.
    status: z.string().max(2),
    source: z.enum(["git", "agent"]),
    note: z.string().max(LIMITS.item).optional(),
    // Working-tree blob hash at save time (git-detected files only); drives drift detection on load.
    hash: z.string().max(64).optional(),
});
export const RecentCommand = z.object({
    command: z.string().min(1).max(LIMITS.command),
    exitCode: z.number().int().optional(),
    note: z.string().max(LIMITS.item).optional(),
    at: z.string().datetime(),
});
export const GitState = z.object({
    branch: z.string(),
    head: z.string(),
    dirty: z.boolean(),
});
export const Checkpoint = z.object({
    version: z.literal(CHECKPOINT_VERSION),
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    generator: z.object({ name: z.string(), version: z.string() }),
    project: z.object({ name: z.string() }),
    git: GitState.nullable(),
    goal: z.object({
        primary: z.string().min(1).max(LIMITS.goal),
        tasks: z.array(Task).max(LIMITS.tasks),
    }),
    summary: z.string().max(LIMITS.summary),
    nextSteps: z.array(z.string().max(LIMITS.item)).max(LIMITS.nextSteps),
    decisions: z.array(z.string().max(LIMITS.item)).max(LIMITS.decisions),
    modifiedFiles: z.array(ModifiedFile).max(LIMITS.modifiedFiles),
    recentCommands: z.array(RecentCommand).max(LIMITS.recentCommands),
    meta: z.object({
        redactions: z.number().int().nonnegative(),
        truncated: z.boolean(),
    }),
});
/**
 * Upgrades an older on-disk checkpoint to the current shape. Only v1 exists today,
 * so this just rejects unknown versions; future versions add a case per step.
 */
export function migrate(raw) {
    if (typeof raw !== "object" || raw === null) {
        throw new Error("checkpoint is not a JSON object");
    }
    const version = raw.version;
    if (version === CHECKPOINT_VERSION)
        return raw;
    throw new Error(`unsupported checkpoint version: ${String(version)}`);
}
export function parseCheckpoint(raw) {
    return Checkpoint.parse(migrate(raw));
}
//# sourceMappingURL=schema.js.map