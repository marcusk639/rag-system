// Embeddings
export { GeminiEmbeddingProvider } from "./embeddings/gemini.js";
export { OpenAIEmbeddingProvider } from "./embeddings/openai.js";
export { createEmbeddingProvider } from "./embeddings/factory.js";

// Parser client (calls the Python sidecar)
export { HttpParserClient } from "./parser/parser-client.js";

// Chunking
export {
  MarkdownChunker,
  type MarkdownChunkerOptions,
} from "./chunking/markdown-chunker.js";
export {
  TableChunker,
  type TableChunkerOptions,
  type TableChunkInput,
} from "./chunking/table-chunker.js";
export {
  CompositeChunker,
  type CompositeChunkerOptions,
} from "./chunking/composite-chunker.js";
export {
  MAX_EMBEDDING_TOKENS,
  clampToTokenLimit,
} from "./chunking/token-clamp.js";

// Object storage (originals for downloadable citations)
export { S3ObjectStore } from "./storage/s3-object-store.js";
export { createObjectStore, documentStorageKey } from "./storage/factory.js";

// Audit-log shipping (off-host sink for audit_log rows)
export { HttpWebhookAuditLogSink } from "./audit-sink/http-webhook.js";
export { createAuditLogSink } from "./audit-sink/factory.js";

// Retrieval
export { Retriever } from "./retrieval/retriever.js";
export {
  HttpCrossEncoderReranker,
  createReranker,
} from "./retrieval/reranker.js";

// Generation
export {
  GeminiGenerator,
  OpenAIGenerator,
  createGenerator,
  buildCitations,
  filterCitationsToAnswer,
  type Generator,
  type GenerationResult,
  type TriPolicy,
} from "./generation/generator.js";

// Claim extraction (corpus-grounded eval)
export {
  verifyClaim,
  verifyClaims,
  MATCH_RUNGS,
  type MatchRung,
  type VerifiedClaim,
  type RejectedClaim,
  type ClaimVerification,
  type VerificationReport,
} from "./extraction/claim-verification.js";
export {
  extractClaims,
  CLAIM_EXTRACTION_PROMPT,
  type CompleteFn,
  type ExtractedClaim,
  type ExtractionResult,
  type ExtractDocumentInput,
} from "./extraction/claim-extractor.js";
export {
  corpusFingerprint,
  evaluateExtractionGate,
  type ScreenState,
  type ScreenSignoff,
  type GateResult,
} from "./extraction/screen-gate.js";
