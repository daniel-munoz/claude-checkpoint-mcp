#!/usr/bin/env node

// src/guard.ts
var SAVE_TOOL_SUFFIX = "__save_session_checkpoint";
var REASON = "Subagents must not save session checkpoints: they share the parent session's checkpoint, so a save would overwrite it. Report your progress to the parent agent in your final answer instead.";
function guard(input) {
  if (typeof input !== "object" || input === null) return null;
  const { tool_name, agent_id } = input;
  if (typeof tool_name !== "string" || !tool_name.endsWith(SAVE_TOOL_SUFFIX)) return null;
  if (typeof agent_id !== "string" || agent_id === "") return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON }
  });
}

// src/hookInput.ts
async function readHookInput() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

// src/guard-hook.ts
async function main() {
  const decision = guard(await readHookInput());
  if (decision !== null) process.stdout.write(decision + "\n");
}
main().catch(() => {
  process.exitCode = 0;
});
