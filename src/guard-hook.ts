#!/usr/bin/env node
// PreToolUse hook on save_session_checkpoint (built as dist/guard.js): stops a subagent from saving
// over the parent session's checkpoint. Any failure exits 0 with no output, which lets the save through.
import { guard } from "./guard.js";
import { readHookInput } from "./hookInput.js";

async function main(): Promise<void> {
  const decision = guard(await readHookInput());
  if (decision !== null) process.stdout.write(decision + "\n");
}

main().catch(() => {
  process.exitCode = 0;
});
