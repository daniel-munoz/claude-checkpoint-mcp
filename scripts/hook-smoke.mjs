// Runs the committed plugin hook the way Claude Code does, on whatever OS CI is using. SessionStart:
// silent without checkpoints, a nudge with one. PreToolUse: denies a subagent's save, and stays
// silent for the main session's. Needs only Node.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const hook = path.resolve("plugin/dist/hook.js");
const dir = mkdtempSync(path.join(tmpdir(), "hook-smoke-"));
const runWith = (input) => execFileSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: "utf8" });
const run = () => runWith({ cwd: dir });

const empty = run();
if (empty !== "") throw new Error(`expected no output without checkpoints, got: ${empty}`);

mkdirSync(path.join(dir, ".claude-checkpoints"));
writeFileSync(path.join(dir, ".claude-checkpoints", "smoke.json"), "{}");
const out = JSON.parse(run());
if (out.hookSpecificOutput?.hookEventName !== "SessionStart" || !out.hookSpecificOutput.additionalContext.includes("load_session_checkpoint")) {
  throw new Error(`unexpected hook output: ${JSON.stringify(out)}`);
}

// Run in the directory that now has a checkpoint, so a PreToolUse call wrongly routed to the nudge would show.
const save = {
  cwd: dir,
  hook_event_name: "PreToolUse",
  tool_name: "mcp__plugin_session-checkpoint_session-checkpoint__save_session_checkpoint",
  tool_input: { goal: "smoke" },
};
const mainSave = runWith(save);
if (mainSave !== "") throw new Error(`expected no output for a main-session save, got: ${mainSave}`);

const denied = JSON.parse(runWith({ ...save, agent_id: "smoke-agent", agent_type: "general-purpose" }));
if (denied.hookSpecificOutput?.hookEventName !== "PreToolUse" || denied.hookSpecificOutput.permissionDecision !== "deny") {
  throw new Error(`expected a subagent save to be denied, got: ${JSON.stringify(denied)}`);
}
console.log("hook smoke test passed");
