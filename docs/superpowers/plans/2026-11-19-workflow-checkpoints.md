# Workflow Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Checkpoints can carry a workflow run id and step; load and list can select by workflow; approval payloads are refused and JWTs redacted — as semver-minor 1.1.0.

**Architecture:** Two optional fields in the existing `version: 1` schema, flat slot files unchanged. Save resolves them from argument, then env (`CHECKPOINT_WORKFLOW_ID` / `CHECKPOINT_WORKFLOW_STEP`, read once at startup like the session id), then the checkpoint being continued. Load/list filter the existing listing by `workflowId`.

**Tech Stack:** TypeScript (Node ≥20, ESM), zod 4, @modelcontextprotocol/sdk 1.32, vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-workflow-checkpoints-design.md` (issue #55)

## Global Constraints

- Data stays `version: 1` (`CHECKPOINT_VERSION` unchanged); files stay `.claude-checkpoints/<session>.json`.
- Everything in README "Compatibility" keeps working; only optional inputs and output fields are added.
- `workflowId`: 1–128 chars of `[A-Za-z0-9_.:-]`; `step`: 1–64 chars of the same set.
- Env names exactly `CHECKPOINT_WORKFLOW_ID`, `CHECKPOINT_WORKFLOW_STEP`.
- Refused payload keys exactly `"boundCalls"`, `"idToken"`, `"attestation"` followed (optional spaces) by `:`.
- Tool inputs stay strict objects (#17); no network calls; nothing written when a save is refused.
- Version 1.1.0 in `package.json`, `server.json` (both), `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.

## Review Focus

1. A file written by 1.0.0 (no workflow fields) still loads and lists, and a merge save onto it works — pinned in Task 1.
2. A merge save (or `resumedFrom` save) with no workflow input keeps the base checkpoint's `workflowId`/`step` — pinned in Task 2.
3. A payload key hidden in a nested field (a task description, a command note, a modifiedFiles note) is refused and nothing is written, not even `.prev` — pinned in Task 3.
4. Load by workflow when the newest matching file is unreadable falls back to the next readable match — pinned in Task 4.
5. `workflowId` together with `checkpoint` on load is an error, not a silent pick — pinned in Task 4.

---

### Task 1: Schema fields and workflow env

**Files:**
- Create: `src/workflow.ts`
- Modify: `src/schema.ts` (Checkpoint object), `src/server.ts` (ServerOptions, config), `src/tools.ts:36-43` (SessionConfig), `src/index.ts`
- Test: `test/workflow.test.ts`

**Interfaces:**
- Produces: `WORKFLOW_ID_PATTERN: RegExp`, `STEP_PATTERN: RegExp`, `resolveWorkflowEnv(id: string | undefined, step: string | undefined): { workflowId: string | null; step: string | null; warning?: string }` in `src/workflow.ts`; `ServerOptions.workflowId?: string | null`, `ServerOptions.workflowStep?: string | null`; `SessionConfig.workflow: { workflowId: string | null; step: string | null }`; Checkpoint gains `workflowId?: string`, `step?: string` (zod `.regex(...)`, optional).

- [ ] **Step 1: Write failing tests** in `test/workflow.test.ts`:
  - `resolveWorkflowEnv("run-1", "work")` → `{ workflowId: "run-1", step: "work" }`, no warning; `(undefined, undefined)` → both null; `("bad id!", "work")` → `workflowId: null` and a warning naming `CHECKPOINT_WORKFLOW_ID`; empty strings → null, no warning.
  - `parseCheckpoint(makeCheckpoint())` (no fields, as 1.0.0 writes) parses; `parseCheckpoint({...makeCheckpoint(), workflowId: "01a1f46f-41b3", step: "work"})` keeps both; `workflowId: "a/b"` throws.
