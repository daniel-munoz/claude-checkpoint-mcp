import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../src/schema.js";
import {
  backupPath,
  CheckpointError,
  checkpointPath,
  fitToSize,
  readCheckpoint,
  resolveRoot,
  selectorPath,
  serialize,
  writeCheckpoint,
} from "../src/store.js";
import { makeCheckpoint, tempDir } from "./helpers.js";

const noClientRoot = async () => undefined;

describe("selectorPath", () => {
  it("maps legacy to the single checkpoint file and session ids to slot files", () => {
    const root = tempDir();
    expect(selectorPath(root, "legacy")).toBe(checkpointPath(root));
    expect(selectorPath(root, "abc-1")).toBe(path.join(root, ".claude-checkpoints", "abc-1.json"));
  });

  it("rejects selectors that could escape the slots directory", () => {
    const root = tempDir();
    for (const bad of ["../x", "a/b", ""]) {
      expect(() => selectorPath(root, bad)).toThrow(CheckpointError);
    }
  });

  it("creates the slots directory with mode 0700 and keeps a .prev per slot", async () => {
    const root = tempDir();
    const file = selectorPath(root, "s1");
    await writeCheckpoint(file, makeCheckpoint({ summary: "first" }));
    expect(statSync(path.join(root, ".claude-checkpoints")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await writeCheckpoint(file, makeCheckpoint({ summary: "second" }));
    expect(JSON.parse(readFileSync(backupPath(file), "utf8")).summary).toBe("first");
  });
});

describe("resolveRoot", () => {
  it("prefers the explicit argument and resolves symlinks", async () => {
    const dir = tempDir();
    const link = path.join(tempDir(), "link");
    symlinkSync(dir, link);
    expect(await resolveRoot(link, async () => "/ignored")).toBe(dir);
  });

  it("falls back to the client root", async () => {
    const dir = tempDir();
    expect(await resolveRoot(undefined, async () => dir)).toBe(dir);
  });

  it("rejects relative, missing and non-directory paths", async () => {
    const dir = tempDir();
    const file = path.join(dir, "f.txt");
    writeFileSync(file, "x");
    await expect(resolveRoot("relative/path", noClientRoot)).rejects.toThrow(CheckpointError);
    await expect(resolveRoot(path.join(dir, "nope"), noClientRoot)).rejects.toThrow(/does not exist/);
    await expect(resolveRoot(file, noClientRoot)).rejects.toThrow(/not a directory/);
  });
});

describe("write/read", () => {
  it("writes with mode 0600 and round-trips", async () => {
    const dir = tempDir();
    const cp = makeCheckpoint({ summary: "hello" });
    await writeCheckpoint(checkpointPath(dir), cp);
    expect(statSync(checkpointPath(dir)).mode & 0o777).toBe(0o600);
    expect(await readCheckpoint(checkpointPath(dir))).toEqual({ checkpoint: cp, fromBackup: false, warnings: [] });
  });

  it("round-trips the session fields", async () => {
    const dir = tempDir();
    await writeCheckpoint(checkpointPath(dir), makeCheckpoint({ sessionId: "s1", resumedFrom: "legacy" }));
    expect((await readCheckpoint(checkpointPath(dir)))?.checkpoint).toMatchObject({ sessionId: "s1", resumedFrom: "legacy" });
  });

  it("returns null when nothing has been saved", async () => {
    expect(await readCheckpoint(checkpointPath(tempDir()))).toBeNull();
  });

  it("keeps the previous good checkpoint as .prev and falls back to it", async () => {
    const dir = tempDir();
    await writeCheckpoint(checkpointPath(dir), makeCheckpoint({ summary: "first" }));
    await writeCheckpoint(checkpointPath(dir), makeCheckpoint({ summary: "second" }));
    expect(JSON.parse(readFileSync(backupPath(checkpointPath(dir)), "utf8")).summary).toBe("first");

    writeFileSync(checkpointPath(dir), "{ truncated");
    const loaded = await readCheckpoint(checkpointPath(dir));
    expect(loaded?.fromBackup).toBe(true);
    expect(loaded?.checkpoint.summary).toBe("first");
    expect(loaded?.warnings[0]).toMatch(/unreadable/);
  });

  it("does not overwrite a good .prev with a corrupt primary", async () => {
    const dir = tempDir();
    await writeCheckpoint(checkpointPath(dir), makeCheckpoint({ summary: "first" }));
    await writeCheckpoint(checkpointPath(dir), makeCheckpoint({ summary: "second" }));
    writeFileSync(checkpointPath(dir), "garbage");
    await writeCheckpoint(checkpointPath(dir), makeCheckpoint({ summary: "third" }));
    expect(JSON.parse(readFileSync(backupPath(checkpointPath(dir)), "utf8")).summary).toBe("first");
  });

  it("throws a CheckpointError when both files are unreadable", async () => {
    const dir = tempDir();
    writeFileSync(checkpointPath(dir), "garbage");
    writeFileSync(backupPath(checkpointPath(dir)), JSON.stringify({ version: 99 }));
    await expect(readCheckpoint(checkpointPath(dir))).rejects.toThrow(CheckpointError);
  });
});

describe("fitToSize", () => {
  it("drops oldest commands first", () => {
    const big = "x".repeat(1900);
    const cp = makeCheckpoint({
      recentCommands: Array.from({ length: 50 }, (_, i) => ({ command: `${i}:${big}`, at: "2026-10-08T12:00:00.000Z" })),
    });
    fitToSize(cp);
    expect(Buffer.byteLength(serialize(cp))).toBeLessThanOrEqual(MAX_FILE_BYTES);
    expect(cp.meta.truncated).toBe(true);
    expect(cp.recentCommands.at(-1)?.command.startsWith("49:")).toBe(true);
    expect(cp.recentCommands[0]?.command.startsWith("0:")).toBe(false);
  });
});
