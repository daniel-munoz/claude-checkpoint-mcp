// Keeps the published metadata (npm package, MCP registry server.json, plugin manifests) in sync,
// so a release can't ship with a stale version, a mismatched registry name, or undocumented env vars.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

const pkg = readJson("package.json");
const server = readJson("server.json");
const plugin = readJson("plugin/.claude-plugin/plugin.json");
const marketplace = readJson(".claude-plugin/marketplace.json");
const npmEntry = server.packages.find((p: { registryType: string }) => p.registryType === "npm");

describe("published metadata", () => {
  it("uses one version everywhere", () => {
    expect(server.version).toBe(pkg.version);
    expect(npmEntry.version).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
    expect(marketplace.plugins[0].version).toBe(pkg.version);
  });

  it("points the MCP registry entry at this npm package", () => {
    // The registry verifies npm ownership by matching package.json mcpName to server.json name.
    expect(pkg.mcpName).toBe(server.name);
    expect(npmEntry.identifier).toBe(pkg.name);
  });

  it("names the registry entry after the repository owner", () => {
    const [, owner, repo] = new URL(server.repository.url).pathname.split("/");
    expect(server.name).toBe(`io.github.${owner}/${repo}`);
    expect(pkg.repository.url).toContain(`github.com/${owner}/${repo}`);
  });

  it("declares every environment variable the server reads", () => {
    const srcDir = path.join(root, "src");
    const read = new Set<string>();
    for (const file of readdirSync(srcDir)) {
      const text = readFileSync(path.join(srcDir, file), "utf8");
      for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) read.add(m[1]!);
    }
    const declared = new Set(npmEntry.environmentVariables.map((v: { name: string }) => v.name));
    expect([...read].sort()).toEqual([...declared].sort());
    for (const v of npmEntry.environmentVariables) expect(v.description).toBeTruthy();
  });
});
