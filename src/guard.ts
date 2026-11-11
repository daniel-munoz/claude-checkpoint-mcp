// The PreToolUse subagent guard (#38). Bundled into the plugin's hook, so like nudge.ts it must not
// import anything that pulls in zod.
//
// Subagents share the parent's MCP server process, and with it the parent's session id, so a save
// from a subagent would overwrite the parent's checkpoint. Claude Code marks a hook that fires inside
// a subagent with `agent_id` (verified on 2.1.322). `agent_type` alone isn't enough: it is also set
// for a main session started with --agent.

const SAVE_TOOL_SUFFIX = "__save_session_checkpoint";

const REASON =
  "Subagents must not save session checkpoints: they share the parent session's checkpoint, so a save " +
  "would overwrite it. Report your progress to the parent agent in your final answer instead.";

/**
 * The PreToolUse output that blocks a subagent's save, or null to let the call through. Anything
 * unexpected allows the call: on Claude Code versions without `agent_id` the guard simply does nothing.
 */
export function guard(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const { tool_name, agent_id } = input as { tool_name?: unknown; agent_id?: unknown };
  if (typeof tool_name !== "string" || !tool_name.endsWith(SAVE_TOOL_SUFFIX)) return null;
  if (typeof agent_id !== "string" || agent_id === "") return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON },
  });
}
