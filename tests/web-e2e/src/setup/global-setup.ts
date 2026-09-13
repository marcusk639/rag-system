import { ensureStackReady } from "./stack.js";
import { seedCorpus } from "./seed.js";

export default async function globalSetup(): Promise<void> {
  await ensureStackReady();
  const { sourceId } = await seedCorpus();
  process.env.E2E_SOURCE_ID = sourceId;
}
