import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guard } from "../src/guard.js";

// Tool names as Claude Code builds them: plugin servers are mcp__plugin_<plugin>_<server>__<tool>,
// servers added with `claude mcp add` are mcp__<server>__<tool>.
const PLUGIN_SAVE = "mcp__plugin_session-checkpoint_session-checkpoint__save_session_checkpoint";
const MANUAL_SAVE = "mcp__session-checkpoint__save_session_checkpoint";
const PLUGIN_LOAD = "mcp__plugin_session-checkpoint_session-checkpoint__load_session_checkpoint";

// Shapes captured from Claude Code 2.1.322: the main session's input has no agent fields,
// a subagent's has both.
const main = { session_id: "s1", hook_event_name: "PreToolUse", tool_name: PLUGIN_SAVE, tool_input: { goal: "g" } };
const subagent = { ...main, agent_id: "ad53bfe2845d364d2", agent_type: "general-purpose" };

describe("subagent save guard", () => {
  it("denies a save from a subagent and tells it why", () => {
    const out = JSON.parse(guard(subagent)!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/subagent/i);
  });

  it("denies a subagent save through a server registered under another name", () => {
    expect(JSON.parse(guard({ ...subagent, tool_name: MANUAL_SAVE })!).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows a save from the main session", () => {
    expect(guard(main)).toBeNull();
  });

  it("allows a save from a main session started with --agent (agent_type without agent_id)", () => {
    expect(guard({ ...main, agent_type: "reviewer" })).toBeNull();
  });

  it("allows a subagent to load a checkpoint", () => {
    expect(guard({ ...subagent, tool_name: PLUGIN_LOAD })).toBeNull();
  });

  it.each([
    ["no input", {}],
    ["an empty agent_id", { ...subagent, agent_id: "" }],
    ["a non-string agent_id", { ...subagent, agent_id: 42 }],
    ["no tool name", { agent_id: "a1" }],
  ])("allows the call when given %s", (_label, input) => {
    expect(guard(input)).toBeNull();
  });
});

describe("plugin hook registration", () => {
  const hooks = JSON.parse(readFileSync(new URL("../plugin/hooks/hooks.json", import.meta.url), "utf8")).hooks;
  const entries: Array<{ matcher: string; hooks: Array<{ command: string }> }> = hooks.PreToolUse ?? [];
  // Claude Code treats a matcher with characters beyond [A-Za-z0-9_\- ,|] as an unanchored JS regex.
  const matches = (tool: string) => entries.some((e) => new RegExp(e.matcher).test(tool));

  it("runs the plugin hook before saves, under either server name", () => {
    expect(matches(PLUGIN_SAVE)).toBe(true);
    expect(matches(MANUAL_SAVE)).toBe(true);
    expect(entries.every((e) => e.hooks.every((h) => h.command.includes("dist/hook.js")))).toBe(true);
  });

  it("doesn't run before other tools", () => {
    expect(matches(PLUGIN_LOAD)).toBe(false);
    expect(matches("Bash")).toBe(false);
    expect(matches("mcp__other__save_session_checkpoint_v2")).toBe(false);
  });
});
