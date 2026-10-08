import { describe, expect, it } from "vitest";
import { createRedactor, REDACTED } from "../src/redact.js";

function scrub(text: string) {
  const r = createRedactor();
  return { out: r.scrub(text), count: r.count };
}

describe("redact", () => {
  it.each([
    ["OPENAI_API_KEY=sk-abc123def456ghi789jkl npm start", `OPENAI_API_KEY=${REDACTED} npm start`],
    ["export GITHUB_TOKEN='ghp_secret value'", `export GITHUB_TOKEN=${REDACTED}`],
    [`curl -H "Authorization: Bearer eyJhbGciOi.payload.sig" https://api`, `curl -H "Authorization: Bearer ${REDACTED}" https://api`],
    ["curl -H 'X-Api-Key: abc123' url", `curl -H 'X-Api-Key: ${REDACTED}' url`],
    ["psql postgres://admin:hunter2@db:5432/app", `psql postgres://${REDACTED}@db:5432/app`],
    ["mytool --password hunter2 --verbose", `mytool --password ${REDACTED} --verbose`],
    ["mytool --token=abc", `mytool --token=${REDACTED}`],
    ['{"client_secret": "xyz"}', `{"client_secret": ${REDACTED}}`],
    ["aws s3 ls # AKIAIOSFODNN7EXAMPLE", `aws s3 ls # ${REDACTED}`],
    ["used ghp_abcdefghijklmnopqrstuvwxyz0123 for auth", `used ${REDACTED} for auth`],
  ])("scrubs %s", (input, expected) => {
    const { out, count } = scrub(input);
    expect(out).toBe(expected);
    expect(count).toBe(1);
  });

  it.each([
    "npm test -- auth",
    "mkdir -p src/keys",
    "keyboard: use vim bindings",
    "used about 1500 tokens: fine",
    "git log --oneline -5",
    "the token refresh flow is broken",
  ])("leaves benign text alone: %s", (input) => {
    const { out, count } = scrub(input);
    expect(out).toBe(input);
    expect(count).toBe(0);
  });

  it("counts across calls and does not double-redact", () => {
    const r = createRedactor();
    r.scrub("API_KEY=one");
    r.scrub(r.scrub("TOKEN=two"));
    expect(r.count).toBe(2);
  });
});
