# Session Argument and Opt-in Id Minting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let callers name their session per call with a `session` argument, and, only when `CHECKPOINT_SESSION_IDS=mint` is set, give clients without any id their own minted checkpoint instead of the shared legacy file (#41).

**Architecture:**
- The session is resolved on every call from the `session` argument, then `CLAUDE_CODE_SESSION_ID`. Nothing is kept in process memory.
- With neither, a save mints a UUID only when the flag is on; otherwise it writes the legacy file exactly as today.
- Resolution lives in `src/session.ts`. `src/tools.ts` calls it at the top of each handler, in place of today's fixed `Session`.

**Tech Stack:** TypeScript (strict), zod 4, `@modelcontextprotocol/sdk` 1.32, vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-10-session-identity-design.md` (issue #20). Rollout step 1 only. #42 runs the experiment and #43 changes the default; both are out of scope.

## Global Constraints

- Claude Code behavior is **unchanged**: when the env var is present and no differing `session` is passed, every result matches today's (no new lines, warnings or list prompts). Every existing test in `test/e2e.test.ts` and `test/nudge.test.ts` must pass unmodified.
- Without the flag, a save with no argument and no env var writes `.claude-checkpoint` as today.
- `session` must match `SESSION_ID_PATTERN` (`/^[A-Za-z0-9_-]{1,128}$/`) and must not be `legacy`.
- Every change to the tool contract is additive: new optional inputs and new optional output fields only. Tool schemas stay strict (#17).
- Minted ids are `randomUUID()` from `node:crypto`.
- The hook bundles (`dist/hook.js`, `dist/guard.js`) must not pull in zod. `src/session.ts` may import only `src/paths.ts` (node built-ins).
- Exact wording fixed by the spec:
  - conflict error: `This server runs for session "<env>"; session: "<arg>" names a different one. To continue another checkpoint, load it and pass its selector as resumedFrom on your next save.`
  - save line, after the first line, when the id came from the argument or was minted: `Pass session: "<id>" on every later checkpoint call in this conversation.`
  - extra merge warning when minted: `If you saved earlier in this conversation, pass the session id that save returned.`
  - new `INSTRUCTIONS` line: `If a save returns a session id, pass it as session on every later checkpoint call in this conversation.`
- No version bump; releasing is separate.

## Review Focus

1. **Env var set and flag on** (a Claude Code user who sets the flag): the env var wins, nothing is minted, results unchanged. Tested in Task 2.
2. **Flag spelled `MINT` or ` mint `**: treated as `mint`. Any other value (`yes`, `on`) means legacy, plus a warning in every result naming the accepted values. Tested in Task 1.
3. **`session` passed with the flag off and no env var**: uses that slot, not the legacy file. The flag gates minting only, not the argument. Tested in Task 2.
4. **`session` equal to the env var**: behaves exactly like the env var alone: `sessionSource: "env"`, no "Pass session" line. Tested in Task 2.
5. **Load with no id, flag on, only a legacy file present**: returns the list containing `legacy`, and does not load it automatically. Tested in Task 3.

---

### Task 1: Per-call session resolution in `src/session.ts`

**Files:**
- Modify: `src/session.ts`
- Test: `test/session.test.ts`

**Interfaces:**
- Produces:
  - `type SessionSource = "argument" | "env" | "minted"`
  - `interface CallSession { id: string | null; source: SessionSource | null }`. `id` is null and `source` is null exactly when no id is known.
  - `resolveCallSession(arg: string | undefined, envId: string | null): CallSession`. Throws `CheckpointError` (from `./paths.js`) for an invalid argument, or one that differs from `envId`.
  - `interface IdMode { mint: boolean; warning?: string }`
  - `resolveIdMode(raw: string | undefined): IdMode`

- [ ] **Step 1: Write the failing tests** in a new `describe("resolveCallSession")` and `describe("resolveIdMode")`:

```ts
expect(resolveCallSession(undefined, "env1")).toEqual({ id: "env1", source: "env" });
expect(resolveCallSession("env1", "env1")).toEqual({ id: "env1", source: "env" });
expect(resolveCallSession("a1", null)).toEqual({ id: "a1", source: "argument" });
expect(resolveCallSession(undefined, null)).toEqual({ id: null, source: null });
expect(() => resolveCallSession("other", "env1")).toThrow('This server runs for session "env1"; session: "other" names a different one.');
for (const bad of ["legacy", "../x", "a b", "", "x".repeat(129)]) expect(() => resolveCallSession(bad, null)).toThrow(CheckpointError);

