/**
 * TRI (Taxpayer Return Information) pre-flight scanner.
 *
 * Scans text for patterns that indicate IRC §7216 Taxpayer Return Information
 * before it is sent to an external API. Callers decide the action — the scanner
 * only detects and reports; it does not throw.
 *
 * Patterns:
 *   - US SSN: ###-##-#### (dashes required to avoid false positives on
 *     phone numbers and dates)
 *   - US EIN: ##-####### (employer identification number)
 *   - "taxpayer" near a dollar amount (loose; covers narrative TRI)
 *   - Named tax-form reference near a dollar amount (Form 1040 / 1065 / 1041 / 1120)
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
    // Require word boundaries + dashes to reduce false positives.
    regex: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  {
    label: "EIN",
    regex: /\b\d{2}-\d{7}\b/,
  },
  {
    label: "taxpayer+amount",
    // "taxpayer" followed by a dollar amount within ~30 chars.
    regex: /taxpayer.{0,30}\$[\d,]+/i,
  },
  {
    label: "tax-form+amount",
    // Named IRS tax form reference followed by a dollar amount within ~50 chars.
    regex: /\b(Form\s+)?(1040|1065|1041|1120)[A-Z-]*.{0,50}\$[\d,]+/i,
  },
];

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
