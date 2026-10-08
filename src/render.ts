import type { Drift } from "./git.js";
import type { Checkpoint, Task } from "./schema.js";

const BRIEF_MAX_FILES = 40;
const BRIEF_MAX_COMMANDS = 10;

const TASK_MARK: Record<Task["status"], string> = {
  done: "[x]",
  in_progress: "[~]",
  pending: "[ ]",
  blocked: "[!]",
};

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
  const out: string[] = [];
  const stamp = cp.updatedAt.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC");
  out.push(`# Resuming: ${cp.project.name} (checkpoint saved ${formatAge(cp.updatedAt, now)}, ${stamp})`);
  if (cp.git) out.push(`Branch \`${cp.git.branch}\` @ ${cp.git.head.slice(0, 9)}${cp.git.dirty ? " (uncommitted changes)" : ""}`);
  for (const w of warnings) out.push(`> ⚠ ${w}`);

  out.push("", "## Goal", cp.goal.primary);

  if (cp.goal.tasks.length > 0) {
    out.push("", "## Tasks");
    for (const t of cp.goal.tasks) out.push(`- ${TASK_MARK[t.status]} ${t.description}`);
  }

  if (cp.summary) out.push("", "## Where things stand", cp.summary);

  if (cp.nextSteps.length > 0) {
    out.push("", "## Next steps");
    cp.nextSteps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  }

  if (cp.decisions.length > 0) {
    out.push("", "## Decisions & gotchas");
    for (const d of cp.decisions) out.push(`- ${d}`);
  }

  if (cp.modifiedFiles.length > 0) {
    out.push("", `## Files touched (${cp.modifiedFiles.length})`);
    for (const f of cp.modifiedFiles.slice(0, BRIEF_MAX_FILES)) {
      out.push(`- ${f.path} (${f.status})${f.note ? ` — ${f.note}` : ""}`);
    }
    const more = cp.modifiedFiles.length - BRIEF_MAX_FILES;
    if (more > 0) out.push(`- …and ${more} more (load with format "full")`);
  }

  if (cp.recentCommands.length > 0) {
    const shown = cp.recentCommands.slice(-BRIEF_MAX_COMMANDS);
    out.push("", `## Recent commands (last ${shown.length}, oldest first)`);
    for (const c of shown) {
      const mark = c.exitCode === undefined ? "•" : c.exitCode === 0 ? "✓" : `✗ exit ${c.exitCode}`;
      out.push(`- ${mark} \`${c.command}\`${c.note ? ` — ${c.note}` : ""}`);
    }
  }

  const since = renderDrift(cp, drift);
  if (since.length > 0) out.push("", "## Since this checkpoint", ...since);

  return out.join("\n");
}

export function renderDrift(cp: Checkpoint, drift: Drift | null): string[] {
  if (!cp.git) return [];
  if (!drift) return ["- Project is no longer a git repository; cannot check for changes."];

  const lines: string[] = [];
  if (drift.branchChanged) lines.push(`- ⚠ Branch changed: \`${cp.git.branch}\` → \`${drift.currentBranch}\``);
  if (drift.commitsSince === null) lines.push(`- ⚠ Saved commit ${cp.git.head.slice(0, 9)} is no longer reachable (rebased or reset?)`);
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