expect(resolveIdMode(undefined)).toEqual({ mint: false });
expect(resolveIdMode("")).toEqual({ mint: false });
expect(resolveIdMode("legacy")).toEqual({ mint: false });
expect(resolveIdMode(" MINT ")).toEqual({ mint: true });
expect(resolveIdMode("yes")).toEqual({ mint: false, warning: expect.stringContaining('CHECKPOINT_SESSION_IDS must be "mint" or "legacy"') });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL. `resolveCallSession` and `resolveIdMode` are not exported.

- [ ] **Step 3: Implement both functions in `src/session.ts`**

- An invalid argument throws with `session must be a session id (letters, digits, "-" and "_", up to 128), not ${JSON.stringify(arg)}`.
- `resolveIdMode` trims and lowercases its input. Its warning is exactly `CHECKPOINT_SESSION_IDS must be "mint" or "legacy"; got ${JSON.stringify(raw)}. Using legacy.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/session.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/session.ts test/session.test.ts
git commit -m "feat: resolve the calling session per call"
```

### Task 2: `session` on save, minting behind the flag

**Files:**
- Modify:
  - `src/index.ts` (read `CHECKPOINT_SESSION_IDS`)
  - `src/server.ts` (`ServerOptions`, `INSTRUCTIONS`)
  - `src/tools.ts` (`Session` → config; `save`, `saveBase`, `identity`, `warnIfNotIgnored`, `saveResult`)
  - `src/toolSchemas.ts` (`saveInput`, `saveOutput`, `saveTool.description`)
  - `server.json` (declare the env var)
- Test: create `test/session-identity.test.ts`

**Interfaces:**
- Consumes: Task 1's `resolveCallSession`, `resolveIdMode`, `CallSession`.
- Produces:
  - `ServerOptions` gains `mintSessionIds?: boolean` (default false).
  - `index.ts` joins the `resolveSessionId` and `resolveIdMode` warnings with a space into `sessionWarning`.
  - The server-wide config in `tools.ts` becomes `interface SessionConfig { envId: string | null; mint: boolean; warning?: string }`. Each handler resolves `CallSession` at its start; the save handler mints when `id === null && config.mint`.
  - Save input: `session?: string`, described as `This conversation's session id, as returned by an earlier save. Omit on Claude Code. Not for picking a checkpoint to read: use load_session_checkpoint's checkpoint, then resumedFrom.`
  - Save output (text and `structuredContent`): `session?: string` and `sessionSource?: SessionSource`. Both are omitted when the save wrote the legacy file.

- [ ] **Step 1: Write the failing tests** in `test/session-identity.test.ts`

