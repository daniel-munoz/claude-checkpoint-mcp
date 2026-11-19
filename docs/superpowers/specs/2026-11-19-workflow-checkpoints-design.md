# Workflow checkpoints (1.1.0)

Issue: daniel-munoz/claude-checkpoint-mcp#55. Requested by the control-room runner (its
`contracts/checkpoint-v2.md`, research R8), which recovers a crashed workflow step from the run's
latest checkpoint. Approach approved by the owner on 2026-11-19.

## Why

A workflow engine starts Claude sessions as the steps of one run. When a step's session dies, the
engine starts a fresh session and needs the run's newest checkpoint, whichever session wrote it.
Today a checkpoint only knows its session, so nothing ties the sessions of one run together.

## Goals

- A checkpoint can carry the workflow run it belongs to and the step that wrote it.
- Load the newest checkpoint of a workflow across sessions, and list a workflow's checkpoints.
- Approval payloads never land in a checkpoint, and JWTs are redacted.
- Semver-minor: everything the README's Compatibility section covers keeps working.

## Non-goals

- No workflow engine inside the server; it only records and filters by the id it is given.
- No migration of existing files.

## Approaches

1. **Data `version: 2` in `.claude-checkpoints/<workflowId>/<sessionId>.json`** (the control
   room's first contract). Rejected: 1.0.0 refuses any version but 1, and the README calls writing
   a file the previous 1.x can't read a breaking change. 1.x listing would also miss subfolders.
2. **A new `list_by_workflow` tool.** Rejected: an optional `workflowId` input on the existing
   list and load tools does the same with no new tool, and new optional inputs are allowed in a
   minor release.
3. **Chosen: two optional fields in `version: 1`, flat files, optional inputs.** 1.0.0 parses the
   file (zod drops keys it doesn't know), so files stay readable both ways; a 1.0.0 save over one
   drops the two fields, which is acceptable.

## Design

- **Fields.** `workflowId?: string` (1–128 of `[A-Za-z0-9_.:-]`) and `step?: string` (1–64 of the
  same) on the checkpoint, written only when set. Inputs are checked against the pattern; stored
  values only by length, so a later 1.x can widen the pattern (review, 2026-11-19).
- **Save.** Optional `workflowId` and `step` inputs. Each falls back to `CHECKPOINT_WORKFLOW_ID` /
  `CHECKPOINT_WORKFLOW_STEP`, then to the checkpoint being continued (the session's own, or the one named by `resumedFrom`,
  in either mode). An
  invalid env value is ignored with a warning, like `CLAUDE_CODE_SESSION_ID`; an invalid argument
  is an error.
- **Load.** Optional `workflowId` input: the newest readable checkpoint whose `workflowId`
  matches, from any session, loaded like an explicit `checkpoint` (with the `resumedFrom` hint
  when it isn't the caller's own). None found: `found: false`. `workflowId` and `checkpoint`
  together are an error.
- **List.** Optional `workflowId` input filters the entries. Every entry gains optional
  `workflowId` and `step` output fields, and the text line shows them.
- **Guard.** A new redaction rule for JWTs (`eyJ…` header, payload and signature segments). A
  workflow save (one that resolves a `workflowId`) whose text contains an approval payload key —
  `"boundCalls"`, `"idToken"` or `"attestation"`, quotes optionally escaped, followed by `:` — is
  refused with an error naming the field; nothing is written. Outside a workflow the refusal would
  narrow inputs 1.0 accepts, which the Compatibility section calls breaking, so those saves are
  unchanged (review, 2026-11-19).
- **Docs and release.** README (tools, environment variables, Compatibility list), CHANGELOG
  1.1.0, the pinned tool-contract test, version 1.1.0 in the package, server and plugin manifests.
  Publishing (npm, registry) stays with the owner.

## Left to the builder

Helper names, where the payload check lives (beside the redactor is natural), and the exact
wording of errors and warnings (not covered by semver).
