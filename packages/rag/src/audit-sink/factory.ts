import type { AuditLogSink, Config } from "@rag/core";
import { EgressPolicy, ValidationError } from "@rag/core";
import { HttpWebhookAuditLogSink } from "./http-webhook.js";

/**
 * Build the configured audit-log sink, or `null` when shipping is disabled
 * (`AUDIT_SINK_PROVIDER=none`, the default). Mirrors `createObjectStore`'s
 * exact `"none"` → `null` convention.
 *
 * The caller MUST pass the shared `EgressPolicy` instance (the same one
 * threaded through `CoreDeps`) so the sink is built with real egress
 * enforcement from the start rather than a separately-constructed default.
 *
 * Adding a new destination:
 *   1. Implement `AuditLogSink` in a new file under audit-sink/
 *   2. Add a case here
 *   3. Add its enum value to Config.auditSink.provider in @rag/core
 */
export function createAuditLogSink(
  cfg: Config["auditSink"],
  opts: { egressPolicy: EgressPolicy },
): AuditLogSink | null {
  switch (cfg.provider) {
    case "none":
      return null;
    case "webhook":
      if (!cfg.webhookUrl) {
        throw new ValidationError(
          "AUDIT_SINK_WEBHOOK_URL required for webhook audit sink",
        );
      }
      return new HttpWebhookAuditLogSink({
        url: cfg.webhookUrl,
        token: cfg.webhookToken,
        egressPolicy: opts.egressPolicy,
      });
  }
}
