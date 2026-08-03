/**
 * TRI (Taxpayer Return Information) pre-flight scanner.
 *
 * Scans text for patterns that indicate IRC §7216 Taxpayer Return Information
 * before it is sent to an external API, and at ingest time to flag documents
 * containing TRI for the compliance audit log. Callers decide the action —
 * the scanner only detects and reports; it does not throw.
 *
 * Patterns:
 *   - US SSN / ITIN: ###-##-#### or ### ## #### (dashes or spaces)
 *   - US EIN: ##-####### or ## ####### (dashes or spaces)
 *   - "taxpayer" near a dollar amount (loose; covers narrative TRI)
 *   - Named IRS income-tax form (1040/1065/1041/1120) near a dollar amount
 *   - 1099 series (1099-MISC, 1099-NEC, 1099-DIV, …) near a dollar amount
 *   - W-2 / W2 wage form near a dollar amount
 *   - IRS Schedule reference (Schedule C/D/E/F/SE …) near a dollar amount
 */

export interface TRIScanResult {
  /** True if any TRI pattern was detected. */
  detected: boolean;
  /** Labels of the patterns that matched (for logging/audit). */
  patterns: string[];
}

interface TRIPattern {
  label: string;
  regex: RegExp;
}

const TRI_PATTERNS: TRIPattern[] = [
  {
    label: "SSN",
    // Match dash-separated (123-45-6789) and space-separated (123 45 6789).
    // Unformatted 9-digit strings are too broad (overlap with account numbers,
    // phone digits, etc.) — those are caught by taxpayer+amount and
    // tax-form+amount contextual patterns. ITIN (9XX-XX-XXXX) shares this
    // format and is intentionally matched here; the audit label "SSN" covers
    // both identifiers since both are protected TRI under §7216.
    regex: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/,
  },
  {
    label: "EIN",
    // Match dash-separated (12-3456789) and space-separated (12 3456789).
    regex: /\b\d{2}[-\s]\d{7}\b/,
  },
  {
    label: "taxpayer+amount",
    // "taxpayer" followed by a dollar amount within ~30 chars.
    // 's' flag (dotAll): '.' matches newlines so a cross-line "taxpayer\n$X"
    // phrase is not bypassed.
    regex: /taxpayer.{0,30}\$[\d,]+/is,
  },
  {
    label: "tax-form+amount",
    // Named IRS income-tax return form followed by a dollar amount within ~50 chars.
    // 's' flag (dotAll): prevents bypass via a newline between form reference
    // and the dollar figure.
    regex: /\b(Form\s+)?(1040|1065|1041|1120)[A-Z-]*.{0,50}\$[\d,]+/is,
  },
  {
    label: "1099+amount",
    // 1099 series (1099-MISC, 1099-NEC, 1099-DIV, 1099-INT, 1099-B, 1099-R …)
    // with a dollar amount within ~50 chars. A 1-3 char separator (ASCII
    // hyphen, en-dash U+2013, em-dash U+2014, space, or combinations like
    // "1099 - NEC") is required to avoid matching zip codes and account
    // numbers, while still catching OCR/PDF typographic-dash variants.
    regex: /\b1099[-–—\s]{1,3}[A-Z]{1,4}.{0,50}\$[\d,]+/is,
  },
  {
    label: "W2+amount",
    // W-2 or W2 wage/salary statement with a nearby dollar amount. Allows
    // optional whitespace around an optional hyphen/en-dash/em-dash separator
    // so "W – 2" and "W - 2" (OCR/PDF variants) are not bypassed.
    // Word boundary after the digit prevents matching "W2000" or "W2C" tool names.
    regex: /\bW\s*[-–—]?\s*2\b.{0,50}\$[\d,]+/is,
  },
  {
    label: "schedule+amount",
    // IRS Schedule references (Schedule C, Sch D, Sch. SE, etc.) with amounts.
    // Matches one- or two-letter schedules (C, D, E, F, SE) but not numeric
    // schedule references (Schedule 2, etc.) to reduce false positives.
    // Allows hyphen/dash separators ("Schedule-C") so OCR/PDF variants are caught.
    regex: /\b(?:Schedule|Sch\.?)[-–—\s]+[A-Z]{1,2}\b.{0,50}\$[\d,]+/is,
  },
];

/** Every label `scanForTRI` can emit. Exported so callers that classify labels
 * can assert their lists still correspond to real patterns. */
export const TRI_PATTERN_LABELS: readonly string[] = TRI_PATTERNS.map(
  (p) => p.label,
);

/**
 * Labels whose match is **identifying** rather than **contextual**.
 *
 * The distinction is the difference between "this text is about a tax return"
 * and "this text contains someone's tax identifier", and it matters because
 * callers apply a policy to the result.
 *
 * The contextual patterns (`tax-form+amount`, `W2+amount`, `schedule+amount`,
 * `1099+amount`, `taxpayer+amount`) match any text naming an IRS form near a
 * dollar figure — which is what a *procedure explaining how to prepare that
 * form* looks like. A screen of the TWK corpus (858 documents) put
 * `tax-form+amount` on 316 of them, and the inspected hits were SOPs.
 * Treating those as a hard stop makes the assistant fail on exactly the
 * questions it exists to answer.
 *
 * `SSN` and `EIN` are not like that. They match a formatted identifier, and in
 * that same screen they hit 24 documents — one holding 260 distinct SSN-shaped
 * values, which is a client roster rather than a placeholder. No corpus-level
 * false-positive rate makes it safe to disclose those to a third party.
 *
 * So a single permissive policy must not cover both. Callers are expected to
 * treat an identifying match as a hard stop regardless of how lenient their
 * policy is for the contextual ones.
 */
export const TRI_IDENTIFYING_LABELS: readonly string[] = ["SSN", "EIN"];

const IDENTIFYING = new Set(TRI_IDENTIFYING_LABELS);

/**
 * Narrow a `TRIScanResult['patterns']` list to the identifying labels only.
 * Returns `[]` when the scan matched nothing identifying — which is the common
 * case on an internal SOP corpus, and the case a lenient policy is calibrated
 * for.
 */
export function identifyingTRIPatterns(patterns: readonly string[]): string[] {
  return patterns.filter((p) => IDENTIFYING.has(p));
}

/**
 * Scan `text` for TRI patterns.
 * Returns `{ detected: false, patterns: [] }` when no patterns match.
 * Returns `{ detected: true, patterns: [...labels] }` when one or more match.
 */
export function scanForTRI(text: string): TRIScanResult {
  const matched: string[] = [];
  for (const { label, regex } of TRI_PATTERNS) {
    if (regex.test(text)) {
      matched.push(label);
    }
  }
  return { detected: matched.length > 0, patterns: matched };
}
