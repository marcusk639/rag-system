// Public surface of @rag/worker for test harnesses and in-process embedding.
// The `main.ts` entrypoint stays the production binary; this barrel exposes the
// building blocks so consumers can stitch together their own runtime.
export { handleSyncSource } from "./handlers/sync-source.js";
export { handleShipAuditLog } from "./handlers/ship-audit-log.js";
export { buildDeps, type WorkerDeps } from "./deps.js";
