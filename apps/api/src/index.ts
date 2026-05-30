// Public surface of @rag/api for test harnesses and in-process embedding.
// The `main.ts` entrypoint stays the production binary; this barrel exposes the
// building blocks so consumers can stitch together their own runtime.
export { buildServer } from "./server.js";
export { buildDeps, type Deps } from "./deps.js";
