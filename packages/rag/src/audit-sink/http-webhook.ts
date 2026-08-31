import type { AuditLogRecord, AuditLogSink, EgressPolicy } from "@rag/core";
import { NO_REDIRECT_INIT } from "@rag/core";

/**
 * Vendor-agnostic HTTPS-webhook audit-log sink. Works identically with
 * Datadog/Splunk/Papertrail/any generic collector — it's just "POST this
 * JSON here". Mirrors `HttpCrossEncoderReranker`'s `fetch()` shape for the
 * HTTP mechanics only (packages/rag/src/retrieval/reranker.ts).
 *
 * Unlike that reranker, `ship()` ships real per-user identity
 * (`principalSubject`, a real AAD object id) to an external URL, so every
 * call is gated by `EgressPolicy.assertAllowed()` BEFORE `fetch` — the same
 * compliance control that already governs LLM/embedding egress. This is not
 * optional hardening; skipping it would make this the only outbound path in
 * the system with zero egress control over identity-linked data.
 */
export class HttpWebhookAuditLogSink implements AuditLogSink {
  constructor(
    private readonly opts: {
      url: string;
      token?: string;
      egressPolicy: EgressPolicy;
    },
  ) {}

  async ship(rows: AuditLogRecord[]): Promise<void> {
    if (rows.length === 0) return;

    // Mandatory egress gate — must run before fetch, and must throw (never
    // swallow) if the configured URL isn't on EGRESS_ALLOWED_HOSTS.
    this.opts.egressPolicy.assertAllowed(this.opts.url);

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.opts.token) {
      headers.authorization = `Bearer ${this.opts.token}`;
    }

    const response = await fetch(this.opts.url, {
      // Audit rows must not be re-sent to a redirect target the allow-list
      // never validated.
      ...NO_REDIRECT_INIT,
      method: "POST",
      headers,
      body: JSON.stringify(rows),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `audit-log webhook ship failed: ${response.status} ${detail}`.trim(),
      );
    }
  }
}
