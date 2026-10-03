import type { ContentScanner, ContentScanResult } from "@rag/core";
import { EgressPolicy, egressSafeFetch } from "@rag/core";

/**
 * Layer 1.5 content scanner backed by a self-hosted, OpenAI-compatible server
 * (Ollama, vLLM, LM Studio, llama.cpp — see `docs/LOCAL-GENERATION.md`).
 *
 * This MUST point at infrastructure the firm controls, never a third-party
 * API: the whole purpose of this scan is to decide whether content is safe to
 * send elsewhere, so sending it to an external LLM to ask would itself be the
 * disclosure this layer exists to prevent. `EgressPolicy` enforces this the
 * same way it gates embeddings, generation, and reranking — no call reaches a
 * host nobody explicitly allow-listed.
 *
 * The model is asked for a strict JSON verdict. A response with no
 * parseable JSON object throws rather than defaulting to "clean" — a scanner
 * that silently passes content through on a malformed reply manufactures
 * confidence, the same failure mode `redactOrThrow` guards against.
 */

const SYSTEM_PROMPT = `You are a data-loss-prevention scanner for a CPA firm's internal knowledge base. You will be shown a document excerpt. Determine whether it names or otherwise identifies a specific client — a person's or organization's name in a professional-services context, or a fact pattern specific enough to identify who the document is about.

Respond with ONLY a JSON object of this exact shape, nothing else:
{"flagged": boolean, "findings": string[]}

"findings" entries are short category descriptions for an audit log (e.g. "client name: Jane Doe"), never the full surrounding sentence.`;

/** Characters of the document sent to the model. A truncated scan only
 * covers what it saw — see the class docstring. Sized well under typical
 * small-model context windows, leaving room for the system prompt. */
const MAX_SCAN_CHARS = 8000;

interface OllamaChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class OllamaContentScanner implements ContentScanner {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly egressPolicy: EgressPolicy;
  private readonly timeoutMs: number;

  constructor(opts: {
    baseUrl: string;
    model: string;
    egressPolicy?: EgressPolicy;
    timeoutMs?: number;
  }) {
    this.baseUrl = opts.baseUrl;
    this.model = opts.model;
    this.egressPolicy = opts.egressPolicy ?? EgressPolicy.fromEnv();
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async scan(text: string): Promise<ContentScanResult> {
    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    this.egressPolicy.assertAllowed(endpoint);

    const excerpt = text.slice(0, MAX_SCAN_CHARS);
    const fetchImpl = egressSafeFetch();
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: excerpt },
        ],
        temperature: 0,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `content scanner request failed: HTTP ${response.status}`,
      );
    }

    const body = (await response.json()) as OllamaChatResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("content scanner returned no message content to parse");
    }

    return parseVerdict(content);
  }
}

/** Extracts the `{"flagged": ..., "findings": [...]}` object from the
 * model's reply. Models asked for "JSON only" sometimes wrap it in prose
 * anyway, so this looks for the first `{...}` span rather than requiring the
 * whole reply to be valid JSON — but a reply with no such span, or one that
 * doesn't parse, throws rather than being read as "clean". */
function parseVerdict(content: string): ContentScanResult {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(
      `content scanner reply had no JSON object to parse: ${content.slice(0, 200)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(
      `content scanner reply's JSON object did not parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { flagged?: unknown }).flagged !== "boolean"
  ) {
    throw new Error(
      "content scanner reply's JSON object is missing a boolean 'flagged' field",
    );
  }
  const findingsRaw = (parsed as { findings?: unknown }).findings;
  const findings = Array.isArray(findingsRaw)
    ? findingsRaw.filter((f): f is string => typeof f === "string")
    : [];
  return { flagged: (parsed as { flagged: boolean }).flagged, findings };
}

export interface ContentScanConfig {
  provider: "ollama" | "none";
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

/** Factory mirroring `createEmbeddingProvider`/`createReranker`'s shape.
 * `provider: "none"` returns `undefined` rather than a no-op scanner — unlike
 * the reranker, this is not an optional quality knob: `ingestOne`'s
 * `scanForClientContextOrThrow` fails closed (quarantines) per-document when
 * no scanner is wired in, so "none" is a deliberate, auditable choice to
 * quarantine everything until one is configured, not a silent bypass. */
export function createContentScanner(
  cfg: ContentScanConfig,
): ContentScanner | undefined {
  switch (cfg.provider) {
    case "none":
      return undefined;
    case "ollama": {
      if (!cfg.baseUrl) {
        throw new Error(
          "CONTENT_SCAN_BASE_URL is required for CONTENT_SCAN_PROVIDER=ollama",
        );
      }
      if (!cfg.model) {
        throw new Error(
          "CONTENT_SCAN_MODEL is required for CONTENT_SCAN_PROVIDER=ollama",
        );
      }
      return new OllamaContentScanner({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
      });
    }
  }
}
