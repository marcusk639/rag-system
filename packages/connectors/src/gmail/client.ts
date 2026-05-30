// Re-export the Gmail client factory so the connector imports stay local.
export { createGmailClient, type GoogleCredentials } from "../gdrive/client.js";
