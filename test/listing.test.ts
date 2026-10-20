import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listCheckpoints, renderListing } from "../src/listing.js";
import type { Checkpoint } from "../src/schema.js";
import { backupPath, checkpointPath, selectorPath, serialize } from "../src/store.js";
import { makeCheckpoint, tempDir } from "./helpers.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");

function put(file: string, overrides: Partial<Checkpoint>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serialize(makeCheckpoint(overrides)));
}

const at = (hour: number) => `2026-10-20T${String(hour).padStart(2, "0")}:00:00.000Z`;

describe("listCheckpoints", () => {
  it("lists legacy and slot checkpoints newest first and marks the current session", async () => {
    const root = tempDir();
    put(checkpointPath(root), { updatedAt: at(9), goal: { primary: "old work", tasks: [] } });
    put(selectorPath(root, "s1"), { updatedAt: at(11), goal: { primary: "mine", tasks: [] } });
    put(selectorPath(root, "s2"), { updatedAt: at(10), goal: { primary: "theirs", tasks: [] } });

    const listing = await listCheckpoints(root, "s1", 10, NOW);
    expect(listing.entries.map((e) => e.selector)).toEqual(["s1", "s2", "legacy"]);
    expect(listing.entries.map((e) => e.isCurrentSession)).toEqual([true, false, false]);
    expect(listing.entries[0]).toMatchObject({ goal: "mine", updatedAt: at(11), age: "1h ago", fromBackup: false });
    expect(listing).toMatchObject({ total: 3, omitted: 0, warnings: [] });
  });

  it("reports allTasksDone only when there are tasks and all are done", async () => {
    const root = tempDir();
    put(selectorPath(root, "none"), { updatedAt: at(1) });
    put(selectorPath(root, "pending"), { updatedAt: at(2), goal: { primary: "g", tasks: [{ description: "a", status: "pending" }] } });
    put(selectorPath(root, "done"), {
      updatedAt: at(3),
      goal: { primary: "g", tasks: [{ description: "a", status: "done" }, { description: "b", status: "done" }] },
    });
    const byId = Object.fromEntries((await listCheckpoints(root, null, 0, NOW)).entries.map((e) => [e.selector, e.allTasksDone]));
    expect(byId).toEqual({ none: false, pending: false, done: true });
  });

  it("applies the limit and reports how many were omitted", async () => {
    const root = tempDir();
    for (let i = 0; i < 12; i++) put(selectorPath(root, `s${i}`), { updatedAt: at(i) });
    const limited = await listCheckpoints(root, null, 10, NOW);
    expect(limited.entries).toHaveLength(10);
    expect(limited.entries[0]?.selector).toBe("s11");
    expect(limited).toMatchObject({ total: 12, omitted: 2 });
    expect((await listCheckpoints(root, null, 0, NOW)).entries).toHaveLength(12);
  });

  it("ignores backups, temp files and non-checkpoint files as separate entries", async () => {
    const root = tempDir();
    const dir = path.join(root, ".claude-checkpoints");
    put(backupPath(selectorPath(root, "s1")), { updatedAt: at(1) });
    put(path.join(dir, "s2.json.tmp-1-ab"), {});
    writeFileSync(path.join(dir, "notes.txt"), "x");
    put(selectorPath(root, "s3"), { updatedAt: at(2) });

    const listing = await listCheckpoints(root, null, 0, NOW);
    expect(listing.entries.map((e) => [e.selector, e.fromBackup])).toEqual([
      ["s3", false],
      ["s1", true],
    ]);
  });

  it("lists a slot with a corrupt primary but valid backup as fromBackup", async () => {
    const root = tempDir();
    put(backupPath(selectorPath(root, "s1")), { updatedAt: at(1), goal: { primary: "saved before", tasks: [] } });
    writeFileSync(selectorPath(root, "s1"), "garbage");
    const listing = await listCheckpoints(root, null, 0, NOW);
    expect(listing.entries).toEqual([expect.objectContaining({ selector: "s1", fromBackup: true, goal: "saved before" })]);
  });

  it("lists unreadable checkpoints last with a warning instead of dropping them", async () => {
    const root = tempDir();
    put(selectorPath(root, "good"), { updatedAt: at(1) });
    mkdirSync(path.join(root, ".claude-checkpoints"), { recursive: true });
    writeFileSync(selectorPath(root, "bad"), "garbage");
    writeFileSync(backupPath(selectorPath(root, "bad")), "garbage");

    const listing = await listCheckpoints(root, null, 0, NOW);
    expect(listing.entries.map((e) => e.selector)).toEqual(["good", "bad"]);
    expect(listing.entries[1]).toMatchObject({ goal: null, updatedAt: null });
    expect(listing.entries[1]?.unreadable).toBeTruthy();
    expect(listing.warnings).toHaveLength(1);
  });

  it("returns an empty listing when there are no checkpoints", async () => {
    expect(await listCheckpoints(tempDir(), "s1", 10, NOW)).toEqual({ entries: [], total: 0, omitted: 0, warnings: [] });
  });
});

describe("renderListing", () => {
  it("shows each selector and goal, and how many older ones were left out", async () => {
    const root = tempDir();
    for (let i = 0; i < 12; i++) put(selectorPath(root, `s${i}`), { updatedAt: at(i), goal: { primary: `goal ${i}`, tasks: [] } });
    const text = renderListing(await listCheckpoints(root, null, 10, NOW));
    expect(text).toContain("s11");
    expect(text).toContain("goal 11");
    expect(text).not.toContain("goal 1\n");
    expect(text).toMatch(/…and 2 older/);
  });
});
