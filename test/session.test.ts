import { describe, expect, it } from "vitest";
import { resolveSessionId } from "../src/session.js";

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

  it("rejects the reserved legacy selector", () => {
    const result = resolveSessionId("legacy");
    expect(result.id).toBeNull();
    expect(result.warning).toMatch(/CLAUDE_CODE_SESSION_ID/);
  });
});
