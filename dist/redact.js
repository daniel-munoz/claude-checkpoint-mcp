export const REDACTED = "«redacted»";
const NOT_REDACTED = `(?!${REDACTED})`;
const VALUE = `${NOT_REDACTED}("[^"]*"|'[^']*'|[^\\s"']+)`;
// Order matters: contextual rules run first so a key like OPENAI_API_KEY=sk-... is
// counted once, by the assignment rule, rather than again by the bare-token rule.
const RULES = [
    // scheme://user:pass@host
    { pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replace: `$1${REDACTED}@` },
    // Authorization: Bearer <token>
    { pattern: new RegExp(`(\\bBearer\\s+)${NOT_REDACTED}[A-Za-z0-9._~+/=-]+`, "gi"), replace: `$1${REDACTED}` },
    // API_KEY=..., "token": "...", X-Api-Key: ... — the identifier must *end* in the
    // secret word so prose like "keyboard: ..." or "tokens: 1500" is left alone.
    {
        pattern: new RegExp(`([A-Za-z0-9_-]*(?:key|token|secret|passw(?:or)?d|credentials?)["']?)(\\s*[=:]\\s*)${VALUE}`, "gi"),
        replace: `$1$2${REDACTED}`,
    },
    // --password foo, --token=foo
    {
        pattern: new RegExp(`(--(?:password|passwd|token|api-key|secret)(?:=|\\s+))${VALUE}`, "gi"),
        replace: `$1${REDACTED}`,
    },
    // Bare well-known token formats.
    { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
    { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: REDACTED },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
    { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
];
/** Returns a scrubber that counts every replacement it makes across calls. */
export function createRedactor() {
    let count = 0;
    return {
        scrub(text) {
            let out = text;
            for (const { pattern, replace } of RULES) {
                out = out.replace(pattern, (...args) => {
                    count++;
                    // Expand $1/$2 against this match's capture groups.
                    return replace.replace(/\$(\d)/g, (_, i) => String(args[Number(i)] ?? ""));
                });
            }
            return out;
        },
        get count() {
            return count;
        },
    };
}
//# sourceMappingURL=redact.js.map