Copy the `connect`/`callAs` helpers from `test/e2e.test.ts`, with `connect(sessionId: string | null, mint = false)` passing `{ sessionId, mintSessionIds: mint }`. Use `tempDir()` roots and `projectRoot` on every call. The tests:

  - `mints an id on the first save when the flag is on, and saves to it`: `data.sessionSource === "minted"`; `data.session` matches the UUID regex; `selectorPath(dir, data.session)` exists; `.claude-checkpoint` doesn't; the text contains `Pass session: "${data.session}" on every later checkpoint call`.
  - `merges into the minted checkpoint when the id is passed back`: second save `{ session: id, mode: "merge", decisions: ["d2"] }` after a first with `decisions: ["d1"]`. The file has both decisions, and there's still exactly one file in `.claude-checkpoints`.
  - `warns about a lost id on a minted merge save, and starts a second checkpoint`: a first save, then a second with `mode: "merge"` and no session. The second save's warnings include `If you saved earlier in this conversation, pass the session id that save returned.` Its `session` differs from the first, and `.claude-checkpoints` holds two files, with the first unchanged.
  - `keeps writing the legacy file without the flag`: `connect(null)`; `data.session` and `data.sessionSource` are undefined; `.claude-checkpoint` exists; no `.claude-checkpoints` directory.
  - `uses a passed session without the flag` (Review Focus 3): `connect(null)`, `session: "a1"`; the file is at `selectorPath(dir, "a1")`; `sessionSource === "argument"`; the text has the "Pass session" line.
  - `lets the env var win over the flag` (Review Focus 1): `connect("env1", true)`; `sessionSource === "env"`; the file is at `selectorPath(dir, "env1")`; the text has no `Pass session`.
  - `treats a session equal to the env var as the env var` (Review Focus 4): `connect("env1")`, `session: "env1"`; `sessionSource === "env"`; no "Pass session" line.
  - `rejects a session that differs from the env var and writes nothing`: `connect("env1")`, `session: "other"`; `result.isError`; the text contains `names a different one`; `.claude-checkpoints` doesn't exist.
  - `rejects an invalid session and writes nothing`: `session: "legacy"` and `session: "../x"`; `result.isError`; nothing on disk.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/session-identity.test.ts`
Expected: FAIL. `session` is rejected as an unknown key (strict schema), and nothing is minted.

- [ ] **Step 3: Implement**

- Thread `SessionConfig` through `registerTools`.
- `saveBase`, `identity`, `warnIfNotIgnored` and the merge warning take the resolved `CallSession` instead of `session.id`.
- `saveResult` adds the "Pass session" line when the source is `argument` or `minted`.
- Add the Global Constraints `INSTRUCTIONS` line in `server.ts`.
- Add a `CHECKPOINT_SESSION_IDS` entry to `server.json`: `"Optional. Set to mint to give clients without a session id their own checkpoint per conversation (the server mints an id on the first save and the agent passes it back). Unset or legacy: such clients share .claude-checkpoint. Experimental."`
- In `saveTool.description`, change `or .claude-checkpoint when the client provides no session id` to `or .claude-checkpoint when there is no session id`.

- [ ] **Step 4: Run all tests**

Run: `npm run typecheck && npm test`
Expected: PASS. That includes `test/metadata.test.ts` (it fails if `server.json` lacks the env var) and every existing e2e test, unmodified.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/server.ts src/tools.ts src/toolSchemas.ts server.json test/session-identity.test.ts
git commit -m "feat: accept a session argument on save and mint ids behind CHECKPOINT_SESSION_IDS"
```

### Task 3: `session` on load and list

**Files:**
- Modify: `src/tools.ts` (`load`, `list`, `candidates`, `loaded`), `src/toolSchemas.ts` (`loadInput`, `listInput`, `loadOutput`, `listOutput`)
- Test: `test/session-identity.test.ts`

**Interfaces:**
- Consumes: Task 2's `SessionConfig` and the per-call `CallSession`.
- Produces:
  - Load and list inputs: `session?: string`, with the same description as save's.
  - Load output: `session?: string`, the caller's own id, omitted when there is none.
  - The own selector for load becomes `call.id ?? (config.mint ? null : LEGACY_SELECTOR)`. When it is null, there is no direct load: return the list if any checkpoints exist, else "No checkpoint found". Use `path.join(root, SLOTS_DIRNAME)` as `path`.
  - `listCheckpoints(root, call.id, ...)` marks `isCurrentSession`.
  - With `config.mint` and no id, the load and list texts end with: `This client has no session id: your first save will return one; pass it as session on every later checkpoint call.`

