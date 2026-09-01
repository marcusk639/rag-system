import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PackFile, type Disposition, type ScannerKind } from "./schema.js";
import { resolveValidator, resolveContext } from "./registry.js";

/**
 * The PACK CONTRACT version — not the npm package version. A pack declares the
 * contract it targets via `requiresCore`; bumping this major is what breaks
 * older packs, and doing so deliberately is the point (platform spec §3.6).
 */
export const PACK_CONTRACT_VERSION = "1.0.0";

export interface CompiledScanner {
  id: string;
  kind: ScannerKind;
  disposition: Disposition;
  re: RegExp;
  validate?: (m: string) => boolean;
  context?: RegExp;
  contextWindow: number;
}

export interface LoadedPack {
  id: string;
  version: string;
  scanners: CompiledScanner[];
}

/**
 * Minimal caret-range check. Only `^X.Y.Z` is supported, deliberately.
 *
 * 0.x pre-1.0 caret semantics (`^0.1.0` means `>=0.1.0 <0.2.0`, not the `1.x+`
 * "any minor/patch within the same major" rule) are NOT implemented. Rather
 * than silently apply the wrong rule, a 0.x range is rejected outright — this
 * is unreachable while `PACK_CONTRACT_VERSION` stays >= 1.0.0, but guards the
 * day someone sets a 0.x contract version.
 */
export function satisfiesCaret(range: string, version: string): boolean {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!m)
    throw new Error(
      `requiresCore must be a caret range like "^1.0.0", got "${range}"`,
    );
  const [rMaj, rMin, rPatch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (rMaj === 0)
    throw new Error(
      `requiresCore "${range}": 0.x pre-1.0 caret semantics are not implemented — ` +
        `the pack contract version must stay >= 1.0.0`,
    );
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!v)
    throw new Error(
      `PACK_CONTRACT_VERSION must be a plain "X.Y.Z" version, got "${version}"`,
    );
  const [maj, min, patch] = [Number(v[1]), Number(v[2]), Number(v[3])];
  if (maj !== rMaj) return false;
  if (min > rMin) return true;
  if (min < rMin) return false;
  return patch >= rPatch;
}

export function loadPack(dir: string): LoadedPack {
  const file = join(dir, "pack.yaml");
  if (!existsSync(file)) throw new Error(`pack.yaml not found in ${dir}`);

  const parsed = PackFile.parse(parseYaml(readFileSync(file, "utf8")));

  if (!satisfiesCaret(parsed.pack.requiresCore, PACK_CONTRACT_VERSION)) {
    throw new Error(
      `pack "${parsed.pack.id}" requires core ${parsed.pack.requiresCore}, ` +
        `but this image implements pack contract ${PACK_CONTRACT_VERSION} — incompatible, refusing to load`,
    );
  }

  return {
    id: parsed.pack.id,
    version: parsed.pack.version,
    scanners: parsed.scanners.map((s) => ({
      id: s.id,
      kind: s.kind,
      disposition: s.disposition,
      // `g` is required — the engine iterates all matches.
      re: new RegExp(s.pattern, "g"),
      validate: s.validator ? resolveValidator(s.validator) : undefined,
      context: s.context ? resolveContext(s.context) : undefined,
      contextWindow: s.contextWindow,
    })),
  };
}
