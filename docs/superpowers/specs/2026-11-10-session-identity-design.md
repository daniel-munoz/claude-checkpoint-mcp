# Session identity with or without hooks

Issue: daniel-munoz/claude-checkpoint-mcp#20 (milestone v1.0.0). Builds on
`2026-10-19-session-slots-design.md`. Feeds #11, #19 and #39.

Drafted from the issue and the code, without a Q&A round. The calls marked **(author's call)**
were made by the author and still need the user's review.

## Why

Today the server knows which session is calling only through `CLAUDE_CODE_SESSION_ID`. It reads
that once at startup (`src/index.ts:14`) and applies it to every call the process serves. That
causes three problems:

- **Other clients share one file.** Without the env var, every save goes to the single legacy
  `.claude-checkpoint`. Two Claude Desktop conversations in the same folder overwrite each other.
  This is the exact failure #1 fixed for Claude Code.
- **It ties the session to the process.** MCP 2026-07-28 says state spanning requests "MUST be
  referenced by an explicit identifier the client passes on each request", and that clients
  "SHOULD NOT" tie stdio process lifetime to a conversation. A client that keeps one server
  process for several conversations would put all of them in one checkpoint.
- **Subagents look like their parent.** That's #11; its 1.0 guard is #38.

The 1.0 question this doc has to answer: **can session identity be added in 1.x without breaking
the contract?** Short answer: the new argument and output field are purely additive. Changing what
a client *without* an id gets is a behavior change, so it either lands before 1.0 or not until
2.0. This doc recommends landing it before 1.0, gated on a quick experiment (see "Rollout").

## Goals

1. Works with no hook and no env var, on any MCP client.
2. A hook or env var can improve the result, but is never required.
3. Sessions sharing a directory can't overwrite each other by accident.
4. Survives a server restart, `/clear` and compaction, or fails with a clear next step.
5. Existing checkpoint files stay readable, and clients that send no id keep working.

## Non-goals

- Changing Claude Code's behavior. With the env var present, every call works exactly as today.
- Subagent task records (#11). They get their own key, not a session id (see "Subagents").
- Cleaning up old or duplicate checkpoints.
- Authentication. The server trusts its caller; this is about preventing *mistakes*, not hostile
  agents.

## Anti-goals (failure even if it works)

- A save landing in another session's checkpoint because the agent passed the wrong id.
- Claude Code users seeing any new friction (lists, prompts, warnings) when nothing changed for them.
- A no-id client silently creating a new checkpoint file on every save because the agent never
  passes the id back. Duplicates aren't data loss, but a pile of them is a failure.

## Design

### Where the session id comes from

Resolved per call, in this order:

1. **The `session` argument**, if given. It must match `SESSION_ID_PATTERN` and not be `legacy`,
   or the call fails with a tool error.
2. **The `CLAUDE_CODE_SESSION_ID` env var**, as today.
3. **Neither:**
   - **Save** mints a new id (`randomUUID()`, which fits the pattern) and returns it.
   - **Load and list** run with no own session: nothing is loaded directly and `isCurrentSession`
     is false everywhere. That gives the list, as in step 3 of the slots design's load flow.

Nothing is kept in process memory. The id is either configuration (the env var) or sent on every
call (the argument), so a restart can't lose it. This follows the #18 rule: no per-process state
links calls.

### Conflict rule: an argument that disagrees with the env var is an error (author's call)

If both are present and differ, the call fails:

> This server runs for session `<env>`; `session: "<arg>"` names a different one. To continue
> another checkpoint, load it and pass its selector as `resumedFrom` on your next save.

Why fail instead of honoring the argument and warning:

- On Claude Code nothing tells the agent to pass `session`. A mismatch almost certainly means it
  copied a selector from a listing into the wrong argument, and honoring that is exactly the
  "write into another session" anti-goal.
- **Loosening later is additive, tightening is not.** If a hook-supplied id is wanted later (see
  "Hook"), turning this error into a success is allowed in a 1.x minor release. The reverse
  would need 2.0.

The same argument and env var together (the agent echoing the id back) is fine and changes nothing.

### Tool changes

All of these are additive under the #39 contract: a new optional input and new output fields.

| Tool | Input | Output (text and `structuredContent`) |
|---|---|---|
| `save_session_checkpoint` | `session?: string` | `session`: the id the save used; `sessionSource`: `"argument" \| "env" \| "minted"` |
| `load_session_checkpoint` | `session?: string` | `session`: the caller's own id, or omitted if none |
| `list_session_checkpoints` | `session?: string` | unchanged; `isCurrentSession` uses the resolved id |

`resumedFrom`, `checkpoint` and `projectRoot` keep their meaning. `session` means "who I am",
`checkpoint` means "what to read", and `resumedFrom` means "what I started from". The tool
descriptions spell this out, since mixing them up is the main way agents get it wrong.

**Save result text when the id was minted or passed (not env):** the first line names the id,
followed by:

> Pass `session: "<id>"` on every later checkpoint call in this conversation.

**Save without `session` on a no-id client in `merge` mode:** the existing warning ("No existing
checkpoint to merge into; saved a new one") adds:

> If you saved earlier in this conversation, pass the `session` id that save returned.

This catches the "lost id" case on the very save that would create the duplicate.

**Load result for a no-id client:** the brief and the list say that saves need `session`, and
the server instructions say it once (see "Instructions").

### What changes for each kind of client

| Client | Today | After |
|---|---|---|
| Claude Code (env var) | Own slot; list when there's none | **Unchanged** |
| No env var, agent passes the id it's given | Shared `.claude-checkpoint` | Own slot per conversation |
| No env var, agent ignores the id | Shared `.claude-checkpoint` | A new slot on each first save, with a warning on merge |
| A future 2026-07-28 client running one process for several conversations, env var set | All share one slot | Unchanged (the env var wins). It needs the hook option or a client change; out of scope until such a client exists |

### The legacy file

- Still read and listed (selector `legacy`) through 1.x.
- **No longer written** by new saves, because no-id saves mint an id instead. This is the one
  behavior change, and the reason to land it before 1.0 (see "Rollout").
- Loading with no id no longer opens the legacy file automatically; it appears in the list
  like any other checkpoint. This matches the slots design's rule that the user picks, even
  when there's only one.

### Questions from #20, answered

- **Losing the id** (compaction, `/clear` on a no-id client): the agent calls load without
  `session`, gets the list, and the user picks the old checkpoint. Saving with
  `resumedFrom` then mints a new slot linked to it. That's a duplicate, not a loss, and the merge
  warning above flags the case. Accepted.
- **Wrong writes:** on Claude Code, prevented by the conflict rule. On no-id clients the server
  can't check ownership without per-process state, which #18 removed. Mitigated by the separate
  argument names, the descriptions and the instructions. Accepted, documented risk.
- **Argument vs env var:** they must agree, or the call fails (see the conflict rule).
- **Subagents:** not covered here. #11 should use a task key the parent chooses, in its own
  argument, not `session`. A subagent passing its own `session` on Claude Code would hit the
  conflict rule anyway, which is a useful extra guard next to #38.
- **Hook packaging:** settled by #21. See "Hook" below for whether it should supply an id.
- **Do agents reliably pass an id when told to?** Unknown, so it's the rollout gate.

### Hook: no change for 1.0 (author's call)

The SessionStart hook could put its `session_id` into `additionalContext` and tell the agent to
pass it. Not doing it for 1.0:

- On Claude Code it would replace a reliable source (the env var) with one that depends on the
  agent remembering an id, which is the untested part.
- After `/clear` the hook's id is new by design. The slots design deliberately keeps loading the
  pre-clear checkpoint directly, and this would undo that, so users would get a list after every
  `/clear`.
- It would need the conflict rule loosened.

If a client that doesn't set the env var ever ships hooks, this becomes a 1.x addition.

### Instructions

Add one line to `INSTRUCTIONS` (`src/server.ts`):

> If a save returns a `session` id, pass it as `session` on every later checkpoint call in this
> conversation.

On Claude Code saves don't return an id-to-pass line, so the agent can ignore this line there.

## Rollout

1. **Build it behind a flag.** Implement everything above, with minting enabled only when
   `CHECKPOINT_SESSION_IDS=mint`. Without the flag, no-id saves keep writing the legacy file,
   so this step changes no default behavior and can ship as a minor release.
2. **Experiment (an hour or less).** Claude Code always sets `CLAUDE_CODE_SESSION_ID` for the
   servers it spawns, but a wrapper can remove it before the server starts. (Verified: a child
   started through `env -u` sees the variable as unset.) Register a test copy of the server:

   ```bash
   claude mcp add checkpoint-noid -e CHECKPOINT_SESSION_IDS=mint -- \
     env -u CLAUDE_CODE_SESSION_ID node /abs/path/to/dist/index.js
   ```

   Disable the plugin's server for the run, so the agent doesn't see two sets of checkpoint
   tools. Then do a realistic session with several saves, a compaction, and a merge, and check
   whether the agent passes `session` back on every call. Try Claude Desktop too if it's easy;
   it sets no session id at all.
3. **If the agent reliably passes the id:** make minting the default before tagging 1.0. The
   flag can stay as an opt-out (`CHECKPOINT_SESSION_IDS=legacy`).
4. **If it doesn't:** ship 1.0 with minting opt-in, and make it the default in 2.0.
5. **Either way**, #39 records the result: the argument is part of the contract, and the
   compatibility section says which file a no-id save writes.

## Testing

- Unit-test the resolution function: argument / env / neither × valid / invalid / conflicting.
- E2E (existing `InMemoryTransport` setup):
  - no env var: the first save mints and returns an id; a second save with it merges into the same
    slot; a save without it in merge mode warns and creates a second slot
  - env var set and matching argument: unchanged behavior
  - env var set and conflicting argument: tool error, nothing written
  - load and list with `session` mark the right `isCurrentSession`
  - a legacy file is listed but not auto-loaded and not written
- The #26 contract test is updated for the new input and output fields.
- Existing Claude Code-path tests pass unchanged. This is the proof of "no new friction".

## Effect on other issues

- **#11:** uses a separate task key; this doc doesn't change its direction.
- **#19:** no blocker. The explicit argument is the spec's preferred form; the env var remains as
  server configuration, which `serveStdio`'s per-connection instances keep working.
- **#38:** independent. The conflict rule is a second guard.
- **#39:** add `session` to the contract and state the no-id behavior chosen in "Rollout".

## Left to the builder

- Error and warning wording beyond the quotes above.
- Where the resolution function lives (`session.ts` is the obvious place).
- Whether `sessionSource` also goes into the checkpoint JSON (optional field, still `version: 1`).
  Useful for debugging, not required.
