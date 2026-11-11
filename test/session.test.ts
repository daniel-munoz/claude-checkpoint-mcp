import { describe, expect, it } from "vitest";
import { CheckpointError } from "../src/paths.js";
import { resolveCallSession, resolveIdMode, resolveSessionId } from "../src/session.js";

describe("resolveSessionId", () => {
  it("accepts a Claude Code session id", () => {
    expect(resolveSessionId("8ce2c093-d512-42c2-a4d8-aa98280b55df")).toEqual({ id: "8ce2c093-d512-42c2-a4d8-aa98280b55df" });
  });

  it("treats a missing or empty id as absent, without a warning", () => {
    expect(resolveSessionId(undefined)).toEqual({ id: null });
    expect(resolveSessionId("")).toEqual({ id: null });
  });

  it("rejects ids that are unsafe as file names", () => {
    for (const raw of ["../etc", "a/b", "a".repeat(129)]) {
      const result = resolveSessionId(raw);
      expect(result.id).toBeNull();
      expect(result.warning).toMatch(/CLAUDE_CODE_SESSION_ID/);
    }
  });

  it("says a minted id replaces an unusable one when minting is on", () => {
    const result = resolveSessionId("../etc", true);
    expect(result.id).toBeNull();
    expect(result.warning).toContain("minted");
    expect(result.warning).not.toContain(".claude-checkpoint");
  });

  it("rejects the reserved legacy selector", () => {
    const result = resolveSessionId("legacy");
    expect(result.id).toBeNull();
    expect(result.warning).toMatch(/CLAUDE_CODE_SESSION_ID/);
  });
});

describe("resolveCallSession", () => {
  it("uses the env var when no argument is passed", () => {
    expect(resolveCallSession(undefined, "env1")).toEqual({ id: "env1", source: "env" });
  });

  it("treats an argument equal to the env var as the env var", () => {
    expect(resolveCallSession("env1", "env1")).toEqual({ id: "env1", source: "env" });
  });

  it("uses the argument when there is no env var", () => {
    expect(resolveCallSession("a1", null)).toEqual({ id: "a1", source: "argument" });
  });

  it("reports no session when there is neither", () => {
    expect(resolveCallSession(undefined, null)).toEqual({ id: null, source: null });
  });

  it("rejects an argument that differs from the env var", () => {
    expect(() => resolveCallSession("other", "env1")).toThrow('This server runs for session "env1"; session: "other" names a different one.');
  });

  it("tells a caller with a stale id how to recover from a conflict", () => {
    expect(() => resolveCallSession("old", "env1")).toThrow("To use this server's own session, omit session.");
  });

  it("rejects arguments that aren't usable session ids", () => {
    for (const bad of ["legacy", "../x", "a b", "", "x".repeat(129)]) expect(() => resolveCallSession(bad, null)).toThrow(CheckpointError);
  });
});

describe("resolveIdMode", () => {
  it("mints by default", () => {
    expect(resolveIdMode(undefined)).toEqual({ mint: true });
    expect(resolveIdMode("")).toEqual({ mint: true });
    expect(resolveIdMode(" MINT ")).toEqual({ mint: true });
  });

  it("keeps the shared legacy file for legacy, ignoring case and spaces", () => {
    expect(resolveIdMode(" Legacy ")).toEqual({ mint: false });
  });

  it("falls back to minting, with a warning, for any other value", () => {
    expect(resolveIdMode("yes")).toEqual({ mint: true, warning: expect.stringContaining('CHECKPOINT_SESSION_IDS must be "mint" or "legacy"') });
    expect(resolveIdMode("off").warning).toContain("Using mint.");
  });
});
