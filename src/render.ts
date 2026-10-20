import type { Drift } from "./git.js";
import type { Checkpoint, ModifiedFile, RecentCommand, Task } from "./schema.js";

const BRIEF_MAX_FILES = 40;
const BRIEF_MAX_COMMANDS = 10;
const SHORT_SHA_LENGTH = 9;

const TASK_MARK: Record<Task["status"], string> = {
  done: "[x]",
  in_progress: "[~]",
  pending: "[ ]",
  blocked: "[!]",
};

export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

export function formatAge(fromIso: string, now: Date = new Date()): string {
  const secs = Math.max(0, Math.round((now.getTime() - Date.parse(fromIso)) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Renders a token-lean markdown brief: everything a fresh session needs to pick up
 * the work, with drift telling it which files must be re-read before editing.
 */
export function renderBrief(
  cp: Checkpoint,
  drift: Drift | null,
  warnings: readonly string[],
  now: Date = new Date(),
): string {
  return [
    ...renderHeader(cp, warnings, now),
    ...section("Goal", [cp.goal.primary]),
    ...section("Tasks", cp.goal.tasks.map((t) => `- ${TASK_MARK[t.status]} ${t.description}`)),
    ...section("Where things stand", cp.summary ? [cp.summary] : []),
    ...section("Next steps", cp.nextSteps.map((s, i) => `${i + 1}. ${s}`)),
    ...section("Decisions & gotchas", cp.decisions.map((d) => `- ${d}`)),
    ...renderFiles(cp.modifiedFiles),
    ...renderCommands(cp.recentCommands),
    ...section("Since this checkpoint", renderDrift(cp, drift)),
  ].join("\n");
}

/** A `## title` section preceded by a blank line, or nothing when it has no lines. */
function section(title: string, lines: string[]): string[] {
  return lines.length > 0 ? ["", `## ${title}`, ...lines] : [];
}

function renderHeader(cp: Checkpoint, warnings: readonly string[], now: Date): string[] {
  const stamp = cp.updatedAt.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC");
  const lines = [`# Resuming: ${cp.project.name} (checkpoint saved ${formatAge(cp.updatedAt, now)}, ${stamp})`];
  if (cp.git) lines.push(`Branch \`${cp.git.branch}\` @ ${shortSha(cp.git.head)}${cp.git.dirty ? " (uncommitted changes)" : ""}`);
  return [...lines, ...warnings.map((w) => `> ⚠ ${w}`)];
}

function renderFiles(files: readonly ModifiedFile[]): string[] {
  const lines = files.slice(0, BRIEF_MAX_FILES).map((f) => `- ${f.path} (${f.status})${f.note ? ` — ${f.note}` : ""}`);
  const more = files.length - BRIEF_MAX_FILES;
  if (more > 0) lines.push(`- …and ${more} more (load with format "full")`);
  return section(`Files touched (${files.length})`, lines);
}

function renderCommands(commands: readonly RecentCommand[]): string[] {
  const shown = commands.slice(-BRIEF_MAX_COMMANDS);
  return section(`Recent commands (last ${shown.length}, oldest first)`, shown.map(renderCommand));
}

function renderCommand(c: RecentCommand): string {
  const mark = c.exitCode === undefined ? "•" : c.exitCode === 0 ? "✓" : `✗ exit ${c.exitCode}`;
  return `- ${mark} \`${c.command}\`${c.note ? ` — ${c.note}` : ""}`;
}

export function renderDrift(cp: Checkpoint, drift: Drift | null): string[] {
  if (!cp.git) return [];
  if (!drift) return ["- Project is no longer a git repository; cannot check for changes."];

  const lines: string[] = [];
  if (drift.branchChanged) lines.push(`- ⚠ Branch changed: \`${cp.git.branch}\` → \`${drift.currentBranch}\``);
  if (drift.commitsSince === null) lines.push(`- ⚠ Saved commit ${shortSha(cp.git.head)} is no longer reachable (rebased or reset?)`);
  else if (drift.commitsSince > 0) lines.push(`- ${drift.commitsSince} new commit(s) on HEAD`);

  if (drift.changedSince.length > 0) {
    const shown = drift.changedSince.slice(0, BRIEF_MAX_FILES).map((p) => `\`${p}\``);
    const more = drift.changedSince.length - shown.length;
    lines.push(`- ⚠ Changed after the checkpoint, re-read before editing: ${shown.join(", ")}${more > 0 ? ` …and ${more} more` : ""}`);
  } else {
    lines.push("- No files changed since the checkpoint; the file list above is current.");
  }
  return lines;
}
