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
