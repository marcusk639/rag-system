/**
 * Crude HTML → plaintext converter for email bodies. We intentionally avoid
 * pulling in a full DOM library; emails will be re-parsed downstream by the
 * Python parser sidecar if structural fidelity matters.
 */
export function htmlToText(html: string): string {
  return (
    html
      // Drop script and style blocks entirely.
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      // Replace common block-level closes with newlines so paragraphs survive.
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // Strip all remaining tags.
      .replace(/<[^>]+>/g, "")
      // Decode a handful of common entities.
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Collapse runs of whitespace.
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
