export { SharePointConnector } from "./sharepoint/index.js";
export {
  SharePointConfigSchema,
  type SharePointConfig,
} from "./sharepoint/config.js";

export { GDriveConnector } from "./gdrive/index.js";
export { GDriveConfigSchema, type GDriveConfig } from "./gdrive/config.js";

export { GmailConnector } from "./gmail/index.js";
export { GmailConfigSchema, type GmailConfig } from "./gmail/config.js";

export { OutlookConnector } from "./outlook/index.js";
export { OutlookConfigSchema, type OutlookConfig } from "./outlook/config.js";

export {
  createConnector,
  type ConnectorEnv,
  type SourceLike,
} from "./factory.js";
