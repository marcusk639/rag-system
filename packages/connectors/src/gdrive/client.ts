import { google, type drive_v3, type gmail_v1 } from "googleapis";
import { ConnectorAuthError } from "@rag/core";

/**
 * Credentials block for Google API access. Either `serviceAccountJson` is set
 * (preferred for org-wide ingestion) or all three OAuth fields are set.
 */
export interface GoogleCredentials {
  serviceAccountJson?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

/** Drive scopes — read-only across the board. */
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];
/** Gmail scopes — read-only across the board. */
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

/**
 * Build an authenticated Drive v3 client.
 *
 * Service account path: uses google.auth.JWT with optional subject impersonation.
 * OAuth path: uses an OAuth2 client preloaded with the refresh token.
 */
export function createDriveClient(
  credentials: GoogleCredentials,
  impersonateUser: string | undefined,
): drive_v3.Drive {
  const auth = createAuth(credentials, DRIVE_SCOPES, impersonateUser);
  return google.drive({ version: "v3", auth });
}

/** Build an authenticated Gmail v1 client. */
export function createGmailClient(
  credentials: GoogleCredentials,
  impersonateUser: string | undefined,
): gmail_v1.Gmail {
  const auth = createAuth(credentials, GMAIL_SCOPES, impersonateUser);
  return google.gmail({ version: "v1", auth });
}

// We avoid importing `google-auth-library` directly (it's a transitive dep of
// googleapis, not a direct dep). The googleapis client accepts any object
// matching its auth contract, and we only ever pass it OAuth2 / JWT instances.
type GoogleAuth =
  | InstanceType<typeof google.auth.OAuth2>
  | InstanceType<typeof google.auth.JWT>;

function createAuth(
  credentials: GoogleCredentials,
  scopes: string[],
  impersonateUser: string | undefined,
): GoogleAuth {
  if (credentials.serviceAccountJson) {
    let parsed: { client_email?: string; private_key?: string };
    try {
      parsed = JSON.parse(credentials.serviceAccountJson) as typeof parsed;
    } catch (err) {
      throw new ConnectorAuthError(
        "google: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON",
        err,
      );
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new ConnectorAuthError(
        "google: service account JSON missing client_email or private_key",
      );
    }
    return new google.auth.JWT({
      email: parsed.client_email,
      key: parsed.private_key,
      scopes,
      subject: impersonateUser,
    });
  }

  if (
    !credentials.clientId ||
    !credentials.clientSecret ||
    !credentials.refreshToken
  ) {
    throw new ConnectorAuthError(
      "google: either GOOGLE_SERVICE_ACCOUNT_JSON or all of (clientId, clientSecret, refreshToken) must be set",
    );
  }
  const oauth = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
  );
  oauth.setCredentials({ refresh_token: credentials.refreshToken });
  return oauth;
}