- [ ] **Step 1: Write the failing tests** in `test/session-identity.test.ts`, seeding files as `seed()` in `test/e2e.test.ts` does:

  - `loads the passed session's own checkpoint`: seed `a1`; `connect(null)`; load `{ session: "a1" }` gives `found: true`, `selector: "a1"`, `session: "a1"`.
  - `lists instead of auto-loading the legacy file when minting` (Review Focus 5): seed `legacy` only; `connect(null, true)`; load `{}` gives `found: false`, `candidates[0].selector === "legacy"`, and the text contains `This client has no session id`.
  - `still auto-loads the legacy file without the flag`: same seed, `connect(null)`, gives `found: true`, `selector: "legacy"`.
  - `marks the passed session as current in the list`: seed `a1` and `b2`; list `{ session: "b2" }`; only the `b2` entry has `isCurrentSession: true`.
  - `rejects a conflicting session on load and list`: `connect("env1")`; both calls with `session: "other"` return `isError`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/session-identity.test.ts`
Expected: the five new tests FAIL; Task 2's still pass.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run all tests**

Run: `npm run typecheck && npm test`
Expected: PASS, existing tests unmodified.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/toolSchemas.ts test/session-identity.test.ts
git commit -m "feat: accept a session argument on load and list"
```

### Task 4: Docs, bundle, and end-to-end check

**Files:**
- Modify:
  - `README.md`:
    - the "One checkpoint per session" section (around line 105)
    - the env var table (line ~158)
    - the tool reference argument tables for save, load and list (lines ~362, ~440, ~483)
    - the Troubleshooting table
  - `plugin/dist/index.js` (rebuilt)

- [ ] **Step 1: Update the README**

  - **Env var table:** a `CHECKPOINT_SESSION_IDS` row (who sets it: you, optional; default: unset, meaning legacy), marked experimental with a link to #42.
  - **"One checkpoint per session":** a short paragraph on clients without a session id:
    - today they share `.claude-checkpoint`
    - with `CHECKPOINT_SESSION_IDS=mint`, the first save returns an id that the agent passes back as `session`
    - a lost id produces a new checkpoint, never an overwrite
  - **Argument tables:** a `session` row in all three.
  - **Save output:** document `session` and `sessionSource`.
  - **Troubleshooting:**
    - `session ... names a different one`: you passed a selector as `session`. Use `checkpoint` to read and `resumedFrom` to continue.
    - With the flag on, many small checkpoints: the agent isn't passing `session` back.

- [ ] **Step 2: Rebuild and run every check**

Run: `npm run build && npm run typecheck && npm test && node scripts/hook-smoke.mjs && claude plugin validate .`
Expected:
- everything passes
- `git status` shows `plugin/dist/index.js` changed
- `plugin/dist/hook.js` and `plugin/dist/guard.js` are unchanged (`session.ts` is in the hook bundle via `nudge.ts`; if they changed, check they didn't grow past 20 KB)

- [ ] **Step 3: Manual check over stdio** (no Claude Code needed)

Run the built server with `env -u CLAUDE_CODE_SESSION_ID CHECKPOINT_SESSION_IDS=mint node dist/index.js`, driven by a short `@modelcontextprotocol/sdk` client script in the scratchpad (not committed). Make three calls:
1. save with no session
2. save with the returned session and `mode: "merge"`
3. load with that session

Expected: one slot file, the merged content, and `found: true`.

- [ ] **Step 4: Note on #26** (its contract test isn't written yet): comment on #26 that the test must also cover `session` on all three inputs and `session`/`sessionSource` on the save output.

- [ ] **Step 5: Commit, push, and open a PR** that closes #41 (milestone v1.0.0). The PR body points to #42 as the next step.

```bash
git add README.md plugin/dist/index.js
git commit -m "docs: document the session argument and CHECKPOINT_SESSION_IDS"
```
