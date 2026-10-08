# claude-checkpoint-mcp

An MCP server that checkpoints your Claude Code session — goal, task progress, touched files, recent commands — to a `.claude-checkpoint` file in the project, so a crash, `/clear`, or context limit doesn't cost you the session.

On resume, Claude gets a compact brief (typically well under 1.5k tokens) instead of re-reading files and re-deriving context, plus a list of exactly which files changed since the checkpoint so it only re-reads what it has to.

## Install

Requires Node.js 20+.

```sh
git clone <this repo> && cd claude-checkpoint-mcp
npm install && npm run build

# Available in every project:
claude mcp add --scope user checkpoint -- node "$PWD/dist/index.js"
```

Then, in any project:

- **"Save a checkpoint"**: Claude calls `save_session_checkpoint`. The server's instructions also nudge Claude to save after milestones and when the conversation gets long.
- **"Resume where we left off"**: Claude calls `load_session_checkpoint` and continues from the next steps.

Add the checkpoint to your global or project gitignore:

```gitignore
.claude-checkpoint*
```

## Tools

### `save_session_checkpoint`

| Argument | Description |
|---|---|
| `goal` *(required)* | Primary objective of the session |
| `tasks` | `{ description, status: pending \| in_progress \| done \| blocked }[]` |
| `summary` | Where things stand |
| `nextSteps` | Ordered next actions |
| `decisions` | Key decisions, constraints, dead ends |
| `modifiedFiles` | `{ path, note? }[]`, merged with files git reports as changed |
| `recentCommands` | `{ command, exitCode?, note? }[]`, oldest first |
| `mode` | `replace` (default) or `merge` (update tasks, append commands/decisions/files) |
| `projectRoot` | Absolute project path override |

Git branch, HEAD, and uncommitted/untracked files (with content hashes) are captured automatically.

### `load_session_checkpoint`

| Argument | Description |
|---|---|
| `format` | `brief` (default, markdown) or `full` (complete JSON) |
| `projectRoot` | Absolute project path override |

The brief ends with a **Since this checkpoint** section covering:

- branch switches;
- new commits;
- files whose content changed after the save.

A file that was committed unchanged doesn't count as changed.

## How the project root is chosen

1. The `projectRoot` argument
2. The `CHECKPOINT_PROJECT_ROOT` environment variable
3. The client's first `file://` root, if the client supports MCP roots
4. The server process's working directory

## Safety

- **Secret redaction.** The following are scrubbed from commands, notes, and summaries before anything is written:
  - `*_KEY=`, `*_TOKEN=`, `*_SECRET=`, `*PASSWORD=` assignments
  - Bearer tokens
  - URL credentials
  - `--password`/`--token` flags
  - `sk-`, `ghp_`/`github_pat_`, `AKIA…` and `xox?-` tokens
- **Crash-safe writes.** Each save writes a temp file, fsyncs it, and renames it into place with mode `0600`.
- **Backup.** The last good checkpoint is kept as `.claude-checkpoint.prev`. Load falls back to it if the primary file is corrupt.
- **Size cap.** The file is capped at 64 KB; the oldest commands are dropped first.
- **Your files are left alone.** The server never edits `.gitignore`. If the checkpoint isn't ignored, it warns instead.
- **No shell.** Git runs via `execFile` with a 3-second timeout.

## Checkpoint format (v1)

```json
{
  "version": 1,
  "id": "b3f1c2e0-…",
  "createdAt": "2026-10-08T14:02:11.000Z",
  "updatedAt": "2026-10-08T15:47:03.000Z",
  "generator": { "name": "claude-checkpoint-mcp", "version": "0.1.0" },
  "project": { "name": "my-app" },
  "git": { "branch": "feat/auth", "head": "9c1e4a7…", "dirty": true },
  "goal": {
    "primary": "Add OAuth login with GitHub provider",
    "tasks": [{ "description": "Session persistence", "status": "in_progress" }]
  },
  "summary": "Callback route works; session cookie not persisting across reloads.",
  "nextSteps": ["Check SameSite attr in src/auth/session.ts"],
  "decisions": ["Use iron-session, not express-session (edge runtime)"],
  "modifiedFiles": [
    { "path": "src/auth/session.ts", "status": "M", "source": "git", "note": "cookie opts", "hash": "e69de29…" }
  ],
  "recentCommands": [
    { "command": "npm test -- auth", "exitCode": 1, "note": "2 failing", "at": "2026-10-08T15:45:10.000Z" }
  ],
  "meta": { "redactions": 0, "truncated": false }
}
```

Paths are relative to the project root. The file never stores absolute paths.

## Development

```sh
npm run typecheck   # src + tests, strict
npm test            # unit + in-memory MCP end-to-end tests
npm run build
npm run inspect     # MCP Inspector against dist/index.js
```
