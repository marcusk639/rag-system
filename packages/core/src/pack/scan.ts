import type { LoadedPack } from "./load.js";
import type { Disposition, ScannerKind } from "./schema.js";

export type Confidence = "high" | "low";

export interface ScanMatch {
  scannerId: string;
  kind: ScannerKind;
  disposition: Disposition;
  confidence: Confidence;
  /** Offsets into the INPUT text. Never mutated, so they stay valid. */
  start: number;
  end: number;
  /** Shape-preserving mask. The raw value is never carried on this object. */
  maskedSample: string;
}

/** Keep shape, drop the value: 123-45-6789 -> 1XXXXXXXXX9. */
export function maskValue(v: string): string {
  if (v.length <= 2) return "X".repeat(v.length);
  return v[0]! + "X".repeat(v.length - 2) + v[v.length - 1]!;
}

/**
 * Find every match of every scanner in the pack.
 *
 * **The confidence rule is total** (spec §3.1). A match that satisfies every gate
 * its scanner declares is `high`; a match that fails ANY gate is `low`. Nothing is
 * ever dropped — gates decide the label, never whether the finding exists. An
 * earlier draft defined `low` as "fails only the context gate", which left a
 * validator failure belonging to no bucket and silently discarded.
 *
 * Matching runs against the unmodified input, so `start`/`end` remain valid for
 * every match regardless of what a caller later does with the text.
 *
 * **Deliberately throws on a zero-width match.** `schema.ts`'s `compiled.test("")`
 * guard catches an unconditionally-empty pattern (e.g. `\d*`), but NOT a
 * context-dependent zero-width pattern — `(?=\d)`, `\b`, `(?<=x)` all compile,
 * all return `false` for `.test("")`, and all then match zero-width at many
 * real positions once matched against actual document text. Each such match
 * has `start === end` and an empty `maskedSample`, none of them coalesce in
 * `applyRedaction`, and the result is a mask token inserted at every matched
 * position — destroying the document. The tempting fix is to skip a
 * zero-length match and move on, but that silently disables the scanner while
 * everything downstream still reports a healthy run — the exact same
 * silent-scanner-disablement failure shape as an empty-scanner pack. It is
 * also precisely the "skip the degenerate case" reasoning that created the
 * original validator-failure hole this engine was built to close (see the
 * confidence-rule note above). So instead: throw. A pack whose pattern
 * matches zero-width is malformed, and a malformed pack must halt loudly, not
 * degrade silently. This is `scanText`'s first throw path, and that is
 * intentional.
 */
export function scanText(text: string, pack: LoadedPack): ScanMatch[] {
  const out: ScanMatch[] = [];

  for (const s of pack.scanners) {
    // Fixed flag set, not passthrough: keep the author's semantic flags (i/m/s/u/v)
    // but never inherit `y` — sticky anchors every match attempt at `lastIndex`, so
    // a sticky scanner regex combined with `g` (`"yg"`) would return NOTHING for a
    // document that visibly contains the identifier. `g` is always added so the
    // engine controls iteration itself.
    const flags = s.re.flags.replace(/[gy]/g, "") + "g";
    const re = new RegExp(s.re.source, flags);
    for (const m of text.matchAll(re)) {
      const value = m[0];
      const start = m.index;

      if (value.length === 0) {
        throw new Error(
          `scanner "${s.id}": pattern matched zero-width (an empty string) ` +
            `at position ${start}, which indicates a malformed pack — a ` +
            "scanner pattern must always consume at least one character",
        );
      }

      let confidence: Confidence = "high";

      if (s.validate && !s.validate(value)) confidence = "low";

      if (confidence === "high" && s.context) {
        const window = text.slice(
          Math.max(0, start - s.contextWindow),
          start + value.length + s.contextWindow,
        );
        if (!s.context.test(window)) confidence = "low";
      }

      out.push({
        scannerId: s.id,
        kind: s.kind,
        disposition: s.disposition,
        confidence,
        start,
        end: start + value.length,
        maskedSample: maskValue(value),
      });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}
