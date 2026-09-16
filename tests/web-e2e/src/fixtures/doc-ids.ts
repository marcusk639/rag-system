/**
 * The UUIDs ingestion assigned to the fixture documents, published by
 * global-setup.ts via `E2E_DOC_IDS` (Playwright workers inherit its env).
 *
 * Read lazily so a spec that doesn't need them never throws at import.
 */
export function docIds(): { a: string; b: string; c: string; d: string } {
  const raw = process.env.E2E_DOC_IDS;
  if (!raw) {
    throw new Error(
      "[web-e2e] E2E_DOC_IDS is unset — global-setup did not run or failed",
    );
  }
  return JSON.parse(raw) as { a: string; b: string; c: string; d: string };
}
