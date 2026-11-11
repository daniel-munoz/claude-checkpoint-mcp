# Changelog

All notable changes to `session-checkpoint-mcp` (the npm package, MCP registry entry `io.github.daniel-munoz/claude-checkpoint-mcp`, and the `session-checkpoint` Claude Code plugin). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). From 1.0.0 the project follows [Semantic Versioning](https://semver.org/); the [compatibility section](README.md#compatibility) of the README says what that covers.

## [1.0.0] - 2026-11-11

The first stable release. The tool contract, the checkpoint files, the environment variables and the plugin's hooks are now covered by semver (see [Compatibility](README.md#compatibility)).

### Changed

- **Clients without a session id get their own checkpoint per conversation by default** ([#43](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/43)). This is the one behavior change from 0.x. A client that doesn't set `CLAUDE_CODE_SESSION_ID` (e.g. Claude Desktop):
  - Its first save mints a session id, writes `.claude-checkpoints/<id>.json`, and returns the id. The agent passes it back as `session`.
  - A load with no id lists the checkpoints instead of opening `.claude-checkpoint`.
  - `CHECKPOINT_SESSION_IDS=legacy` keeps the 0.x behavior: one shared `.claude-checkpoint`.
  - Claude Code is unaffected.
  - In testing ([#42](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/42)), Opus, Sonnet and Haiku passed the id back on every save, including after compaction.
- An unknown `CHECKPOINT_SESSION_IDS` value now falls back to `mint` (it was `legacy`), with a warning.

### Fixed

- After compaction, a load with no session id told an agent that had already saved that it had no id, so it could start a duplicate checkpoint. The note now points it to its own id ([#47](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/47)).
- The plugin's bundles are marked as ES modules (`plugin/dist/package.json`) ([#46](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/46)):
  - On Node versions without module syntax detection (e.g. 20.10), the plugin's hooks and MCP server failed to load at all.
  - On newer Node, a stray `package.json` above the plugin folder caused a `MODULE_TYPELESS_PACKAGE_JSON` warning on every run.

### Added

- A contract test that pins what clients receive from `tools/list`: annotations, the exact input and output fields, and which are required ([#26](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/26)).
- CI audits runtime dependencies on every PR and weekly ([#33](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/33)).
- This changelog and the README's compatibility section ([#39](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/39)).

## [0.6.0] - 2026-11-10

### Added

- **A `session` argument** on all three tools ([#41](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/41)):
  - On every call, the server takes the session from that argument first, then from `CLAUDE_CODE_SESSION_ID`.
  - An argument that differs from the env var is an error. It almost always means a checkpoint selector went into the wrong argument.
  - Saves return `session` and `sessionSource` (`env`, `argument` or `minted`). Loads return `session`.
- **`CHECKPOINT_SESSION_IDS=mint`** (opt-in in this release): clients without a session id get a minted per-conversation checkpoint.
- **The plugin's subagent save guard**, a `PreToolUse` hook (`dist/guard.js`) ([#38](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/38)):
  - It blocks subagents from saving over the parent session's checkpoint. Subagents share the parent's server and session id.
  - Main-session saves, and all loads and lists, are unaffected.

## [0.5.0] - 2026-11-10

### Fixed

- Resuming another session's checkpoint survives a server restart between the load and the save ([#18](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/18)). The save now names the checkpoint it continues from, as `resumedFrom`, instead of the server remembering the load in memory.

## [0.4.0] - 2026-11-08

### Added

- The plugin ships its SessionStart nudge hook: when a project has checkpoints, it tells Claude to load one and confirm with you before acting on it ([#21](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/21)). Turn it off with `SESSION_CHECKPOINT_NUDGE=off`.
  - If you copied your own `checkpoint-nudge.sh` hook earlier, remove it, or you'll get the nudge twice.

## [0.3.3] - 2026-11-06

### Security

- Bumped `@modelcontextprotocol/sdk` to 1.32.2 and its vulnerable transitive dependencies (`body-parser`, `fast-uri`, `ip-address`, `qs`) ([#29](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/29)).

## [0.3.2] - 2026-11-05

### Changed

- Publishing goes through npm trusted publishing only. The publish workflow can be rerun to finish a release that failed partway.

## [0.3.1] - 2026-11-05

### Added

- Published to npm as `session-checkpoint-mcp`, and to the MCP registry as `io.github.daniel-munoz/claude-checkpoint-mcp`.
- `CHECKPOINT_PROJECT_ROOT` and `CLAUDE_CODE_SESSION_ID` are documented.

### Fixed

- Unknown tool arguments are rejected instead of silently stripped ([#17](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/17)). Before, a misnamed field could wipe a checkpoint in `replace` mode.

### Security

- Upgraded zod to v4 (GHSA-mrhx-c7xc-m3w5), and checkpoint files over 1 MB are rejected unread ([#25](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/25)).

## [0.3.0] - 2026-10-22

### Changed

- **Breaking:** the plugin was renamed from `claude-checkpoint-mcp` to `session-checkpoint`, because Claude Code reserves the `claude-` prefix ([#7](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/7)). Reinstall it under the new name, and update allowlists that use the old `mcp__plugin_claude-checkpoint-mcp_*` tool names.

## [0.2.0] - 2026-10-20

### Added

- One checkpoint per Claude Code session (`.claude-checkpoints/<session-id>.json`), so sessions sharing a folder no longer overwrite each other ([#1](https://github.com/daniel-munoz/claude-checkpoint-mcp/issues/1)).
- `list_session_checkpoints`, and choosing which checkpoint to resume.

[1.0.0]: https://github.com/daniel-munoz/claude-checkpoint-mcp/compare/v0.6.0...v1.0.0
[0.6.0]: https://github.com/daniel-munoz/claude-checkpoint-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/daniel-munoz/claude-checkpoint-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/daniel-munoz/claude-checkpoint-mcp/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/daniel-munoz/claude-checkpoint-mcp/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/daniel-munoz/claude-checkpoint-mcp/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/daniel-munoz/claude-checkpoint-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/daniel-munoz/claude-checkpoint-mcp/commit/288ccbe
[0.2.0]: https://github.com/daniel-munoz/claude-checkpoint-mcp/pull/6
