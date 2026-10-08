import { describe, expect, it } from "vitest";
import { formatAge, renderBrief } from "../src/render.js";
import { makeCheckpoint } from "./helpers.js";

const NOW = new Date("2026-10-08T14:00:00.000Z");

describe("formatAge", () => {
  it.each([
    ["2026-10-08T13:59:30.000Z", "just now"],
    ["2026-10-08T13:15:00.000Z", "45m ago"],
    ["2026-10-08T12:00:00.000Z", "2h ago"],
    ["2026-10-05T14:00:00.000Z", "3d ago"],
  ])("%s → %s", (iso, expected) => expect(formatAge(iso, NOW)).toBe(expected));
});

describe("renderBrief", () => {
  const cp = makeCheckpoint({
    git: { branch: "feat/auth", head: "9c1e4a7b2d3f", dirty: true },
    goal: {
      primary: "Add OAuth login",
      tasks: [
        { description: "Callback route", status: "done" },
        { description: "Session persistence", status: "in_progress" },
      ],
    },
    summary: "Cookie not persisting.",
    nextSteps: ["Check SameSite"],
    decisions: ["Use iron-session"],
    modifiedFiles: [{ path: "src/session.ts", status: "M", source: "git", note: "cookie opts", hash: "abc" }],
    recentCommands: [{ command: "npm test", exitCode: 1, note: "2 failing", at: "2026-10-08T12:00:00.000Z" }],
  });

  it("renders all sections with drift", () => {
    const text = renderBrief(
      cp,
      { branchChanged: true, currentBranch: "main", commitsSince: 2, changedSince: ["src/session.ts"] },
      ["loaded from backup"],
      NOW,
    );
    expect(text).toMatchInlineSnapshot(`
      "# Resuming: demo (checkpoint saved 2h ago, 2026-10-08 12:00:00 UTC)
      Branch \`feat/auth\` @ 9c1e4a7b2 (uncommitted changes)
      > ⚠ loaded from backup

      ## Goal
      Add OAuth login

      ## Tasks
      - [x] Callback route
      - [~] Session persistence

      ## Where things stand
      Cookie not persisting.

      ## Next steps
      1. Check SameSite

      ## Decisions & gotchas
      - Use iron-session

      ## Files touched (1)
      - src/session.ts (M) — cookie opts

      ## Recent commands (last 1, oldest first)
      - ✗ exit 1 \`npm test\` — 2 failing

      ## Since this checkpoint
      - ⚠ Branch changed: \`feat/auth\` → \`main\`
      - 2 new commit(s) on HEAD
      - ⚠ Changed after the checkpoint, re-read before editing: \`src/session.ts\`"
    `);
  });

  it("says the file list is current when nothing drifted", () => {
    const text = renderBrief(cp, { branchChanged: false, currentBranch: "feat/auth", commitsSince: 0, changedSince: [] }, [], NOW);
    expect(text).toContain("No files changed since the checkpoint");
    expect(text).not.toContain("Branch changed");
  });

  it("omits empty sections", () => {
    const text = renderBrief(makeCheckpoint(), null, [], NOW);
    expect(text).not.toMatch(/## (Tasks|Next steps|Files|Recent commands|Since)/);
  });
});
