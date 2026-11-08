// Runs the committed plugin hook the way Claude Code does, on whatever OS CI is using:
// silent without checkpoints, SessionStart JSON with one. Needs only Node.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const hook = path.resolve("plugin/dist/hook.js");
const dir = mkdtempSync(path.join(tmpdir(), "hook-smoke-"));
const run = () => execFileSync(process.execPath, [hook], { input: JSON.stringify({ cwd: dir }), encoding: "utf8" });

const empty = run();
if (empty !== "") throw new Error(`expected no output without checkpoints, got: ${empty}`);

mkdirSync(path.join(dir, ".claude-checkpoints"));
writeFileSync(path.join(dir, ".claude-checkpoints", "smoke.json"), "{}");
const out = JSON.parse(run());
if (out.hookSpecificOutput?.hookEventName !== "SessionStart" || !out.hookSpecificOutput.additionalContext.includes("load_session_checkpoint")) {
  throw new Error(`unexpected hook output: ${JSON.stringify(out)}`);
}
console.log("hook smoke test passed");
