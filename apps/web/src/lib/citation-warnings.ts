import type { CitationWarning } from "@/types";

/** One user-facing sentence per server citation warning. */
export function describeCitationWarning(warning: CitationWarning): string {
  if (warning.kind === "uncited_answer") {
    return "Citation check: this answer cites no sources — verify it before relying on it.";
  }
  const refs = warning.indices.map((i) => `[${i}]`).join(", ");
  return warning.indices.length === 1
    ? `Citation check: this answer cites ${refs}, which is not among the retrieved sources.`
    : `Citation check: this answer cites ${refs}, which are not among the retrieved sources.`;
}
