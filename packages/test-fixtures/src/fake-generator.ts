import type { GenerationResult, Generator, RetrievalResult } from "@rag/core";

/**
 * Deterministic Generator for /ask specs.
 *
 *   - Returns an answer string that includes the first chunk's text verbatim
 *     so specs can assert on what landed in the model's context.
 *   - Cites like the real generators: one `[N]` and one citation per source
 *     DOCUMENT (in order of first appearance), not per chunk.
 *   - Records every call for later inspection.
 */
export class FakeGenerator implements Generator {
  readonly calls: Array<{
    question: string;
    contextSize: number;
    contextTexts: string[];
  }> = [];

  /** No screening: fixture context is synthetic and never TRI-bearing. */
  screen(_question: string, context: RetrievalResult[]): RetrievalResult[] {
    return context;
  }

  async answer(
    question: string,
    context: RetrievalResult[],
  ): Promise<GenerationResult> {
    this.calls.push({
      question,
      contextSize: context.length,
      contextTexts: context.map((c) => c.text),
    });

    const head = context[0];
    const headPreview = head ? head.text.slice(0, 80) : "<no context>";
    const documents: RetrievalResult[] = [];
    const chunkIds = new Map<string, string[]>();
    for (const r of context) {
      const ids = chunkIds.get(r.document.id);
      if (ids) {
        ids.push(r.chunk.id);
      } else {
        chunkIds.set(r.document.id, [r.chunk.id]);
        documents.push(r);
      }
    }
    // `[N]` markers for every document so `filterCitationsToAnswer` (applied by
    // callers after generation) keeps them all.
    const markers = documents.map((_, i) => `[${i + 1}]`).join(" ");
    return {
      answer: `Q: ${question} | ctx#0: ${headPreview} ${markers}`,
      citations: documents.map((r, i) => ({
        index: i + 1,
        documentId: r.document.id,
        title: r.document.title,
        downloadable: r.document.hasOriginal ?? false,
        chunkId: r.chunk.id,
        chunkIds: chunkIds.get(r.document.id) ?? [r.chunk.id],
        score: r.score,
        ...(r.document.url !== undefined ? { url: r.document.url } : {}),
      })),
    };
  }

  async *answerStream(
    question: string,
    context: RetrievalResult[],
  ): AsyncIterable<string> {
    // Reuse `answer` so streamed text matches the non-streamed answer exactly,
    // emitted word-by-word so specs can assert incremental delivery.
    const { answer } = await this.answer(question, context);
    for (const word of answer.split(" ")) {
      yield word.length ? `${word} ` : word;
    }
  }
}
