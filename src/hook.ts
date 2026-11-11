#!/usr/bin/env node
// SessionStart hook: if the project has checkpoints, tells the agent to load one and confirm
// before resuming. It must never break session start, so every failure exits 0 silently.
import { readHookInput } from "./hookInput.js";
import { hookOutput, nudge } from "./nudge.js";

async function main(): Promise<void> {
  const message = await nudge(await readHookInput());
  if (message !== null) process.stdout.write(hookOutput(message) + "\n");
}

main().catch(() => {
  process.exitCode = 0;
});
