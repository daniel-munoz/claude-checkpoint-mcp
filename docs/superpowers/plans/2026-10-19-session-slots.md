# Per-session Checkpoint Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each Claude Code session saves to its own checkpoint file; load returns the session's own checkpoint or, failing that, a list for the user to pick from.

**Architecture:** The session id comes from `CLAUDE_CODE_SESSION_ID`, read once in `index.ts` and passed into `createServer`. Storage functions switch from "a root" to "a file path", so the same atomic read/write/`.prev` logic serves both the legacy `.claude-checkpoint` and `.claude-checkpoints/<id>.json`. A new listing module scans both, and `tools.ts` gains the selector-based load flow, an in-memory adopted checkpoint per root, and a `list_session_checkpoints` tool.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), `@modelcontextprotocol/sdk`, zod 3, vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-10-19-session-slots-design.md`

## Global Constraints

- Slot path: `<root>/.claude-checkpoints/<sessionId>.json`, backup `<sessionId>.json.prev`; files 0600, directory 0700.
- Session id is valid only if it matches `^[A-Za-z0-9_-]{1,128}$`; otherwise treat as absent and warn.
- Selector: a session id, or the literal `legacy` (the `<root>/.claude-checkpoint` file).
- Checkpoint `version` stays `1`; new fields `sessionId` and `resumedFrom` are optional.
- No session id ⇒ saves go to the legacy file, exactly as 0.1.x.
- Default list limit `10`; `limit: 0` means all; newest `updatedAt` first.
- Never return a loaded brief for a non-matching checkpoint without an explicit selector.
- Everything the model needs (brief or list) goes in both text content and `structuredContent`.
- Release version `0.2.0`; `mcpName` and `server.json` unchanged.

## Review Focus

- A selector containing `/`, `..` or other path characters → rejected with a tool error, never resolves outside `.claude-checkpoints/` (test in Task 2).
- `.claude-checkpoints/` holding `.prev`, `.tmp-*` and non-`.json` files → those are not listed as separate entries (test in Task 3).
- A slot whose primary is corrupt but `.prev` is valid → listed with `fromBackup: true`; both unreadable → listed as unreadable with a warning, not dropped (test in Task 3).
- An empty `.claude-checkpoints/` directory and no legacy file → "No checkpoint found", not an empty list (test in Task 4).
- Two servers with different session ids saving in the same folder in parallel → both slots intact and the legacy file untouched (test in Task 5).

---

### Task 0: Set up the worktree

- [ ] **Step 1:** In `/Users/danielm/personal-projects/collab/claude-checkpoint-mcp/session-slots`, run `npm ci`.
- [ ] **Step 2:** Run `npm run typecheck && npm test`. Expected: all existing tests pass. (No commit.)

### Task 1: Session id and schema fields

**Files:**
- Create: `src/session.ts`
- Modify: `src/schema.ts` (Checkpoint object)
- Test: `test/session.test.ts`, `test/store.test.ts`

**Interfaces:**
- Produces: `SESSION_ID_PATTERN: RegExp`; `resolveSessionId(raw: string | undefined): { id: string | null; warning?: string }`; `LEGACY_SELECTOR = "legacy"` (export from `session.ts`); `Checkpoint.sessionId?: string`, `Checkpoint.resumedFrom?: string` (both `z.string().max(128).optional()`).

- [ ] **Step 1: Write failing tests** in `test/session.test.ts`:
  - `resolveSessionId("8ce2c093-d512-42c2-a4d8-aa98280b55df")` → `{ id: "8ce2c093-d512-42c2-a4d8-aa98280b55df" }` with no warning.
  - `resolveSessionId(undefined)` and `resolveSessionId("")` → `{ id: null }` with no warning.
  - `resolveSessionId("../etc")` and `resolveSessionId("a".repeat(129))` → `id: null` and `warning` matching `/CLAUDE_CODE_SESSION_ID/`.
  - `resolveSessionId("legacy")` → `id: null` with a warning (it would collide with the legacy selector).
  - In `test/store.test.ts`: a checkpoint with `sessionId: "s1", resumedFrom: "legacy"` round-trips through `writeCheckpoint`/`readCheckpoint` with both fields intact.
- [ ] **Step 2:** Run `npx vitest run test/session.test.ts test/store.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `src/session.ts` and add the two optional fields to `Checkpoint` in `src/schema.ts`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: resolve session id and add sessionId/resumedFrom to checkpoints`.

### Task 2: File-path based storage

**Files:**
- Modify: `src/store.ts`, `src/tools.ts` (callers only, behavior unchanged)
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `SESSION_ID_PATTERN`, `LEGACY_SELECTOR` (Task 1).
- Produces:
  - `SLOTS_DIRNAME = ".claude-checkpoints"`
  - `selectorPath(root: string, selector: string): string`: legacy → `<root>/.claude-checkpoint`; a valid id → `<root>/.claude-checkpoints/<id>.json`; anything else throws `CheckpointError("unknown checkpoint selector: …")`.
  - `readCheckpoint(file: string): Promise<LoadResult | null>` (was `(root)`), `writeCheckpoint(file: string, cp: Checkpoint): Promise<number>` (was `(root, cp)`), `backupPath(file: string): string` (was `(root)`). `checkpointPath(root)` stays as the legacy path.
  - `writeCheckpoint` creates the parent directory with `mkdir(..., { recursive: true, mode: 0o700 })` before writing.
  - Warning text uses the file's basename (e.g. `8ce2….json is missing; loaded the previous checkpoint from 8ce2….json.prev.`).

- [ ] **Step 1: Write failing tests:**
  - `selectorPath(root, "legacy")` equals `checkpointPath(root)`; `selectorPath(root, "abc-1")` equals `path.join(root, ".claude-checkpoints", "abc-1.json")`.
  - `selectorPath(root, "../x")`, `selectorPath(root, "a/b")` and `selectorPath(root, "")` throw `CheckpointError`.
  - Writing to `selectorPath(root, "s1")` in a fresh dir creates `.claude-checkpoints` with mode `0o700` and the file with `0o600`; a second write leaves a `.prev`.
  - Update the existing write/read tests to pass file paths.
- [ ] **Step 2:** Run `npx vitest run test/store.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement in `src/store.ts`, and update the calls in `src/tools.ts` to pass `checkpointPath(root)`.
- [ ] **Step 4:** Run `npm run typecheck && npm test`. Expected: PASS (e2e unchanged).
- [ ] **Step 5:** Commit: `refactor: address checkpoints by file path; add slot paths`.

