// Workflow ids on checkpoints (#55, design: 2026-11-19-workflow-checkpoints-design.md).
import { describe, expect, it } from "vitest";
import { parseCheckpoint } from "../src/schema.js";
import { resolveWorkflowEnv } from "../src/workflow.js";
import { makeCheckpoint } from "./helpers.js";

describe("resolveWorkflowEnv", () => {
  it("takes usable values", () => {
    expect(resolveWorkflowEnv("run-1", "work")).toEqual({ workflowId: "run-1", step: "work" });
  });
  it("treats missing or empty values as unset, without a warning", () => {
    expect(resolveWorkflowEnv(undefined, undefined)).toEqual({ workflowId: null, step: null });
    expect(resolveWorkflowEnv("", "")).toEqual({ workflowId: null, step: null });
  });
  it("ignores an unusable value and says which variable", () => {
    const r = resolveWorkflowEnv("bad id!", "work");
    expect(r.workflowId).toBeNull();
    expect(r.step).toBe("work");
    expect(r.warning).toContain("CHECKPOINT_WORKFLOW_ID");
    expect(resolveWorkflowEnv("run-1", "x".repeat(65)).warning).toContain("CHECKPOINT_WORKFLOW_STEP");
  });
});

describe("checkpoint workflow fields", () => {
  it("reads a file 1.0.0 wrote, with no workflow fields", () => {
    const c = parseCheckpoint(JSON.parse(JSON.stringify(makeCheckpoint())));
    expect(c.version).toBe(1);
    expect(c.workflowId).toBeUndefined();
    expect(c.step).toBeUndefined();
  });
  it("keeps the workflow id and step", () => {
    const c = parseCheckpoint({ ...makeCheckpoint(), workflowId: "01a1f46f-41b3:run.1", step: "work" });
    expect([c.workflowId, c.step]).toEqual(["01a1f46f-41b3:run.1", "work"]);
  });
  it("rejects a workflow id with characters outside the allowed set", () => {
    expect(() => parseCheckpoint({ ...makeCheckpoint(), workflowId: "a/b" })).toThrow();
  });
});
