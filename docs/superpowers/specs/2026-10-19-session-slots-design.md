# Per-session checkpoint slots

Issue: daniel-munoz/claude-checkpoint-mcp#1 (copied from tenlean/claude-checkpoint-mcp#1).
Scope: the fork only, for now. The user will run it for a while and offer it upstream if it holds up.

## Why

Today every session in a directory shares one `<root>/.claude-checkpoint`. That's fine in a git
worktree, where one piece of work owns the folder. It breaks in folders the user reuses for
unrelated sessions: `/tmp` for a quick analysis, or the folder where a `claude agents` terminal
runs, where every session it starts opens in the same cwd. There, a `replace` save from session B
wipes session A's checkpoint, a `merge` save mixes B into A, and a resume loads whichever session
saved last.

The user hasn't lost work yet only because they've been careful. The goal is to stop needing care.

## Goals

- Each Claude Code session saves to its own checkpoint; no session can overwrite or merge into
  another's.
- On load, a session that has its own checkpoint gets it directly.
- Otherwise, the user sees the checkpoints in that folder (goal, last-saved time) and picks one.
  This applies everywhere, worktrees included, even when only one checkpoint exists.
- Old checkpoints are kept indefinitely: a session may be resumed long after it ran.
- Checkpoints written by 0.1.x stay loadable.

## Non-goals

- Automatic cleanup or expiry of old checkpoints.
- Cross-directory search (checkpoints still live under the project root).
- Upstream PR compatibility work beyond keeping the change self-contained.

## Anti-goals (failure even if it "works")

- Silently loading another session's checkpoint when the id doesn't match.
- Losing a save because two sessions wrote at the same moment.
- Stranding existing `.claude-checkpoint` files after the upgrade.

## Facts this design relies on

From https://code.claude.com/docs/en/env-vars, and verified live (the running server's env had
`CLAUDE_CODE_SESSION_ID` equal to the session id):

- Claude Code sets `CLAUDE_CODE_SESSION_ID` in stdio MCP server subprocesses.
- The MCP server keeps the id it was spawned with. It is **not** updated on `/clear`.
- On `--resume <session-id>` the server receives the resumed id.
- On `--continue`, or `--resume` without an id, it may receive the initial startup id instead.
- Hooks and Bash get the current id (updated on `/clear`); the hook's stdin has `session_id`.
- Each Claude Code session spawns its own server process. The server's existing in-process queue
  serializes calls within one session only; there is no cross-process lock.

Consequences:

- Crash → fresh `claude` → new id → no match → list. As intended.
- `/clear` → server still has the pre-clear id → loads the pre-clear checkpoint directly, which is
  what the user wants after a clear. Saves after the clear also go to that slot (same as today's
  behavior for that session). Accepted.
- Compaction keeps the session, so the id matches.
- `--continue` may mismatch → list. Acceptable fallback.

## Design

### Storage

- Session checkpoints live at `<root>/.claude-checkpoints/<sessionId>.json`, each with its own
  `<sessionId>.json.prev` backup, using the existing atomic write (temp + fsync + rename, 0600) and
  the existing "back up only a valid file" rule.
- One file per session (not a shared array/map file) because concurrent sessions are separate
  processes; separate files need no locking and can't lose each other's saves.
- The directory is created on first save (mode 0700).
- Session id comes from `process.env.CLAUDE_CODE_SESSION_ID`, read once at startup. It must match
  `^[A-Za-z0-9_-]{1,128}$` to be used as a filename; otherwise treat it as absent and add a
  warning to results.
- **No session id** (other MCP clients, Claude Desktop, older Claude Code): behave exactly as
  0.1.x, using the single `.claude-checkpoint` file. This keeps non-Claude-Code clients unchanged.
- Git still runs from `<root>`, so drift detection is unaffected.
- The checkpoint JSON gains two optional fields, keeping `version: 1` (older readers' zod schema
  strips unknown keys, so 0.1.x can still read new files):
  - `sessionId`: the owning session.
  - `resumedFrom`: the selector of the checkpoint this one was started from, when it was.
- `isCheckpointFile` (used to hide checkpoint files from git change lists and drift) must also
  match anything under `.claude-checkpoints/`.
- The "not git-ignored" warning should check `.claude-checkpoints/` when saving there. The README's
  suggested ignore pattern `.claude-checkpoint*` already covers it.

### The legacy file

- An existing `<root>/.claude-checkpoint` appears in listings as one more entry, with selector
  `legacy` and no session id.
- When a session id is known, saves never write the legacy file. It is left untouched on disk.

### Selectors

A selector names one checkpoint: a session id, or the literal `legacy`.

### `load_session_checkpoint`

New optional input `checkpoint` (a selector). Flow:

1. `checkpoint` given → load that one (session slot or legacy, with the usual `.prev` fallback).
   Unknown selector → tool error that says so and suggests `list_session_checkpoints`.