- [ ] **Step 2:** `npx vitest run test/workflow.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `src/workflow.ts` (no zod import, like `paths.ts`), the two schema fields, `ServerOptions` → `SessionConfig.workflow` in `createServer` (warning joins `config.warning`), and `index.ts` reading the two env vars through `resolveWorkflowEnv`.
- [ ] **Step 4:** `npx vitest run` — Expected: all pass.
- [ ] **Step 5:** Commit `feat: workflowId and step on checkpoints, from CHECKPOINT_WORKFLOW_ID/STEP (#55)`.

### Task 2: Save records the workflow

**Files:**
- Modify: `src/toolSchemas.ts` (saveInput), `src/tools.ts` (`identity`, `buildCheckpoint`)
- Test: `test/workflow-tools.test.ts` (client on `createServer`, as in `test/session-identity.test.ts`)

**Interfaces:**
- Consumes: Task 1's patterns and `SessionConfig.workflow`.
- Produces: save inputs `workflowId?: string`, `step?: string` (zod regex, max per Global Constraints). Resolution per field: argument ?? `config.workflow` ?? `target.previous?.checkpoint` (only when continuing or resuming) ?? absent.

- [ ] **Step 1: Write failing tests:**
  - `it("records the workflow from its arguments")`: save `{goal, workflowId: "run-1", step: "analyse"}` → file JSON has `workflowId: "run-1"`, `step: "analyse"`, `version: 1`.
  - `it("falls back to the environment, and an argument wins")`: server with `workflowId: "run-env", workflowStep: "work"`; save without → env values; save with `step: "groom"` → `step: "groom"`, `workflowId: "run-env"`.
  - `it("keeps the base's workflow on a merge save")`: save with workflow, then `mode: "merge"` save without → fields unchanged (Review Focus 2); same via `resumedFrom` from another session's checkpoint.
  - `it("merges onto a 1.0.0 file")`: write `serialize(makeCheckpoint({sessionId: S}))` at `selectorPath(root, S)`, merge save as S with `workflowId` → succeeds with the field (Review Focus 1).
  - `it("rejects an invalid workflowId argument")`: `workflowId: "a b"` → tool error, no file.
  - `it("writes no workflow fields when none are given")`: plain save → JSON has neither key.
- [ ] **Step 2:** `npx vitest run test/workflow-tools.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Add the inputs and the resolution in `identity()`; write a key only when its value is set.
- [ ] **Step 4:** `npx vitest run` — Expected: pass except `test/contract.test.ts` (Task 5 updates it).
- [ ] **Step 5:** Commit `feat: save records workflowId and step (#55)`.

### Task 3: Payload guard and JWT redaction

**Files:**
- Modify: `src/redact.ts` (RULES, new export), `src/tools.ts` (`save`, before `saveBase`)
- Test: `test/redact.test.ts`, `test/workflow-tools.test.ts`

**Interfaces:**
- Produces: `findApprovalPayload(texts: Iterable<[field: string, text: string]>): string | null` in `src/redact.ts` — the first field whose text matches `/"(boundCalls|idToken|attestation)"\s*:/`; a JWT rule `/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g` → `«redacted»`.

- [ ] **Step 1: Write failing tests:**
  - redact: a 3-segment `eyJhbGciOi….eyJzdWIi….sig…` in prose is replaced and counted once; `eyJ` alone or two segments untouched.
  - tools: `it.each(["goal","summary","tasks","nextSteps","decisions","recentCommands.note","recentCommands.command","modifiedFiles.note"])("refuses an approval payload in %s")` with text `{"boundCalls": {"Claim": []}}` → `isError`, message names the field, and neither the slot nor its `.prev` exists (Review Focus 3); `"idToken" :` and `"attestation":` also refused; prose `boundCalls are bound` saves fine.
- [ ] **Step 2:** `npx vitest run test/redact.test.ts test/workflow-tools.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Add the rule and `findApprovalPayload`; in `save`, collect every incoming string with its field path and throw `CheckpointError` naming the field before any read or write.
- [ ] **Step 4:** `npx vitest run` — Expected: pass except contract.
- [ ] **Step 5:** Commit `feat: refuse approval payloads and redact JWTs in checkpoints (#55)`.

### Task 4: Load and list by workflow

**Files:**
- Modify: `src/listing.ts` (`ListEntry`, `entryFor`, `listCheckpoints`, `renderListing`), `src/toolSchemas.ts` (loadInput, listInput, listEntryOutput), `src/tools.ts` (`load`, `list`)
- Test: `test/workflow-tools.test.ts`, `test/listing.test.ts`

**Interfaces:**
- Consumes: Task 1's fields.
- Produces: `listCheckpoints(root, currentSessionId, limit, now?, workflowId?: string)` filters to matching readable entries (unreadable ones are left out when filtering); `ListEntry.workflowId?`, `ListEntry.step?`; inputs `load.workflowId?`, `list.workflowId?`.

- [ ] **Step 1: Write failing tests:**
  - list: three sessions, two in `run-1` (steps `analyse`, `work`) and one in `run-2` → `workflowId: "run-1"` returns the two, newest first, each with `workflowId` and `step`; unfiltered list shows all three; text line includes `` workflow `run-1` · step `work` ``.
  - load: `workflowId: "run-1"` returns the newer `run-1` checkpoint with `selector` its session and a `resumeHint` naming it; corrupt the newest `run-1` file and its `.prev` → returns the older one (Review Focus 4); `workflowId: "none"` → `found: false`; `workflowId` with `checkpoint` → tool error (Review Focus 5); invalid `workflowId` → tool error.
- [ ] **Step 2:** `npx vitest run test/workflow-tools.test.ts test/listing.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement the filter and fields; `load` with `workflowId` picks `listing.entries[0]` (limit 0, filtered) and goes through `loaded()` like an explicit `checkpoint`.
- [ ] **Step 4:** `npx vitest run` — Expected: pass except contract.
- [ ] **Step 5:** Commit `feat: load and list checkpoints by workflowId (#55)`.

### Task 5: Contract, docs and 1.1.0

**Files:**
- Modify: `test/contract.test.ts` (CONTRACT lists), `README.md` (tools, environment variables, Compatibility env list, Security & privacy redaction list), `CHANGELOG.md` (`## [1.1.0] - 2026-11-19`, Added), `src/server.ts` (one instructions line on workflows), version files per Global Constraints, `plugin/dist/*` via `npm run build`
- Test: `test/contract.test.ts`, `test/plugin-packaging.test.ts`

- [ ] **Step 1:** Update CONTRACT: save input adds `step`, `workflowId`; load input adds `workflowId`; list input adds `workflowId`. Add a test that `listEntryOutput` advertises optional `workflowId` and `step` (through load's `candidates` items / list `entries` items schema).
- [ ] **Step 2:** `npx vitest run test/contract.test.ts` — Expected: PASS with the updated lists (it failed after Task 2).
- [ ] **Step 3:** Docs, CHANGELOG, versions, `npm run build`.
- [ ] **Step 4:** `npm run typecheck && npm test && npm run build` — Expected: all green, `plugin/dist` rebuilt, versions 1.1.0 everywhere (`grep -rn '"1.0.0"' package.json server.json plugin/.claude-plugin .claude-plugin` → nothing).
- [ ] **Step 5:** Commit `release: 1.1.0, workflow checkpoints (#55)`.
