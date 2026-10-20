import { readdir } from "node:fs/promises";
import path from "node:path";
import { formatAge } from "./render.js";
import type { Checkpoint } from "./schema.js";
import { LEGACY_SELECTOR, SESSION_ID_PATTERN } from "./session.js";
import { BACKUP_SUFFIX, readCheckpoint, selectorPath, SLOTS_DIRNAME } from "./store.js";

export interface ListEntry {
  selector: string;
  /** null when neither the file nor its backup could be read. */
  goal: string | null;
  updatedAt: string | null;
  age: string | null;
  branch: string | null;
  /** True only when the checkpoint has tasks and all of them are done. */
  allTasksDone: boolean;
  isCurrentSession: boolean;
  fromBackup: boolean;
  resumedFrom?: string;
  unreadable?: string;
}

export interface Listing {
  entries: ListEntry[];
  total: number;
  omitted: number;
  warnings: string[];
}

const SLOT_EXT = ".json";
const SLOT_BACKUP_EXT = SLOT_EXT + BACKUP_SUFFIX;

/** Session ids that have a slot file or a slot backup under `.claude-checkpoints/`. */
async function slotSelectors(root: string, warnings: string[]): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(root, SLOTS_DIRNAME));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    if (code === "ENOTDIR") {
      warnings.push(`${SLOTS_DIRNAME} is not a directory, so no session checkpoints could be listed.`);
      return [];
    }
    throw err;
  }
  const ids = new Set<string>();
  for (const name of names) {
    const ext = [SLOT_EXT, SLOT_BACKUP_EXT].find((e) => name.endsWith(e));
    const stem = ext === undefined ? null : name.slice(0, -ext.length);
    if (stem !== null && SESSION_ID_PATTERN.test(stem) && stem !== LEGACY_SELECTOR) ids.add(stem);
  }
  return [...ids];
}

function entryFor(selector: string, checkpoint: Checkpoint, fromBackup: boolean, currentSessionId: string | null, now: Date): ListEntry {
  const tasks = checkpoint.goal.tasks;
  return {
    selector,
    goal: checkpoint.goal.primary,
    updatedAt: checkpoint.updatedAt,
    age: formatAge(checkpoint.updatedAt, now),
    branch: checkpoint.git?.branch ?? null,
    allTasksDone: tasks.length > 0 && tasks.every((t) => t.status === "done"),
    isCurrentSession: selector === currentSessionId,
    fromBackup,
    ...(checkpoint.resumedFrom !== undefined ? { resumedFrom: checkpoint.resumedFrom } : {}),
  };
}

/**
 * Lists the legacy checkpoint and every session slot under the root, newest first, with
 * unreadable ones last. `limit` 0 returns everything.
 */
export async function listCheckpoints(
  root: string,
  currentSessionId: string | null,
  limit: number,
  now: Date = new Date(),
): Promise<Listing> {
  const warnings: string[] = [];
  const selectors = [LEGACY_SELECTOR, ...(await slotSelectors(root, warnings))];
  const entries: ListEntry[] = [];

  for (const selector of selectors) {
    try {
      const result = await readCheckpoint(selectorPath(root, selector));
      if (result) entries.push(entryFor(selector, result.checkpoint, result.fromBackup, currentSessionId, now));
    } catch (err) {
      const reason = (err as Error).message;
      warnings.push(`Checkpoint ${selector} could not be read: ${reason}`);
      entries.push({
        selector,
        goal: null,
        updatedAt: null,
        age: null,
        branch: null,
        allTasksDone: false,
        isCurrentSession: selector === currentSessionId,
        fromBackup: false,
        unreadable: reason,
      });
    }
  }

  entries.sort((a, b) => sortTime(b.updatedAt) - sortTime(a.updatedAt));
  const shown = limit > 0 ? entries.slice(0, limit) : entries;
  return { entries: shown, total: entries.length, omitted: entries.length - shown.length, warnings };
}

/** Milliseconds for sorting; missing or unparseable timestamps sort as oldest. */
function sortTime(iso: string | null): number {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** One line per checkpoint, for the model to show the user when asking which one to resume. */
export function renderListing(listing: Listing): string {
  const lines = listing.entries.map((e) => {
    if (e.unreadable) return `- \`${e.selector}\` — unreadable (${e.unreadable})`;
    const parts = [
      `\`${e.selector}\``,
      e.age,
      e.branch ? `branch \`${e.branch}\`` : null,
      e.allTasksDone ? "all tasks done" : null,
      e.isCurrentSession ? "this session" : null,
      e.resumedFrom !== undefined ? `resumed from \`${e.resumedFrom}\`` : null,
      e.fromBackup ? "from backup" : null,
    ].filter((p) => p !== null);
    return `- ${parts.join(" · ")} — ${(e.goal ?? "").replace(/\s+/g, " ").trim()}`;
  });
  if (listing.omitted > 0) lines.push(`- …and ${listing.omitted} older (call list_session_checkpoints with limit 0)`);
  return lines.join("\n");
}
