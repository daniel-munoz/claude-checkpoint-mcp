#!/usr/bin/env node
// The plugin's hook, for two events:
// - SessionStart: if the project has checkpoints, tells the agent to load one and confirm before resuming.
// - PreToolUse (saves only, per hooks.json): stops a subagent from saving over the parent's checkpoint.
// It must never break the session, so every failure exits 0 silently, which also lets a tool call through.
import { guard } from "./guard.js";
import { hookOutput, nudge, type HookInput } from "./nudge.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(text: string): HookInput & { hook_event_name?: unknown } {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const input = parseInput(await readStdin());
  if (input.hook_event_name === "PreToolUse") {
    const decision = guard(input);
    if (decision !== null) process.stdout.write(decision + "\n");
    return;
  }
  const message = await nudge(input);
  if (message !== null) process.stdout.write(hookOutput(message) + "\n");
}

main().catch(() => {
  process.exitCode = 0;
});
