<img src="plugin/.claude-plugin/icon.png" alt="" width="56" height="56" align="right">

# session-checkpoint-mcp

**Save your Claude Code session state locally, so a crash, `/clear`, or context limit doesn't make Claude rebuild context from scratch.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-stdio-8A2BE2.svg)](https://modelcontextprotocol.io)
[![M8ven Score](https://m8ven.ai/badge/mcp/daniel-munoz/claude-checkpoint-mcp)](https://m8ven.ai/mcp/daniel-munoz/claude-checkpoint-mcp?s=readme)
[![Session Checkpoint MCP on mcprush](https://mcprush.com/badge/daniel-munoz-claude-checkpoint-mcp/score.svg)](https://mcprush.com/to/daniel-munoz-claude-checkpoint-mcp?ref=badge)

`session-checkpoint-mcp` is a local [Model Context Protocol](https://modelcontextprotocol.io) server with three tools:

- `save_session_checkpoint` writes your session's working state to a small JSON file in the project.
- `load_session_checkpoint` turns that file back into a compact resume brief.
- `list_session_checkpoints` lists the checkpoints in the project, so you can pick which session to resume.

Each Claude Code session gets its own checkpoint, so several sessions can share a directory without overwriting each other.

It runs entirely on your machine. Nothing is sent anywhere.

Fork of [tenlean/claude-checkpoint-mcp](https://github.com/tenlean/claude-checkpoint-mcp) by Tenzin. The repository keeps that original name. The server is published as `session-checkpoint-mcp`, and the Claude Code plugin is `session-checkpoint`.

---

## Contents

- [Why: stop paying twice for the same context](#why-stop-paying-twice-for-the-same-context)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Environment variables](#environment-variables)
  - [Claude Code](#claude-code)
  - [Session-start nudge](#session-start-nudge)
  - [Subagent save guard](#subagent-save-guard)
  - [Claude Desktop](#claude-desktop-claude_desktop_configjson)
  - [Other MCP clients](#other-mcp-clients)
- [Usage](#usage)
- [Tool reference & examples](#tool-reference--examples)
- [The checkpoint files](#the-checkpoint-files)
- [Security & privacy](#security--privacy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why: stop paying twice for the same context

A long Claude Code session builds up a lot of context:
- what you're trying to do;
- which approaches already failed;
- which files matter;
- which test is still red.

Several things can wipe that out mid-task:
- a terminal crash, SSH drop, or laptop sleep;
- running out of context window;
- a `/clear` to get a fresh window.

The next session starts cold. To get back to where you were, Claude has to rebuild that context:

- **Re-reading files** to work out what was changed and why. Every file read is input tokens.
- **Re-running exploration**: `grep`, `git diff`, `ls`, test runs, all just to rediscover state.
- **Re-explaining.** You retype the goal, the constraints, and the dead ends, or Claude rediscovers the dead ends the hard way.

Each of those turns resends the growing conversation as input, so the cost compounds.

**`session-checkpoint-mcp` swaps that rebuild for one small, structured read:**

| | Without a checkpoint | With `load_session_checkpoint` |
|---|---|---|
| Restoring the goal & constraints | You retype them, or Claude infers them | One section of the brief |
| Knowing what's done vs. pending | Re-derived from code and git | Task list with statuses |
| Knowing which files matter | Broad re-reading | Exact list of touched files, with notes |
| Knowing what changed since | Re-read everything to be safe | **Only files whose content actually changed** are flagged |
| Remembering failed attempts | Often repeated | Recorded under *Decisions & gotchas* |

The resume brief for a typical session is about **1.2 KB of markdown**, a few hundred tokens. The [example below](#example-resume-brief) is real output at that size.

The biggest saving comes from **drift detection**. At save time, the server records a content hash for every file with uncommitted changes. On load, it compares those hashes against the working tree and tells Claude exactly which files changed after the checkpoint. Everything else in the brief can be trusted as-is, so Claude re-reads only what it has to.

---

## How it works

```
  Session 1                                     Session 2 (after crash / /clear)
  ─────────                                     ────────────────────────────────
  Claude ──save_session_checkpoint──┐       ┌──load_session_checkpoint── Claude
         goal, tasks, summary,      │       │   compact markdown brief
         next steps, decisions,     ▼       │   + "changed since checkpoint"
         files, commands      ┌─────────────────────┐
                              │ <project>/          │
     server adds:             │ .claude-checkpoint  │◀── git: branch, HEAD,
     git branch/HEAD,         │ .claude-checkpoint  │    dirty files + hashes
     dirty files + hashes,    │   .prev (backup)    │
     redacts secrets          └─────────────────────┘
```

- **Claude supplies the meaning**: the goal, progress, decisions, next steps, and which commands mattered.
- **The server supplies the facts**: git branch and HEAD, every uncommitted or untracked file with its content hash, and timestamps.
- **The server instructions teach Claude when to act.** Claude is told to load at the start of a session and to save after milestones, before risky operations, and when the conversation gets long. It doesn't need to be prompted every time.
- **The plugin's session-start hook makes resuming reliable.** Server instructions are easy for the agent to skip at the start of a session. When you install the Claude Code plugin, a [SessionStart hook](#session-start-nudge) also checks for checkpoints and, if there are any, tells Claude to load one and confirm with you before acting on it.

### One checkpoint per session

Claude Code passes each MCP server its session id (`CLAUDE_CODE_SESSION_ID`). The server uses it to give every session its own file, `<project>/.claude-checkpoints/<session-id>.json`, so sessions that share a directory (`/tmp`, or wherever you run `claude agents`) never overwrite or merge into each other.

- **Saving** always writes the current session's own file.
- **Loading** returns the session's own checkpoint if it has one. Otherwise, if other checkpoints exist, it returns a list (goal, last-saved time, branch, whether all tasks are done) and Claude asks you which one to resume. It never picks one for you, even when there's only one.
- **Resuming another session's checkpoint** loads it, but saves still go to the current session's own file. The load result tells Claude to pass the checkpoint's selector as `resumedFrom` on its next save. That save then starts from the resumed checkpoint and records where it came from. The server doesn't keep this in memory, so it still works if the server restarts in between. The original is never modified.
- **Checkpoints are kept** until you delete them, so an old session can be resumed later.
- **Clients without a session id** (e.g. Claude Desktop) get a checkpoint per conversation too. The first save mints a session id, writes `.claude-checkpoints/<id>.json`, and returns the id. Claude passes it back as `session` on every later call in that conversation. If Claude loses the id (after compaction, say), its next save starts a new checkpoint; it never writes into an existing one. A load with no id lists the checkpoints and lets you pick, like a new Claude Code session. In testing ([#42](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/42)), Opus, Sonnet and Haiku passed the id back on every save, including after compaction.
- **The shared `.claude-checkpoint` file** is what clients without a session id used before 1.0. Set [`CHECKPOINT_SESSION_IDS`](#environment-variables) to `legacy` to keep that behavior: every save without an id goes to that one file, and a load with no id opens it directly. Either way, a `.claude-checkpoint` left by an earlier version shows up in the list as `legacy`. Claude Code is unaffected by this setting: its own session id always takes precedence.

Any client can also pass `session` explicitly. On Claude Code it must match the session's own id: a different one is an error, because it almost always means a checkpoint selector went into the wrong argument (use `checkpoint` to read one and `resumedFrom` to continue from it).

The session id an MCP server sees is the one it was started with:

| You… | The server sees | Result |
|---|---|---|
| start a fresh `claude` (e.g. after a crash) | a new id | the list, so you pick what to resume |
| run `/clear` | the same id as before the clear | the pre-clear checkpoint loads directly; later saves keep updating it |
| run `claude --resume <id>` | that id | that session's checkpoint loads directly |
| run `claude --continue`, or `--resume` without an id | possibly a different id | the list |

---

## Installation

Requirements: **Node.js 20+** and **git**. Git is optional, but without it you lose drift detection.

```sh
git clone https://github.com/daniel-munoz/claude-checkpoint-mcp.git
cd claude-checkpoint-mcp
npm install
npm run build
```

The server entry point is now at `dist/index.js`.

**From npm.** The server is also published as [`session-checkpoint-mcp`](https://www.npmjs.com/package/session-checkpoint-mcp). In any of the configurations below, you can replace `node /absolute/path/to/claude-checkpoint-mcp/dist/index.js` with `npx -y session-checkpoint-mcp`:

```sh
claude mcp add --scope user checkpoint -- npx -y session-checkpoint-mcp
```

(The npm package `claude-checkpoint-mcp` is the upstream project's 0.1.0 release, not this fork.)

---

## Configuration

### Environment variables

| Variable | Set by | Required | Default | What it does |
|---|---|---|---|---|
| `CHECKPOINT_PROJECT_ROOT` | You (optional) | No | Unset: the client's root, then the server's working directory | Absolute path of the default project to checkpoint. Use it for clients with no current project, such as Claude Desktop. A `projectRoot` argument on a tool call takes precedence. |
| `SESSION_CHECKPOINT_NUDGE` | You (optional) | No | Unset: the nudge is on | Set to `off` (or `0`, `false`, `no`) to turn off the plugin's [session-start nudge](#session-start-nudge). Read by the hook, not the server. |
| `CLAUDE_CODE_SESSION_ID` | Claude Code, automatically | No | Unset: a session id is minted per conversation (see `CHECKPOINT_SESSION_IDS`) | Picks this session's checkpoint file, `.claude-checkpoints/<session-id>.json`. You don't set it. See [one checkpoint per session](#one-checkpoint-per-session). |
| `CHECKPOINT_SESSION_IDS` | You (optional) | No | Unset (same as `mint`): clients without a session id get their own checkpoint per conversation | Set to `legacy` to have clients without a session id share one `.claude-checkpoint` file, as before 1.0. Other values fall back to `mint` with a warning. Has no effect on Claude Code, whose own session id takes precedence. See [one checkpoint per session](#one-checkpoint-per-session). |

### Claude Code

**As a plugin (easiest).** This repo is also a Claude Code plugin marketplace. You don't need to clone or build anything:

```sh
claude plugin marketplace add daniel-munoz/claude-checkpoint-mcp
claude plugin install session-checkpoint@daniel-munoz
```

Restart Claude Code, then `/mcp` should show `plugin:session-checkpoint:session-checkpoint` as connected.

> **Upgrading from 0.2.x or earlier?** The plugin was renamed from `claude-checkpoint-mcp` to `session-checkpoint` in 0.3.0, because Claude Code reserves the `claude-` prefix for its own plugins. Uninstall the old plugin and install the new one:
>
> ```sh
> claude plugin uninstall claude-checkpoint-mcp@daniel-munoz
> claude plugin marketplace update daniel-munoz
> claude plugin install session-checkpoint@daniel-munoz
> ```
>
> The full tool names changed from `mcp__plugin_claude-checkpoint-mcp_claude-checkpoint__*` to `mcp__plugin_session-checkpoint_session-checkpoint__*`. Update any permission allowlists in `settings.json`, hooks, or instructions that use the old names. Short names such as `save_session_checkpoint` and your existing checkpoint files are unaffected.

**Manual setup.** If you cloned the repo, register the server once for your user account, so it's available in every project:

```sh
# Run from the claude-checkpoint-mcp directory
claude mcp add --scope user checkpoint -- node "$PWD/dist/index.js"
```

> **Use an absolute path.** A user-scoped server is launched from whichever project you open Claude Code in. A relative path like `./dist/index.js` would resolve against *that* project, not this repo. `"$PWD/dist/index.js"` expands to the absolute path when you run the command, which is what gets saved.

Check that it's registered:

```sh
claude mcp list
```

Inside a session, `/mcp` should show `checkpoint` as connected.

**Project-scoped alternative.** To share the server with a team through version control, add it to the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "checkpoint": {
      "command": "node",
      "args": ["/absolute/path/to/claude-checkpoint-mcp/dist/index.js"]
    }
  }
}
```

Either way, add the checkpoint files to the project's `.gitignore`, or to your global gitignore:

```gitignore
.claude-checkpoint*
```

### Session-start nudge

The plugin ships a `SessionStart` hook (`plugin/hooks/hooks.json`, running `node dist/hook.js`). It runs when a session starts, resumes, is cleared or is compacted. If the project has checkpoints, it adds a note to Claude's context: how many exist, when the newest was saved, and an instruction to call `load_session_checkpoint` and confirm with you before acting on what it records. With no checkpoints it prints nothing. It needs only Node, which the server already requires, so it works on macOS, Linux and Windows.

It looks in the same project root the server uses ([how the project root is chosen](#how-the-project-root-is-chosen)): `CHECKPOINT_PROJECT_ROOT` if it's set in the hook's environment, otherwise the directory Claude Code was started in. That is not the git top-level, so starting Claude in a subdirectory only reports checkpoints saved from that subdirectory, exactly what a plain `load_session_checkpoint` would find. If you set `CHECKPOINT_PROJECT_ROOT` only in the MCP server's config, also set it in `settings.json` `env` so the hook sees it.

**Turning it off.** Set `SESSION_CHECKPOINT_NUDGE` to `off` in the `env` block of your `settings.json`:

```json
{ "env": { "SESSION_CHECKPOINT_NUDGE": "off" } }
```

The manual setup (`claude mcp add`) doesn't install the hook. To get the nudge without the plugin, register `node /absolute/path/to/claude-checkpoint-mcp/dist/hook.js` as a `SessionStart` command hook in `settings.json`.

> **Upgrading from 0.3.x with your own nudge hook?** If you copied a `checkpoint-nudge.sh` hook into your config (for example `~/.claude/hooks/checkpoint-nudge.sh`), you'll now get the nudge twice. Delete the script and remove its `SessionStart` entry from `settings.json`. Do this for every config directory you use, such as `~/.claude` and any `CLAUDE_CONFIG_DIR` profile.

### Subagent save guard

Subagents run inside the parent session and share its MCP server, so they also share its session id. Without a guard, a subagent that calls `save_session_checkpoint` would overwrite the **parent's** checkpoint, and with `mode: "replace"` it would leave only its own narrow subtask behind.

The plugin ships a `PreToolUse` hook for this (`plugin/hooks/hooks.json`, running `node dist/guard.js`, matched on `^mcp__.+__save_session_checkpoint$`). When the call comes from a subagent, it denies the save and tells the subagent to report its progress to the parent instead. Saves from the main session, and every load and list call, go through untouched. The server instructions and the save tool's description say the same, for clients without the hook.

It recognizes a subagent by the `agent_id` field Claude Code adds to hook input inside subagents (verified on Claude Code 2.1.322). `agent_type` alone isn't used, because a main session started with `--agent` has it too. On a Claude Code version that doesn't send `agent_id`, or if the hook fails for any reason, the save goes ahead, so the hook never blocks the main session.

The manual setup (`claude mcp add`) doesn't install it. To add it without the plugin, register `node /absolute/path/to/claude-checkpoint-mcp/dist/guard.js` as a `PreToolUse` command hook with that matcher in `settings.json`.

### Claude Desktop (`claude_desktop_config.json`)

Open the config file:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add the server under `mcpServers`, using the absolute path to your local build:

```json
{
  "mcpServers": {
    "checkpoint": {
      "command": "node",
      "args": ["/absolute/path/to/claude-checkpoint-mcp/dist/index.js"],
      "env": {
        "CHECKPOINT_PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

Restart Claude Desktop after saving the file.

> Claude Desktop has no notion of a "current project". Use `CHECKPOINT_PROJECT_ROOT` to set the default project, or have Claude pass `projectRoot` on each call (*"save a checkpoint for /home/me/code/my-app"*). See [project root resolution](#how-the-project-root-is-chosen).

### Other MCP clients

Any MCP client that supports the stdio transport can run the server:

```sh
node /absolute/path/to/claude-checkpoint-mcp/dist/index.js
# or
npx -y session-checkpoint-mcp
```

---

## Usage

The server's built-in instructions cover the common cases automatically. You can also ask Claude directly.

**Save**:
- *"Checkpoint our progress."*
- *"Save a checkpoint before you run the migration."*
- *"Update the checkpoint. Merge in what we just did."*

**Resume** (in a fresh session):
- *"Resume where we left off."*
- *"Load the checkpoint and continue."*

### Example resume brief

This is real output from `load_session_checkpoint`. In the scenario, one file was committed unchanged after the save, and a teammate then edited `session.ts`:

```markdown
# Resuming: my-app (checkpoint saved 2m ago, 2026-10-08 02:23:55 UTC)
Branch `feat/github-oauth` @ b2ef1b591 (uncommitted changes)

## Goal
Add GitHub OAuth login with persistent sessions

## Tasks
- [x] OAuth callback route
- [~] Session cookie persistence
- [ ] Logout endpoint

## Where things stand
Callback exchanges the code and creates a session, but the cookie is dropped on reload. Suspect SameSite/secure flags in dev.

## Next steps
1. Set sameSite: 'lax' and secure only in production in src/auth/session.ts
2. Re-run npm test -- auth
3. Start the logout endpoint

## Decisions & gotchas
- Use iron-session, not express-session (needs edge runtime support)
- Don't mock the GitHub API in e2e tests; use the recorded fixtures in test/fixtures

## Files touched (3)
- src/auth/session.ts (M) — cookie options
- src/auth/callback.ts (M)
- src/auth/session.spec.ts (??)

## Recent commands (last 2, oldest first)
- ✓ `GITHUB_CLIENT_SECRET=«redacted» npm run dev`
- ✗ exit 1 `npm test -- auth` — 2 failing in session.spec.ts: cookie missing after reload

## Since this checkpoint
- 1 new commit(s) on HEAD
- ⚠ Changed after the checkpoint, re-read before editing: `src/auth/session.ts`
```

`callback.ts` was committed after the save, but its content didn't change, so it isn't flagged. Only `session.ts` needs to be re-read.

Task markers: `[x]` done · `[~]` in progress · `[ ]` pending · `[!]` blocked.

---

## Tool reference & examples

### `save_session_checkpoint`

Writes the current session's checkpoint: `<projectRoot>/.claude-checkpoints/<session-id>.json`. A client without a session id gets one minted on its first save (or, with `CHECKPOINT_SESSION_IDS=legacy`, writes `<projectRoot>/.claude-checkpoint`).

| Parameter | Type | Required | Description |
|---|---|:-:|---|
| `goal` | `string` (≤ 500) | ✅ | Primary objective of the session |
| `tasks` | `{ description, status }[]` (≤ 30) | | `status`: `pending` · `in_progress` · `done` · `blocked` |
| `summary` | `string` (≤ 4000) | | Where things stand: what works, what's broken, what you were in the middle of |
| `nextSteps` | `string[]` (≤ 20) | | Ordered next actions for whoever resumes |
| `decisions` | `string[]` (≤ 20) | | Key decisions, constraints, dead ends to avoid |
| `modifiedFiles` | `{ path, note? }[]` (≤ 100) | | Files to annotate, or committed files to include. Uncommitted git changes are detected automatically. Absolute paths inside the project are stored as relative. |
| `recentCommands` | `{ command, exitCode?, note? }[]` (≤ 50) | | Significant commands, oldest first. Secrets are redacted. |
| `mode` | `"replace"` \| `"merge"` | | Default `replace`. See below. |
| `resumedFrom` | `string` | | Selector of the checkpoint this session resumed from. Pass it on the first save after loading another session's checkpoint: a `merge` save builds on it, and either mode records it. Ignored once the session has its own checkpoint. A malformed selector is a tool error. One that doesn't exist or can't be read gives a warning, and the save goes ahead without it. |
| `session` | `string` | | This conversation's session id, as returned by an earlier save. Omit on Claude Code, which supplies it; if passed there, it must match. Not for picking a checkpoint to read: that's `checkpoint`. |
| `projectRoot` | `string` (absolute) | | Overrides [root resolution](#how-the-project-root-is-chosen) |

**Full save:**

```json
{
  "goal": "Add GitHub OAuth login with persistent sessions",
  "tasks": [
    { "description": "OAuth callback route", "status": "done" },
    { "description": "Session cookie persistence", "status": "in_progress" },
    { "description": "Logout endpoint", "status": "pending" }
  ],
  "summary": "Callback exchanges the code and creates a session, but the cookie is dropped on reload. Suspect SameSite/secure flags in dev.",
  "nextSteps": [
    "Set sameSite: 'lax' and secure only in production in src/auth/session.ts",
    "Re-run npm test -- auth"
  ],
  "decisions": ["Use iron-session, not express-session (needs edge runtime support)"],
  "modifiedFiles": [{ "path": "src/auth/session.ts", "note": "cookie options" }],
  "recentCommands": [
    { "command": "GITHUB_CLIENT_SECRET=gh_live_8f2a91 npm run dev", "exitCode": 0 },
    { "command": "npm test -- auth", "exitCode": 1, "note": "2 failing in session.spec.ts" }
  ]
}
```

**Response** (text shown to the model):

```
Checkpoint saved to /home/me/code/my-app/.claude-checkpoint (2202 bytes, replace).
3 task(s), 3 file(s), 2 command(s) on feat/github-oauth@b2ef1b591.
⚠ Redacted 1 secret-looking value(s).
```

**Incremental update with `merge`:**

```json
{
  "goal": "Add GitHub OAuth login with persistent sessions",
  "mode": "merge",
  "tasks": [
    { "description": "Session cookie persistence", "status": "done" },
    { "description": "Logout endpoint", "status": "in_progress" }
  ],
  "recentCommands": [{ "command": "npm test -- auth", "exitCode": 0, "note": "all green" }]
}
```

| Field | `replace` | `merge` |
|---|---|---|
| `goal` | set | set |
| `tasks` | set | updated by matching `description`; new tasks appended |
| `summary`, `nextSteps` | set | replaced if provided, otherwise kept |
| `decisions` | set | appended (deduplicated) |
| `recentCommands` | set | appended; the oldest are dropped beyond 50 |
| `modifiedFiles` | fresh git scan + provided | fresh git scan + provided + previously recorded |
| `id`, `createdAt` | new | preserved |

**Structured output** (`structuredContent`):

```json
{
  "path": "/home/me/code/my-app/.claude-checkpoint",
  "bytes": 2202,
  "mode": "replace",
  "counts": { "tasks": 3, "modifiedFiles": 3, "recentCommands": 2, "redactions": 1 },
  "warnings": ["Redacted 1 secret-looking value(s)."]
}
```

When the save used a session id, the output also has `session` (the id) and `sessionSource`: `env` (Claude Code's `CLAUDE_CODE_SESSION_ID`), `argument` (passed as `session`) or `minted` (new, with [`CHECKPOINT_SESSION_IDS=mint`](#environment-variables)). For `argument` and `minted`, the text also tells Claude to pass the id back on every later call. Both fields are left out when the save wrote `.claude-checkpoint`.

### `load_session_checkpoint`

Read-only. Reads the checkpoint, checks for drift, and returns the brief.

| Parameter | Type | Required | Description |
|---|---|:-:|---|
| `format` | `"brief"` \| `"full"` | | Default `brief` (markdown, as [above](#example-resume-brief)). `full` returns the complete checkpoint JSON plus drift. |
| `checkpoint` | `string` | | Which checkpoint to load: a selector from `list_session_checkpoints` (a session id, or `legacy`). Omit to load the current session's own. |
| `session` | `string` | | This conversation's session id, as returned by an earlier save. Omit on Claude Code, which supplies it; if passed there, it must match. Not for picking a checkpoint to read: that's `checkpoint`. |
| `projectRoot` | `string` (absolute) | | Overrides [root resolution](#how-the-project-root-is-chosen) |

**Examples:**

```json
{}
```

```json
{ "format": "full", "projectRoot": "/home/me/code/my-app" }
```

**Structured output** (`structuredContent`):

```json
{
  "found": true,
  "path": "/home/me/code/my-app/.claude-checkpoint",
  "fromBackup": false,
  "updatedAt": "2026-10-08T02:23:55.477Z",
  "drift": {
    "branchChanged": false,
    "currentBranch": "feat/github-oauth",
    "commitsSince": 1,
    "changedSince": ["src/auth/session.ts"]
  },
  "warnings": []
}
```

If no checkpoint exists, the tool returns `found: false` with a "nothing to resume" message. That isn't treated as an error.

If the current session has no checkpoint but others exist, it returns `found: false` with `candidates` (the same entries as `list_session_checkpoints`, newest first, up to 10), `total`, `omitted`, and `text` telling Claude to ask you which one to resume. An unknown `checkpoint` selector is a tool error.

Loading a checkpoint other than the session's own adds a `resumeHint`, which is also the first line of the brief, telling Claude to pass `resumedFrom` on its next save.

### `list_session_checkpoints`

Read-only. Lists the project's checkpoints, newest first; unreadable ones are listed last with a warning rather than hidden.

| Parameter | Type | Required | Description |
|---|---|:-:|---|
| `limit` | `integer` ≥ 0 | | Default `10`. `0` returns all of them. |
| `session` | `string` | | This conversation's session id, as returned by an earlier save. Omit on Claude Code, which supplies it; if passed there, it must match. Not for picking a checkpoint to read: that's `checkpoint`. |
| `projectRoot` | `string` (absolute) | | Overrides [root resolution](#how-the-project-root-is-chosen) |

**Structured output** (`structuredContent`, abridged):

```json
{
  "path": "/home/me/scratch",
  "entries": [
    {
      "selector": "8ce2c093-d512-42c2-a4d8-aa98280b55df",
      "goal": "Investigate the flaky upload test",
      "updatedAt": "2026-10-19T21:40:23.000Z",
      "age": "2h ago",
      "branch": null,
      "allTasksDone": false,
      "isCurrentSession": false,
      "fromBackup": false
    },
    { "selector": "legacy", "goal": "Quick CSV analysis", "...": "..." }
  ],
  "total": 2,
  "omitted": 0,
  "warnings": [],
  "text": "2 checkpoint(s) in /home/me/scratch, newest first: …"
}
```

### How the project root is chosen

1. The `projectRoot` argument
2. The `CHECKPOINT_PROJECT_ROOT` environment variable
3. The client's first `file://` root, if the client supports MCP roots
4. The server process's working directory

The path must be absolute and must be an existing directory. Symlinks are resolved. Checkpoints are always written under exactly that root: `<root>/.claude-checkpoints/<session-id>.json`, or `<root>/.claude-checkpoint` with `CHECKPOINT_SESSION_IDS=legacy` and no session id.

---

## The checkpoint files

```
<project>/
├── .claude-checkpoint              # legacy single checkpoint (0.x clients without a session id, CHECKPOINT_SESSION_IDS=legacy, or 0.1.x)
├── .claude-checkpoint.prev         # its backup
└── .claude-checkpoints/            # one checkpoint per session or minted conversation (directory mode 0700)
    ├── <session-id>.json
    └── <session-id>.json.prev      # each with its own backup
```

Every file is written atomically with mode 0600. The `.claude-checkpoint*` gitignore pattern covers all of them.

Each one is plain, versioned JSON, so it's easy to read, diff, or edit by hand. Real example:

```json
{
  "version": 1,
  "id": "ee5507c0-855e-44a5-85c1-d97b767537c9",
  "createdAt": "2026-10-08T02:23:55.477Z",
  "updatedAt": "2026-10-08T02:23:55.477Z",
  "generator": { "name": "session-checkpoint-mcp", "version": "0.6.0" },
  "project": { "name": "my-app" },
  "git": {
    "branch": "feat/github-oauth",
    "head": "b2ef1b5919ee5d456ea146c9362a7abc92b1e556",
    "dirty": true
  },
  "goal": {
    "primary": "Add GitHub OAuth login with persistent sessions",
    "tasks": [
      { "description": "OAuth callback route", "status": "done" },
      { "description": "Session cookie persistence", "status": "in_progress" },
      { "description": "Logout endpoint", "status": "pending" }
    ]
  },
  "summary": "Callback exchanges the code and creates a session, but the cookie is dropped on reload. Suspect SameSite/secure flags in dev.",
  "nextSteps": [
    "Set sameSite: 'lax' and secure only in production in src/auth/session.ts",
    "Re-run npm test -- auth",
    "Start the logout endpoint"
  ],
  "decisions": [
    "Use iron-session, not express-session (needs edge runtime support)",
    "Don't mock the GitHub API in e2e tests; use the recorded fixtures in test/fixtures"
  ],
  "modifiedFiles": [
    { "path": "src/auth/session.ts", "status": "M", "source": "git", "note": "cookie options", "hash": "9ec893ef673dac860e7e2b6fcaad602983eeb0b1" },
    { "path": "src/auth/callback.ts", "status": "M", "source": "git", "hash": "f3ecc849c3875d4f11bb42ae0e5ab6c71931d7f1" },
    { "path": "src/auth/session.spec.ts", "status": "??", "source": "git", "hash": "9daeafb9864cf43055ae93beb0afd6c7d144bfa4" }
  ],
  "recentCommands": [
    { "command": "GITHUB_CLIENT_SECRET=«redacted» npm run dev", "exitCode": 0, "at": "2026-10-08T02:23:55.477Z" },
    { "command": "npm test -- auth", "exitCode": 1, "note": "2 failing in session.spec.ts: cookie missing after reload", "at": "2026-10-08T02:23:55.477Z" }
  ],
  "meta": { "redactions": 1, "truncated": false }
}
```

| Field | Notes |
|---|---|
| `version` | Schema version. Unknown versions are rejected; future versions will migrate older files on load. |
| `id` / `createdAt` | Stable across `merge` saves; new on `replace` |
| `sessionId` | The Claude Code session that owns the checkpoint (absent in the legacy file) |
| `resumedFrom` | Selector of the checkpoint this one was started from, if any; kept on later saves |
| `git` | `null` outside a git repo, or before the repo's first commit |
| `modifiedFiles[].status` | Git porcelain code (`M`, `A`, `D`, `R`, `??`), or `M` for files reported only by Claude |
| `modifiedFiles[].source` | `git` (detected) or `agent` (reported by Claude, or carried over from an earlier merge) |
| `modifiedFiles[].hash` | Git blob hash of the working-tree content at save time; drives drift detection |
| `meta.truncated` | `true` if anything was dropped to fit list or size limits |

Paths are always relative to the project root. The file never stores absolute paths.

---

## Security & privacy

- **Local only.** There are no network calls. The server reads git metadata and the project's checkpoint files, and writes only the current session's checkpoint.
- **Secret redaction.** The following are replaced with `«redacted»` in commands, notes, summaries, tasks and decisions before anything touches disk:
  - `*_KEY=`, `*_TOKEN=`, `*_SECRET=`, `*PASSWORD=` assignments, including `Header: value` and JSON forms
  - `Authorization: Bearer …` headers
  - credentials in URLs (`postgres://user:pass@…`)
  - `--password` / `--token` / `--api-key` / `--secret` flags
  - bare `sk-…`, `ghp_…`, `github_pat_…`, `AKIA…` and `xox?-…` tokens

  Redaction is a safety net, not a guarantee, so keep the file out of version control.
- **Owner-only, crash-safe writes.** Files are written with mode `0600`. Each save writes a temp file, fsyncs it, and renames it into place, so a crash mid-save can't leave a half-written checkpoint.
- **Automatic backup.** The previous valid checkpoint is kept as `.claude-checkpoint.prev`. If the main file is corrupt, load falls back to the backup and says so. A corrupt file never overwrites a good backup.
- **Bounded size.** Every field has a length cap, and the file is capped at 64 KB (the oldest commands are dropped first), so a checkpoint can't grow into a token sink.
- **No shell.** Git runs through `execFile` with a 3-second timeout and `GIT_OPTIONAL_LOCKS=0`, so it never contends with your own git commands.
- **Doesn't touch your config.** If the checkpoint isn't git-ignored, the save response warns you. It never edits `.gitignore` for you.
- **Safe with parallel tool calls.** Tool calls are serialized inside the server, so concurrent `merge` saves can't lose updates.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `checkpoint` doesn't appear in `/mcp` | Run `claude mcp list` and check that the path is absolute and `dist/index.js` exists (`npm run build`). |
| Checkpoint is written to the wrong directory | The server fell back to its working directory. Pass `projectRoot` on the call, or set the [`CHECKPOINT_PROJECT_ROOT`](#environment-variables) environment variable. |
| `projectRoot must be an absolute path` | Use a full path such as `/home/me/code/app`, not `./app`. |
| Brief says "Saved commit … is no longer reachable" | The branch was rebased or reset after the save. Drift can't be computed against history, so treat the flagged files as needing a re-read. |
| Warning: "not git-ignored" | Add `.claude-checkpoint*` to `.gitignore`. |
| Claude is told about checkpoints twice at session start | You still have your own nudge hook as well as the plugin's. Remove yours (see [session-start nudge](#session-start-nudge)). |
| No nudge at session start | The hook only comes with the plugin, and only fires when the session's start directory (or `CHECKPOINT_PROJECT_ROOT`) has checkpoints. Check that `SESSION_CHECKPOINT_NUDGE` isn't `off`, and run `/hooks` to see that it's registered. |
| `session: "…" names a different one` | A checkpoint selector was passed as `session`. Use `checkpoint` on `load_session_checkpoint` to read another checkpoint, then `resumedFrom` on the next save to continue from it. |
| Many small checkpoints from a client without a session id | Claude isn't passing the `session` id back, so each first save starts a new checkpoint. Remind it, or set `CHECKPOINT_SESSION_IDS=legacy` to share one `.claude-checkpoint` file instead. |
| A subagent's save is denied with "Subagents must not save session checkpoints" | Working as intended: the [subagent save guard](#subagent-save-guard) stopped it from overwriting the parent's checkpoint. Have the subagent report its progress in its final answer, and save from the main session. |
| No "Since this checkpoint" section | The project isn't a git repo, or had no commits at save time. |

Server logs go to **stderr**. Stdout is reserved for the MCP protocol.

---

## Development

```sh
npm run typecheck   # strict TypeScript, src + tests
npm test            # unit tests + in-memory MCP end-to-end tests (vitest)
npm run build       # compile dist/index.js (server), dist/hook.js (nudge) and dist/guard.js (guard), and copy them to plugin/dist
npm run inspect     # open the MCP Inspector against dist/index.js
```

```
src/
├── index.ts    # entry point: stdio transport, signals, stderr logging
├── hook.ts     # entry point of the plugin's SessionStart hook (dist/hook.js)
├── guard-hook.ts # entry point of the plugin's PreToolUse subagent guard (dist/guard.js)
├── guard.ts    # subagent guard: denies saves from subagents
├── hookInput.ts # reads hook input from stdin (shared by both hooks)
├── nudge.ts    # session-start nudge: finds checkpoint files without reading them
├── server.ts   # McpServer construction + server instructions
├── tools.ts    # save/load/list tool schemas and handlers
├── session.ts  # session id validation
├── listing.ts  # checkpoint listing for the "which one?" prompt
├── schema.ts   # zod schema for the checkpoint file (v1) + migrations
├── paths.ts    # project root resolution and checkpoint file names (no dependencies, shared with the hook)
├── store.ts    # checkpoint paths, atomic I/O, backup/fallback
├── git.ts      # branch/HEAD/status snapshot, blob hashing, drift detection
├── redact.ts   # secret scrubbing
└── render.ts   # checkpoint → markdown resume brief
```

### Releasing

The version lives in `package.json`, `server.json` (twice), `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. `test/metadata.test.ts` fails if they disagree. Bump them all, run `npm run build`, commit, then push a `vX.Y.Z` tag. The [Publish workflow](.github/workflows/publish.yml) publishes `session-checkpoint-mcp` to npm and `server.json` to the MCP registry as `io.github.daniel-munoz/claude-checkpoint-mcp`.

If a release fails partway, don't re-run the failed job. Run the workflow again from **Actions → Publish → Run workflow** with the tag instead. Steps that already succeeded are skipped.

Built with the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) and [zod](https://zod.dev).

## License

[MIT](LICENSE)