### Task 3: Listing

**Files:**
- Create: `src/listing.ts`
- Test: `test/listing.test.ts`

**Interfaces:**
- Consumes: `selectorPath`, `readCheckpoint`, `SLOTS_DIRNAME` (Task 2); `LEGACY_SELECTOR` (Task 1); `formatAge` (`src/render.ts`).
- Produces:
  ```ts
  export interface ListEntry {
    selector: string;
    goal: string | null;          // null when unreadable
    updatedAt: string | null;
    age: string | null;           // formatAge(updatedAt)
    branch: string | null;
    allTasksDone: boolean;        // true only if tasks.length > 0 and all done
    isCurrentSession: boolean;
    fromBackup: boolean;
    resumedFrom?: string;
    unreadable?: string;          // error summary when neither file parses
  }
  export interface Listing { entries: ListEntry[]; total: number; omitted: number; warnings: string[] }
  export function listCheckpoints(root: string, currentSessionId: string | null, limit: number, now?: Date): Promise<Listing>;
  export function renderListing(listing: Listing): string;
  ```
  Candidates: the legacy file (if it or its `.prev` exists) plus every `*.json` in `.claude-checkpoints/` whose stem matches `SESSION_ID_PATTERN`. Sort by `updatedAt` desc, unreadable entries last. `limit` 0 = all; `omitted = total - entries.length`. `renderListing` is a compact markdown list, one line per entry (selector, age, branch, a done mark, goal), ending with "…and N older (call list_session_checkpoints with limit 0)" when `omitted > 0`.

- [ ] **Step 1: Write failing tests** (use `makeCheckpoint` from `test/helpers.ts` with distinct `updatedAt`):
  - Legacy + two slots → three entries newest first; the legacy entry has `selector: "legacy"`; the slot matching `currentSessionId` has `isCurrentSession: true`.
  - `allTasksDone` is `false` with no tasks, `false` with one pending, `true` when all are done.
  - 12 slots with `limit: 10` → 10 entries, `total: 12`, `omitted: 2`; `limit: 0` → 12.
  - `.claude-checkpoints/` containing `s1.json.prev` alone, `s2.json.tmp-1-ab`, `notes.txt` and `s3.json` → entries: `s1` (from `.prev`, `fromBackup: true`) and `s3` only.
  - A slot with both files corrupt → entry with `unreadable` set, sorted last, and one warning.
  - No legacy file and no directory → `{ entries: [], total: 0 }`.
  - `renderListing` output contains each selector and goal, and the "…and 2 older" line when omitted.
