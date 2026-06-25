import {
  ConfidentialClientApplication,
  type AuthenticationResult,
} from "@azure/msal-node";
import { ConnectorAuthError } from "@rag/core";
import { mapApiError } from "../util/errors.js";

/**
 * Microsoft Graph credentials (app registration). Identical shape between the
 * SharePoint and Outlook connectors — they share a tenant.
 */
export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}


/**
 * The read surface the SharePoint connector depends on. Declared as an
 * interface (which `GraphClient` implements) so the connector can be unit
 * tested with a fake Graph reader instead of hitting live Microsoft Graph.
 */
export interface GraphReader {
  getJson<T>(urlOrPath: string): Promise<T>;
  getBytes(urlOrPath: string): Promise<{ bytes: Buffer; contentType: string }>;
}

/**
 * Minimal Graph HTTP client used by the SharePoint and Outlook connectors.
 *
 * We deliberately do not use `@microsoft/microsoft-graph-client` for HTTP — its
 * fluent builder makes delta link handling awkward (deltaLinks are opaque URLs
 * that must be hit verbatim). MSAL handles token acquisition, fetch handles
 * the rest. The Graph SDK is still useful for type definitions consumers may
 * import.
 */
export class GraphClient implements GraphReader {
  private static readonly DEFAULT_SCOPE =
    "https://graph.microsoft.com/.default";
  private static readonly BASE_URL = "https://graph.microsoft.com/v1.0";

  private readonly msal: ConfidentialClientApplication;
  private cachedToken: { value: string; expiresOnMs: number } | null = null;

  constructor(credentials: GraphCredentials) {
    this.msal = new ConfidentialClientApplication({
      auth: {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        authority: `https://login.microsoftonline.com/${credentials.tenantId}`,
      },
    });
  }

  /** Get a usable bearer token, refreshing if the cached one is near expiry. */
  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresOnMs - now > 60_000) {
      return this.cachedToken.value;
    }
    let result: AuthenticationResult | null;
    try {
      result = await this.msal.acquireTokenByClientCredential({
        scopes: [GraphClient.DEFAULT_SCOPE],
      });
    } catch (err) {
      throw new ConnectorAuthError(
        "microsoft graph: failed to acquire token",
        err,
      );
    }
    if (!result?.accessToken) {
      throw new ConnectorAuthError(
        "microsoft graph: empty token response from MSAL",
      );
    }
    this.cachedToken = {
      value: result.accessToken,
      expiresOnMs: result.expiresOn?.getTime() ?? now + 30 * 60 * 1000,
    };
    return result.accessToken;
  }

  /**
   * Issue a GET against an absolute or relative Graph URL and return JSON.
   *
   * Pass an absolute URL (https://graph.microsoft.com/...) for things like
   * `@odata.nextLink` and `@odata.deltaLink` — those must be honored verbatim.
   */
  async getJson<T>(urlOrPath: string): Promise<T> {
    const url = this.toAbsolute(urlOrPath);
    const token = await this.getToken();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      mapApiError(err, `graph GET ${urlOrPath}`);
    }
    if (!res.ok) {
      await this.throwForResponse(res, `graph GET ${urlOrPath}`);
    }
    return (await res.json()) as T;
  }

  /** Fetch a binary stream (file content). Returns the bytes as a Buffer. */
  async getBytes(urlOrPath: string): Promise<{
    bytes: Buffer;
    contentType: string;
  }> {
    const url = this.toAbsolute(urlOrPath);
    const token = await this.getToken();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "follow",
      });
    } catch (err) {
      mapApiError(err, `graph GET (bytes) ${urlOrPath}`);
    }
    if (!res.ok) {
      await this.throwForResponse(res, `graph GET (bytes) ${urlOrPath}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return {
      bytes: Buffer.from(arrayBuf),
      contentType:
        res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /**
   * Resolve a Graph response link (`@odata.nextLink` / `@odata.deltaLink`) or
   * a relative path into an absolute URL we'll fetch with the Graph bearer
   * token.
   *
   * Security: we refuse to follow absolute URLs that aren't on the Graph
   * host. Graph itself never returns off-domain links, but a malicious
   * `config.driveId` or a compromised intermediary could try to redirect us
   * to an internal service — and we'd happily send a Graph bearer token to
   * it. The allowlist closes that vector with no false positives in practice.
   */
  private static readonly ALLOWED_HOSTS: ReadonlySet<string> = new Set([
    "graph.microsoft.com",
    "graph.microsoft.us", // US Government cloud
    "microsoftgraph.chinacloudapi.cn", // China cloud
  ]);

  private toAbsolute(urlOrPath: string): string {
    if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) {
      let parsed: URL;
      try {
        parsed = new URL(urlOrPath);
      } catch {
        throw new ConnectorAuthError(
          `sharepoint: malformed URL returned by Graph: ${urlOrPath}`,
        );
      }
      if (parsed.protocol !== "https:") {
        throw new ConnectorAuthError(
          `sharepoint: refusing to follow non-https link: ${parsed.protocol}`,
        );
      }
      if (!GraphClient.ALLOWED_HOSTS.has(parsed.hostname)) {
        throw new ConnectorAuthError(
          `sharepoint: refusing to follow off-domain redirect: ${parsed.hostname}`,
        );
      }
      return urlOrPath;
    }
    const trimmed = urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`;
    return `${GraphClient.BASE_URL}${trimmed}`;
  }

  /** Translate a non-2xx Graph response into a typed connector error. */
  private async throwForResponse(
    res: Response,
    context: string,
  ): Promise<never> {
    const status = res.status;
    const retryAfter = res.headers.get("retry-after");
    const headers: Record<string, string> = {};
    if (retryAfter !== null) headers["retry-after"] = retryAfter;
    let body: unknown;
    try {
      body = await res.text();
    } catch {
      body = undefined;
    }
    const err = {
      status,
      response: { status, headers, data: body },
      headers,
      message: typeof body === "string" ? body : String(body),
    };
    mapApiError(err, context);
  }
}
