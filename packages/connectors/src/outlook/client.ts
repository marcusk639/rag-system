// Outlook reuses the SharePoint Graph client wholesale — same MSAL auth,
// same HTTP plumbing. Re-export so the connector's imports stay local.
export { GraphClient, type GraphCredentials } from "../sharepoint/client.js";
