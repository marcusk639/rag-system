import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A path, not `new URL("./x.md", import.meta.url)`: Vite rewrites that
// pattern into an asset URL, which breaks the read under Vitest.
const PROMPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Model prompts live as `.md` files beside this module so they are reviewed
 * and versioned as text. The build copies them into `dist/prompts/`
 * (`scripts/copy-prompts.mjs`); Prettier skips them (`.prettierignore`)
 * because every byte is model input.
 */
export const PROMPT_NAMES = [
  "generation-system",
  "generation-request",
  "contextualize-question",
  "content-scan-system",
  "claim-extraction",
] as const;

export type PromptName = (typeof PROMPT_NAMES)[number];

/** A prompt file's text, minus the single final newline every file ends with. */
export function loadPrompt(name: PromptName): string {
  const text = readFileSync(join(PROMPT_DIR, `${name}.md`), "utf8");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * Fill `{{name}}` placeholders in one pass, so placeholder-like text or `$&`
 * inside a value (user questions, retrieved documents) is inserted literally.
 * Throws on a placeholder without a value and on a value with no placeholder,
 * so a template and its caller cannot drift apart silently.
 */
export function renderPrompt(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const used = new Set<string>();
  const out = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`prompt placeholder {{${key}}} has no value`);
    }
    used.add(key);
    return value;
  });
  const unused = Object.keys(values).filter((key) => !used.has(key));
  if (unused.length > 0) {
    throw new Error(`prompt values never used: ${unused.join(", ")}`);
  }
  return out;
}
