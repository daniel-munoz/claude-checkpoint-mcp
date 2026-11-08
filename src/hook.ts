#!/usr/bin/env node
// SessionStart hook: if the project has checkpoints, tells the agent to load one and confirm
// before resuming. It must never break session start, so every failure exits 0 silently.
import { hookOutput, nudge, type HookInput } from "./nudge.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(text: string): HookInput {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const message = await nudge(parseInput(await readStdin()));
  if (message !== null) process.stdout.write(hookOutput(message) + "\n");
}

main().catch(() => {
  process.exitCode = 0;
});
