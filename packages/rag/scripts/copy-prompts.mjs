// tsc emits only .js/.d.ts; the prompt .md files must ship beside
// dist/prompts/index.js, which reads them at module load. Copies only the
// top-level .md files so nothing else in the folder rides along.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

const src = new URL("../src/prompts/", import.meta.url);
const dest = new URL("../dist/prompts/", import.meta.url);
mkdirSync(dest, { recursive: true });
for (const name of readdirSync(src)) {
  if (name.endsWith(".md"))
    copyFileSync(new URL(name, src), new URL(name, dest));
}
