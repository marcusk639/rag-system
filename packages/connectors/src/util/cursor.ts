import { ValidationError } from "@rag/core";

export interface CursorCodec<T> {
  /** Serialize a cursor to the opaque base64(JSON) string the interface expects. */
  encode(cursor: T): string;
  /** Parse an opaque cursor string, applying per-connector defaulting/validation. */
  decode(raw: string): T;
}

/**
 * Every connector encodes its resume cursor as base64(JSON); the only thing that
 * varies is the per-connector defaulting/validation applied on decode, supplied
 * here as `normalize`. A malformed cursor (bad base64, bad JSON, or a value that
 * `normalize` rejects by throwing) surfaces as a
 * `ValidationError("invalid <name> cursor")` — matching the prior hand-rolled
 * codecs exactly.
 */
export function makeCursorCodec<T>(
  name: string,
  normalize: (parsed: unknown) => T,
): CursorCodec<T> {
  return {
    encode(cursor: T): string {
      return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64");
    },
    decode(raw: string): T {
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(raw, "base64").toString("utf8"),
        );
        return normalize(parsed);
      } catch (err) {
        throw new ValidationError(`invalid ${name} cursor`, err);
      }
    },
  };
}
