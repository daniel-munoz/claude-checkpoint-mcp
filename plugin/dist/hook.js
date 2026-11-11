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

// src/nudge.ts
import { readdir, stat as stat2 } from "node:fs/promises";
import path2 from "node:path";

// src/paths.ts
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
var CHECKPOINT_FILENAME = ".claude-checkpoint";
var SLOTS_DIRNAME = ".claude-checkpoints";
var BACKUP_SUFFIX = ".prev";
var CheckpointError = class extends Error {
  name = "CheckpointError";
};
async function resolveRoot(explicit, clientRoot, envRoot = process.env.CHECKPOINT_PROJECT_ROOT) {
  const candidate = explicit ?? (envRoot || void 0) ?? await clientRoot().catch(() => void 0) ?? process.cwd();
  if (!path.isAbsolute(candidate)) {
    throw new CheckpointError(`projectRoot must be an absolute path, got: ${candidate}`);
  }
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new CheckpointError(`projectRoot does not exist: ${candidate}`);
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new CheckpointError(`projectRoot is not a directory: ${candidate}`);
  }
  return resolved;
}

// src/render.ts
function formatAge(fromIso, now = /* @__PURE__ */ new Date()) {
  const secs = Math.max(0, Math.round((now.getTime() - Date.parse(fromIso)) / 1e3));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// src/session.ts
var LEGACY_SELECTOR = "legacy";
var SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// src/nudge.ts
var OFF_VALUES = /* @__PURE__ */ new Set(["0", "off", "false", "no"]);
var SLOT_EXT = ".json";
var SLOT_BACKUP_EXT = SLOT_EXT + BACKUP_SUFFIX;
function nudgeDisabled(env) {
  return OFF_VALUES.has((env.SESSION_CHECKPOINT_NUDGE ?? "").trim().toLowerCase());
}
function hookRoot(input, env) {
  const sessionDir = env.CLAUDE_PROJECT_DIR || typeof input.cwd === "string" && input.cwd || void 0;
  return resolveRoot(void 0, async () => sessionDir, env.CHECKPOINT_PROJECT_ROOT);
}
async function mtimeMs(file) {
  try {
    const s = await stat2(file);
    return s.isFile() ? s.mtimeMs : null;
  } catch {
    return null;
  }
}
async function findCheckpoints(root) {
  const legacy = path2.join(root, CHECKPOINT_FILENAME);
  const groups = /* @__PURE__ */ new Map([[LEGACY_SELECTOR, [legacy, legacy + BACKUP_SUFFIX]]]);
  let names = [];
  try {
    names = await readdir(path2.join(root, SLOTS_DIRNAME));
  } catch {
  }
  for (const name of names) {
    const ext = [SLOT_EXT, SLOT_BACKUP_EXT].find((e) => name.endsWith(e));
    const stem = ext === void 0 ? null : name.slice(0, -ext.length);
    if (stem === null || stem === LEGACY_SELECTOR || !SESSION_ID_PATTERN.test(stem)) continue;
    groups.set(stem, [...groups.get(stem) ?? [], path2.join(root, SLOTS_DIRNAME, name)]);
  }
  let count = 0;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const files of groups.values()) {
    const times = (await Promise.all(files.map(mtimeMs))).filter((t) => t !== null);
    if (times.length === 0) continue;
    count++;
    newestMs = Math.max(newestMs, ...times);
  }
  return { count, newestMs };
}
async function nudge(input, env = process.env, now = /* @__PURE__ */ new Date()) {
  if (nudgeDisabled(env)) return null;
  let root;
  try {
    root = await hookRoot(input, env);
  } catch {
    return null;
  }
  const { count, newestMs } = await findCheckpoints(root);
  if (count === 0) return null;
  const what = count === 1 ? "A session checkpoint exists" : `${count} session checkpoints exist`;
  const age = formatAge(new Date(newestMs).toISOString(), now);
  return `${what} in ${root} (latest saved ${age}). Call load_session_checkpoint. If it returns this session's checkpoint, briefly summarize the goal and next steps it records and confirm with the user before acting on them. If it returns a list, show it and ask the user which one to resume.`;
}
function hookOutput(message) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message } });
}

// src/hook.ts
async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
function parseInput(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}
async function main() {
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