2. Else, a session id is known and its slot exists → load it (today's brief, drift, warnings).
3. Else, any checkpoints exist (slots and/or legacy) → do **not** load. Return the list (same shape
   as `list_session_checkpoints`, default limit) plus text telling the model to show the list to
   the user, ask which to resume, and call `load_session_checkpoint` again with `checkpoint` set.
   Return this even when there is exactly one entry.
4. Else → "No checkpoint found", as today.

Without a session id (author's call, settled during review):

- Load with no selector: if the legacy file exists, load it (0.1.x). If it doesn't but slots do,
  return the list (step 3) rather than "No checkpoint found", so slots saved by Claude Code
  sessions aren't hidden.
- An explicit `checkpoint` selector can load a slot, and `list_session_checkpoints` shows slots.
- Saves always go to the legacy file. The `merge` base is the legacy file if it exists; the adopted
  checkpoint is used only when there is no legacy file. So a merge never replaces an existing
  legacy checkpoint with another session's content.

When a checkpoint is loaded via an explicit selector that isn't the current session's own slot, the
server remembers it in memory as this process's **adopted** checkpoint (see save).

Output: keep current fields; add `selector` (what was loaded) and, for step 3, `candidates` and
`total`. As learned from issue #2, everything the model needs (brief or list) must be in
`structuredContent` as well as in the text content.

### `list_session_checkpoints` (new tool)

Inputs: `projectRoot` (as elsewhere), `limit` (default 10; `0` means all).

Returns, newest `updatedAt` first:

- per entry: `selector`, `goal`, `updatedAt` (plus a human age like "3d ago" via `formatAge`),
  git branch (if any), `allTasksDone` (true only when it has tasks and all are `done`),
  `isCurrentSession`, `fromBackup`, and `resumedFrom` when set;
- `total` count and how many were omitted by `limit`;
- warnings for files that couldn't be read even from `.prev` (listed as unreadable, not dropped
  silently).

Read-only annotations, like load. Rendered as a compact markdown table/list in the text content and
mirrored in `structuredContent`.

### `save_session_checkpoint`

- Writes to the current session's slot when a session id is known, else the legacy file (today).
- `replace`: as today, into the slot.
- `merge` base, in order: the session's own slot if it exists; else the adopted checkpoint (if
  any); else none (with today's "nothing to merge into" warning).
- A slot started from an adopted checkpoint gets a fresh `id`/`createdAt` and `resumedFrom` set.
  The adopted checkpoint's own file is never written by another session.
- `resumedFrom` (author's call, settled during review): set on the first save that creates the
  slot while a checkpoint is adopted, in either mode (`replace` after adopting still counts as
  "started from" it). Once set, it is carried over on every later save to that slot, `replace`
  included, so the list always shows the slot's lineage.
- Output text and `path` point at the slot file.

### Server instructions and tool descriptions

Update `INSTRUCTIONS` and the tool descriptions to say: checkpoints are per session; if load returns
a list, show it to the user and ask which to resume before calling load again with `checkpoint`;
never pick one on the user's behalf.

### Outside the repo: the SessionStart hooks

`~/.claude/hooks/checkpoint-nudge.sh` and `~/.claude-personal/hooks/checkpoint-nudge.sh` only fire
when `<root>/.claude-checkpoint` exists. Update both to also fire when `<root>/.claude-checkpoints/`
contains any `*.json`, with wording that covers the list case ("call load_session_checkpoint; if it
returns a list, show it and ask me which to resume"). This is user config outside the repo: save a
session checkpoint and back up both scripts before editing.

### Docs and release

- README: document slots, the `checkpoint` selector, `list_session_checkpoints`, the no-session-id
  fallback, and the `/clear` / `--continue` caveats.
- Bump to 0.2.0 (package.json, plugin manifest, server.json as applicable), rebuild so
  `plugin/dist/index.js` is updated, and publish via the fork's marketplace for the user to test.
  The marketplace reads the fork's `main`, so release is a PR to the fork's `main` (as v0.1.1 was).
- Authorship (user's decision): set `author.name` to "Daniel Munoz" in
  `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and keep crediting the
  original ("fork of tenlean/claude-checkpoint-mcp by Tenzin") in the plugin description or README.
  In `LICENSE`, keep "Copyright (c) 2026 Tenzin" and add "Copyright (c) 2026 Daniel Munoz" below
  it. Leave `mcpName` and `server.json` unchanged.

## Testing expectations

- Unit tests for store/listing (slots, legacy, `.prev` fallback, unreadable files, ordering, limit).
- E2E tests over MCP for: own-slot load; mismatch → list (including a single entry); explicit
  selector load; adopted-checkpoint merge; two "sessions" in one folder not affecting each other;
  no-session-id fallback matching 0.1.x; drift ignoring `.claude-checkpoints/`.
- Tests need to control the session id. How (e.g. a `createServer({ sessionId })` option defaulting
  to the env var) is the builder's call.

## Left to the builder

- Exact module split (e.g. a new listing module vs. extending `store.ts`).
- Exact wording of tool descriptions, instructions and list rendering, within the rules above.
- How to inject the session id in tests.