- [ ] **Step 2:** Run `npx vitest run test/listing.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/listing.ts`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: list session checkpoints`.

### Task 4: Load flow and the list tool

**Files:**
- Modify: `src/server.ts`, `src/index.ts`, `src/tools.ts`
- Test: `test/e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `createServer(options?: { sessionId?: string | null; sessionWarning?: string }): McpServer`. `index.ts` calls `resolveSessionId(process.env.CLAUDE_CODE_SESSION_ID)` and passes the result; tests pass `sessionId` directly.
  - `registerTools(server, session: { id: string | null; warning?: string })`.
  - `load_session_checkpoint` input adds `checkpoint?: string` ("A selector from list_session_checkpoints: a session id, or 'legacy'."). Output adds `selector?: string`, `candidates?: ListEntry[]`, `total?: number`, `omitted?: number`.
  - New tool `list_session_checkpoints` with input `{ projectRoot?, limit?: number (int ≥ 0, default 10) }`, output `{ path: string /* the root */, entries, total, omitted, warnings, text: string }`, read-only annotations.
  - Adopted state in `tools.ts`: `Map<string /* root */, string /* selector */>`, set when an explicit selector other than the current session's own is loaded.
- Load flow (copy from spec "load_session_checkpoint"): explicit selector → load it; else own slot exists → load; else candidates exist → return list with `found: false`, `candidates`, and text telling the model to show the list to the user, ask which to resume, and call load again with `checkpoint`; else "No checkpoint found". Without a session id: legacy exists → load it; else slots exist → list; else not found. The session warning (if any) is added to every result's warnings.

- [ ] **Step 1: Write failing e2e tests.** Change the `beforeEach` to a helper `connect(sessionId: string | null)` so a test can create clients with different ids; existing tests use `null` and must still pass unchanged.
  - Lists three tools: `list_session_checkpoints`, `load_session_checkpoint`, `save_session_checkpoint`.
  - Session `s1` saves, a fresh `s1` client loads → `found: true`, `selector: "s1"`, `brief` present.
  - Session `s1` saves; session `s2` loads with no selector → `found: false`, `candidates` has exactly one entry with `selector: "s1"`, text and `structuredContent` both contain the goal.
  - `s2` loads with `checkpoint: "s1"` → `found: true`, `selector: "s1"`, brief present.
  - `checkpoint: "nope"` → `isError` with text matching `/list_session_checkpoints/`; `checkpoint: "../x"` → `isError`.
  - Empty `.claude-checkpoints/` dir and no legacy file → `found: false` with no `candidates`.
  - No session id, legacy file present → loads it (as 0.1.x). No session id, only slots → returns the list.
  - `list_session_checkpoints` with `limit: 0` returns all entries; `isCurrentSession` set for the caller's slot.
