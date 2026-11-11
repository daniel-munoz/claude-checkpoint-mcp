// The plugin runs plugin/dist/*.js from Claude Code's plugin cache, outside this repo, so its bundles can't
// rely on our root package.json to be read as ES modules (#46). Node then walks up from the plugin folder:
// a typeless package.json above it prints MODULE_TYPELESS_PACKAGE_JSON on every run, and Node versions
// without module syntax detection (e.g. 20.10) fail to load the bundles at all.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

/** A copy of plugin/dist installed below an unrelated package.json that has no "type" field. */
function installBelowTypelessPackageJson(): string {
  const home = tempDir();
  writeFileSync(path.join(home, "package.json"), JSON.stringify({ dependencies: {} }));
  const dist = path.join(home, "plugins", "cache", "session-checkpoint", "dist");
  mkdirSync(dist, { recursive: true });
  cpSync(path.resolve("plugin/dist"), dist, { recursive: true });
  return dist;
}

const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH });

describe("plugin bundles installed outside the repo", () => {
  it.each(["hook.js", "guard.js"])("%s runs with nothing on stderr", (script) => {
    const dist = installBelowTypelessPackageJson();
    const run = spawnSync(process.execPath, [path.join(dist, script)], { input: "{}", encoding: "utf8", env: env() });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
  });

  it("starts the server without a module-type warning", () => {
    const dist = installBelowTypelessPackageJson();
    // With stdin already closed, the server starts, logs that it is ready, and shuts down.
    const run = spawnSync(process.execPath, [path.join(dist, "index.js")], { input: "", encoding: "utf8", env: env(), timeout: 15000 });
    expect(run.stderr).toContain("ready on stdio");
    expect(run.stderr).not.toContain("MODULE_TYPELESS_PACKAGE_JSON");
    expect(run.stderr).not.toContain("SyntaxError");
  });

  it("declares the bundles as ES modules", () => {
    const pkg = JSON.parse(execFileSync(process.execPath, ["-p", "JSON.stringify(require('./plugin/dist/package.json'))"], { encoding: "utf8" }));
    expect(pkg.type).toBe("module");
  });
});
