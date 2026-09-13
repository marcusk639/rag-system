import { ensureStackReady } from "./stack.js";

export default async function globalSetup(): Promise<void> {
  await ensureStackReady();
}
