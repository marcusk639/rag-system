import type { Logger } from "pino";
import { type Connector, type SourceKind, ValidationError } from "@rag/core";
import { SharePointConnector } from "./sharepoint/index.js";
import { GDriveConnector } from "./gdrive/index.js";
import { GmailConnector } from "./gmail/index.js";
import { OutlookConnector } from "./outlook/index.js";
import { GitMarkdownConnector } from "./git-markdown/index.js";
import { EcfrPart4Connector } from "./ecfr-part4/index.js";

/**
 * Subset of `Config` this factory needs. Decouples the factory from the full
 * config object so callers can construct one ad-hoc (tests, CLI tools).
 */
export interface ConnectorEnv {
  microsoft?: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  };
  google?: {
    serviceAccountJson?: string;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
  };
}

/** The slice of `SourceConfig` we need to construct a connector. */
export interface SourceLike {
  id: string;
  kind: SourceKind;
  config: Record<string, unknown>;
}

/**
 * Build a Connector for the given source. Validates the per-connector config
 * via its zod schema (inside each constructor) and surfaces a ValidationError
 * if required env credentials are missing.
 */
export function createConnector(
  source: SourceLike,
  env: ConnectorEnv,
  logger: Logger,
): Connector {
  const scoped = logger.child({ sourceId: source.id, sourceKind: source.kind });

  switch (source.kind) {
    case "sharepoint": {
      const creds = env.microsoft;
      if (!creds) {
        throw new ValidationError(
          "sharepoint connector requires microsoft credentials (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET)",
        );
      }
      return new SharePointConnector(source.config, creds, scoped);
    }
    case "outlook": {
      const creds = env.microsoft;
      if (!creds) {
        throw new ValidationError(
          "outlook connector requires microsoft credentials (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET)",
        );
      }
      return new OutlookConnector(source.config, creds, scoped);
    }
    case "gdrive": {
      const creds = env.google;
      if (!creds) {
        throw new ValidationError(
          "gdrive connector requires google credentials (service account JSON or OAuth refresh token)",
        );
      }
      return new GDriveConnector(source.config, creds, scoped);
    }
    case "gmail": {
      const creds = env.google;
      if (!creds) {
        throw new ValidationError(
          "gmail connector requires google credentials (service account JSON or OAuth refresh token)",
        );
      }
      return new GmailConnector(source.config, creds, scoped);
    }
    case "git-markdown": {
      return new GitMarkdownConnector(source.config, scoped);
    }
    case "ecfr-part4": {
      return new EcfrPart4Connector(source.config, scoped);
    }
    case "custom":
      throw new ValidationError(
        "custom connectors must be constructed directly, not via createConnector()",
      );
    default: {
      // Exhaustiveness check — adding a new SourceKind will surface here.
      const _exhaustive: never = source.kind;
      throw new ValidationError(
        `unknown connector kind: ${String(_exhaustive)}`,
      );
    }
  }
}
