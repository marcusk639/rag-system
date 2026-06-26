import type { ConnectorListResult, SourceDocument } from "@rag/core";

/** One upstream page of results plus the cursor/feed-state after consuming it. */
export interface ConnectorPage<T> {
  /** Documents produced by this page (at most the `remaining` passed to fetchPage). */
  documents: SourceDocument[];
  /** Cursor to persist and to feed into the next `fetchPage` call. */
  cursor: T;
  /**
   * True when the upstream feed has nothing more to return after this page.
   *
   * Modeled on Outlook's explicit feed-exhaustion flag: `done` is decoupled from
   * "did this page yield any documents". A page of only drafts/removals/skips is
   * still a real page and must NOT report `done` just because it produced zero
   * documents — otherwise a delta walk terminates early and loses later pages.
   */
  done: boolean;
  /**
   * External IDs the upstream feed reported as deleted on this page (delta
   * tombstones). Collected independently of the `remaining` document budget so
   * deletions are never dropped when the doc budget fills. Optional.
   */
  deletions?: string[];
  /** Items skipped on this page for exceeding the size cap (observability). Optional. */
  skippedOversize?: number;
}

export interface PaginateParams<T> {
  /** Upper bound on documents returned by one `list()` call. Clamped to >= 1. */
  maxItems: number;
  /** Decoded starting cursor for this call. */
  cursor: T;
  /** Encode the final cursor into the result envelope. */
  encode: (cursor: T) => string;
  /**
   * Fetch exactly one upstream page, filling at most `remaining` documents and
   * returning the advanced cursor plus whether the feed is now exhausted.
   */
  fetchPage: (cursor: T, remaining: number) => Promise<ConnectorPage<T>>;
}

/**
 * Drives the accumulate-until-`maxItems` paging loop shared by every connector.
 * Owns the clamp, the loop, and the `{ documents, nextCursor, done }` envelope so
 * each connector only implements how to fetch (and advance past) a single page.
 */
export async function paginate<T>(
  params: PaginateParams<T>,
): Promise<ConnectorListResult> {
  const maxItems = Math.max(1, params.maxItems);
  const documents: SourceDocument[] = [];
  const deletions: string[] = [];
  let skippedOversize = 0;
  let cursor = params.cursor;
  let done = false;

  while (documents.length < maxItems) {
    const remaining = maxItems - documents.length;
    const page = await params.fetchPage(cursor, remaining);
    cursor = page.cursor;
    for (const doc of page.documents) {
      if (documents.length >= maxItems) break;
      documents.push(doc);
    }
    if (page.deletions && page.deletions.length > 0) {
      deletions.push(...page.deletions);
    }
    if (page.skippedOversize) skippedOversize += page.skippedOversize;
    if (page.done) {
      done = true;
      break;
    }
  }

  return {
    documents,
    nextCursor: params.encode(cursor),
    done,
    deletions,
    skippedOversize,
  };
}
