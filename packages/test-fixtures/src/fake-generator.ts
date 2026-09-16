import type { GenerationResult, Generator, RetrievalResult } from "@rag/core";

/**
 * Deterministic Generator for /ask specs.
 *
 *   - Returns an answer string that includes the first chunk's text verbatim
 *     so specs can assert on what landed in the model's context.
 *   - Emits one citation per retrieved chunk so the citation rendering path
 *     gets exercised.
 *   - Records every call for later inspection.
 */
export class FakeGenerator implements Generator {
  readonly calls: Array<{
    question: string;
    contextSize: number;
    contextTexts: string[];
  }> = [];

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
    // `[N]` markers for every chunk so `filterCitationsToAnswer` (applied by
    // callers after generation) doesn't strip them all — real generators are
    // instructed to cite this way; this fixture must too or "one citation per
    // retrieved chunk" above would be a lie.
    const markers = context.map((_, i) => `[${i + 1}]`).join(" ");
    return {
      answer: `Q: ${question} | ctx#0: ${headPreview} ${markers}`,
      citations: context.map((r, i) => ({
        index: i + 1,
        documentId: r.document.id,
        title: r.document.title,
        downloadable: r.document.hasOriginal ?? false,
        chunkId: r.chunk.id,
        chunkIds: [r.chunk.id],
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
