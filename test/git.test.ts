import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { drift, snapshot } from "../src/git.js";
import { git, gitRepo, tempDir } from "./helpers.js";

/** A repo with clean.ts committed and dirty.ts modified, snapshotted as a checkpoint would be. */
async function savedRepo() {
  const dir = gitRepo();
  writeFileSync(path.join(dir, "clean.ts"), "clean\n");
  writeFileSync(path.join(dir, "dirty.ts"), "v1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  writeFileSync(path.join(dir, "dirty.ts"), "v2\n");
  const saved = (await snapshot(dir))!;
  const savedHashes = new Map(saved.changes.map((c) => [c.path, c.hash] as const));
  return { dir, saved: saved.state, savedHashes };
}

const write = (dir: string, file: string, text: string) => writeFileSync(path.join(dir, file), text);

describe("drift", () => {
  it("reports nothing when nothing changed after the save", async () => {
    const { dir, saved, savedHashes } = await savedRepo();
    expect(await drift(dir, saved, savedHashes)).toEqual({
      branchChanged: false,
      currentBranch: "main",
      commitsSince: 0,
      changedSince: [],
    });
  });

  it("does not report a file that was dirty at save time and is unchanged, even after committing it", async () => {
    const { dir, saved, savedHashes } = await savedRepo();
    git(dir, "commit", "-qam", "commit dirty");
    expect(await drift(dir, saved, savedHashes)).toMatchObject({ commitsSince: 1, changedSince: [] });
  });

  it("reports a dirty-at-save file that was edited again, reverted or deleted", async () => {
    const edited = await savedRepo();
    write(edited.dir, "dirty.ts", "v3\n");
    expect((await drift(edited.dir, edited.saved, edited.savedHashes))?.changedSince).toEqual(["dirty.ts"]);

    const reverted = await savedRepo();
    git(reverted.dir, "checkout", "--", "dirty.ts");
    expect((await drift(reverted.dir, reverted.saved, reverted.savedHashes))?.changedSince).toEqual(["dirty.ts"]);

    const deleted = await savedRepo();
    rmSync(path.join(deleted.dir, "dirty.ts"));
    expect((await drift(deleted.dir, deleted.saved, deleted.savedHashes))?.changedSince).toEqual(["dirty.ts"]);
  });

  it("reports clean files edited, committed, or created after the save", async () => {
    const { dir, saved, savedHashes } = await savedRepo();
    write(dir, "clean.ts", "edited\n");
    write(dir, "committed.ts", "x\n");
    git(dir, "add", "committed.ts");
    git(dir, "commit", "-qm", "add committed");
    write(dir, "untracked.ts", "x\n");
    expect((await drift(dir, saved, savedHashes))?.changedSince).toEqual(["clean.ts", "committed.ts", "untracked.ts"]);
  });

  it("skips ignored paths", async () => {
    const { dir, saved, savedHashes } = await savedRepo();
    write(dir, "clean.ts", "edited\n");
    write(dir, "dirty.ts", "v3\n");
    expect((await drift(dir, saved, savedHashes, (p) => p === "dirty.ts"))?.changedSince).toEqual(["clean.ts"]);
  });

  it("reports a branch switch", async () => {
    const { dir, saved, savedHashes } = await savedRepo();
    git(dir, "checkout", "-qb", "other");
    expect(await drift(dir, saved, savedHashes)).toMatchObject({ branchChanged: true, currentBranch: "other" });
  });

  it("when the saved commit is unreachable, counts every current change as changed", async () => {
    const { dir, saved, savedHashes } = await savedRepo();
    write(dir, "clean.ts", "edited\n");
    const gone = { ...saved, head: "0".repeat(40) };
    expect(await drift(dir, gone, savedHashes)).toMatchObject({ commitsSince: null, changedSince: ["clean.ts"] });
  });

  it("returns null outside a git repo", async () => {
    const { saved, savedHashes } = await savedRepo();
    expect(await drift(tempDir(), saved, savedHashes)).toBeNull();
  });
});
