import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep the developer's git config and global excludes (e.g. ~/.config/git/ignore) out of
    // the server's own git calls, so ignore checks behave the same on every machine.
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      XDG_CONFIG_HOME: "/nonexistent",
    },
    coverage: {
      // json-summary writes coverage/coverage-summary.json, which code-review-assistant reads.
      // No html reporter: code-review-assistant would analyze its generated .js files.
      reporter: ["text", "json-summary"],
    },
  },
});
