// Reads a Claude Code hook's JSON input from stdin. Shared by the plugin's hook scripts, so it
// imports only node: built-ins.

/** The hook input as an object; empty when stdin is a terminal, empty, or not a JSON object. */
export async function readHookInput(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