- [ ] **Step 2:** Run `npx vitest run test/e2e.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3:** Implement. Update `INSTRUCTIONS` in `src/server.ts` and both tool descriptions: checkpoints are per session; if load returns a list, show it to the user and ask before loading one with `checkpoint`; never choose for the user.
- [ ] **Step 4:** Run `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: per-session load flow and list_session_checkpoints`.

### Task 5: Save to the session's slot

**Files:**
- Modify: `src/tools.ts`
- Test: `test/e2e.test.ts`

**Interfaces:**
- Consumes: Task 4 (session, adopted map), Task 2 (`selectorPath`), `isIgnored` (`src/git.ts`).
- Rules (from spec "save_session_checkpoint", "resumedFrom" and the no-session-id bullets):
  - Target: own slot if a session id is known, else the legacy file.
  - Merge base: own target if it exists; else the adopted checkpoint. In no-session-id mode the adopted checkpoint is used only when the legacy file doesn't exist.
  - New slot created while a checkpoint is adopted (either mode) → fresh `id`/`createdAt`, `resumedFrom = adopted selector`. Existing slot → carry its `resumedFrom` on every save, `replace` included. Always write `sessionId` when known.
  - `isCheckpointFile` also matches any path starting with `.claude-checkpoints/`.
  - The not-git-ignored warning checks `.claude-checkpoints/` when saving to a slot (message names that path).

- [ ] **Step 1: Write failing e2e tests:**
  - `s1` save writes `.claude-checkpoints/s1.json` with `sessionId: "s1"`; no `.claude-checkpoint` is created.
  - Legacy file exists, `s1` saves → legacy file bytes unchanged.
  - `s2` loads `checkpoint: "s1"`, then saves `merge` with only `goal` → `s2.json` keeps `s1`'s tasks and `nextSteps`, has `resumedFrom: "s1"` and an `id` different from `s1`'s; `s1.json` unchanged.
  - Same but `replace` → `resumedFrom: "s1"`; a second `replace` save keeps `resumedFrom: "s1"`.
  - No session id: legacy exists, adopted `s1`, merge save → base is the legacy checkpoint (legacy goal tasks kept, `s1`'s not added).
  - Parallel: clients `s1` and `s2` in one repo each run 5 merge saves concurrently → both files parse, each has 5 commands, legacy file absent.
  - Drift: after an `s1` save, loading as `s1` doesn't list `.claude-checkpoints/s1.json` in `changedSince`.
  - In a repo whose `.gitignore` lacks the pattern, an `s1` save warns with text containing `.claude-checkpoints`.
- [ ] **Step 2:** Run `npx vitest run test/e2e.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3:** Implement in `src/tools.ts`.
- [ ] **Step 4:** Run `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: save checkpoints per session with adopted merge base`.

### Task 6: Docs, authorship, version, bundle

**Files:**
- Modify: `README.md`, `LICENSE`, `package.json`, `package-lock.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `plugin/dist/index.js` (tracked bundle; root `dist/` is git-ignored)

- [ ] **Step 1:** README: in "How it works", "Tool reference" (add `checkpoint` to load, add a `list_session_checkpoints` section) and "The `.claude-checkpoint` file" (rename to cover both layouts), document slots, selectors, the no-session-id fallback, and the `/clear` and `--continue` caveats from the spec. Credit the original: "Fork of [tenlean/claude-checkpoint-mcp](https://github.com/tenlean/claude-checkpoint-mcp) by Tenzin." near the top.
- [ ] **Step 2:** `LICENSE`: add `Copyright (c) 2026 Daniel Munoz` on the line after `Copyright (c) 2026 Tenzin`.
- [ ] **Step 3:** Set `author.name` to `Daniel Munoz` in `plugin/.claude-plugin/plugin.json` and in the plugin entry of `.claude-plugin/marketplace.json`.
- [ ] **Step 4:** Bump the version to `0.2.0` in `package.json` (`npm version 0.2.0 --no-git-tag-version`, which updates the lockfile too), `plugin.json` and `marketplace.json`. Leave `server.json` and `mcpName` alone.
- [ ] **Step 5:** Run `npm run typecheck && npm test && npm run build`. Expected: PASS, and `plugin/dist/index.js` rebuilt. Run `claude plugin validate .` and confirm there are no new errors (the existing plugin-name warning is expected).
- [ ] **Step 6:** Commit: `chore: release 0.2.0 with per-session checkpoints`.

### Task 7: Hand-off (user-facing, outside the repo)

- [ ] **Step 1:** Push `session-slots` and open a PR to the fork's `main` (`gh pr create --repo daniel-munoz/claude-checkpoint-mcp --base main`), body referencing `#1` and ending with the attribution line. Ask the user before pushing.
- [ ] **Step 2:** After the user confirms, save a session checkpoint, then back up and update `~/.claude/hooks/checkpoint-nudge.sh` and `~/.claude-personal/hooks/checkpoint-nudge.sh`: fire when `<root>/.claude-checkpoint` exists **or** `<root>/.claude-checkpoints/` holds any `*.json`, with the message: "Session checkpoints exist in <root>. Call load_session_checkpoint; if it returns a list, show it and ask me which to resume, then confirm before acting on its next steps." Test each script with `echo '{"cwd":"<dir>"}' | <script>` for a dir with only slots, only legacy, and neither (no output).
