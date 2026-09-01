import { z } from "zod";

export const ScannerKind = z.enum(["identifying", "contextual"]);
export type ScannerKind = z.infer<typeof ScannerKind>;

export const Disposition = z.enum(["exclude", "redact", "flag"]);
export type Disposition = z.infer<typeof Disposition>;

/** Defaults per platform spec §3.7: identifying excludes, contextual flags. */
const DEFAULT_DISPOSITION: Record<ScannerKind, Disposition> = {
  identifying: "exclude",
  contextual: "flag",
};

/**
 * True when the pattern is nothing BUT a leading lookaround — `(?=…)`,
 * `(?!…)`, `(?<=…)`, `(?<!…)` — with nothing after it to consume a character.
 *
 * The distinction matters: `(?<=SSN:\s*)\d{9}` also STARTS with a lookaround
 * but goes on to consume nine digits, and is exactly the shape a label-gated
 * identifier rule needs (mask the number, not the label). An earlier version
 * of this check tested only the prefix and rejected that pattern as
 * zero-width, which it is not.
 *
 * Walks the leading group to its matching `)`, tracking escapes and character
 * classes so a `)` inside `\)` or `[)]` does not close it early. Zero-width is
 * only claimed when that `)` is the pattern's last character.
 */
function isEntirelyLookaround(pattern: string): boolean {
  if (!/^\(\?(?:[=!]|<[=!])/.test(pattern)) return false;
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      // The leading lookaround just closed. Zero-width only if nothing follows.
      if (depth === 0) return i === pattern.length - 1;
    }
  }
  // Unbalanced — `new RegExp` above already rejected it, so this is unreachable
  // in practice. Do not claim zero-width on a pattern we could not parse.
  return false;
}

const ScannerDecl = z
  .object({
    id: z.string().min(1),
    kind: ScannerKind,
    disposition: Disposition.optional(),
    /** JS regex source. Compiled at load; `g` is added by the engine. */
    pattern: z.string().min(1),
    /**
     * Compile the pattern case-insensitively (`i`). Needed by patterns gated
     * on a written label — "SSN", "ssn" and "Social Security" are the same
     * field. Off by default: digit patterns gain nothing from it, and `i`
     * widens what a character class matches.
     */
    ignoreCase: z.boolean().default(false),
    /** Registered name of a compiled-in validator, e.g. "luhn". */
    validator: z.string().min(1).optional(),
    /** Registered name of a compiled-in context matcher, e.g. "account-vocab". */
    context: z.string().min(1).optional(),
    /** How far either side of a match the context matcher looks. */
    contextWindow: z
      .number()
      .int()
      .positive()
      .max(
        500,
        "contextWindow must be at most 500 — it is a small neighbourhood " +
          "around a match (the field's declared intent is a ±60-character " +
          "window), not a document scan. scanText slices " +
          "[start - contextWindow, end + contextWindow] for every match " +
          "reaching the context gate, so an unbounded value on a broad " +
          "pattern over a large document means slicing the whole document " +
          "per match — unbounded copying with no error, hanging the worker.",
      )
      .default(60),
  })
  .transform((s) => ({
    ...s,
    disposition: s.disposition ?? DEFAULT_DISPOSITION[s.kind],
  }))
  .superRefine((s, ctx) => {
    let compiled: RegExp | undefined;
    try {
      compiled = new RegExp(s.pattern);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scanner "${s.id}": pattern is not a valid regex — ${(e as Error).message}`,
      });
      return;
    }
    // A pattern that can match the empty string (e.g. `\d*`) yields one match
    // at every character index once the engine iterates with the `g` flag,
    // and `applyRedaction` then inserts a mask token at every position —
    // destroying the document rather than redacting an identifier in it.
    if (compiled.test("")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scanner "${s.id}": pattern can match the empty string, which would redact every position in the document — patterns must require at least one character`,
      });
    }
    // `.test("")` only catches an UNCONDITIONALLY zero-width pattern. A
    // CONTEXT-DEPENDENT zero-width pattern — a lookaround (`(?=...)`,
    // `(?!...)`, `(?<=...)`, `(?<!...)`) or a bare `\b` — returns `false` for
    // `.test("")` (there's no adjacent character for it to assert against in
    // an empty string) but still matches zero-width at real positions once
    // run against actual document text, which is exactly the failure this
    // guards against. This check is a cheap early signal for the common
    // shapes only, not a complete classifier — it cannot detect every
    // context-dependent zero-width pattern (e.g. a lookaround buried mid
    // pattern). `scanText`'s runtime throw on any zero-length match is the
    // real backstop; this just catches the obvious cases before a pack ever
    // ships.
    if (isEntirelyLookaround(s.pattern) || s.pattern === "\\b") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scanner "${s.id}": pattern is structurally zero-width (it is nothing but a lookaround, or is exactly "\\b") — it can never consume a character, so it will match zero-width at every position where its assertion holds, destroying the document when redacted`,
      });
    }
  });

export type ScannerDecl = z.infer<typeof ScannerDecl>;

export const PackFile = z
  .object({
    pack: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      /** Semver range against the PACK CONTRACT version (platform spec §3.6). */
      requiresCore: z.string().min(1),
    }),
    scanners: z.array(ScannerDecl).min(1),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    for (const s of p.scanners) {
      if (seen.has(s.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate scanner id "${s.id}"`,
        });
      }
      seen.add(s.id);
    }
  });

export type PackFile = z.infer<typeof PackFile>;
