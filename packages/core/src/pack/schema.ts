import { z } from "zod";

export const ScannerKind = z.enum(["identifying", "contextual"]);
export type ScannerKind = z.infer<typeof ScannerKind>;

export const Disposition = z.enum(["exclude", "redact", "flag"]);
export type Disposition = z.infer<typeof Disposition>;

/** Defaults per platform spec §3.7: identifying excludes, contextual flags. */
const DEFAULT_DISPOSITION: Record<ScannerKind, Disposition> = {
  identifying: "exclude",
  contextual: "flag",
};

const ScannerDecl = z
  .object({
    id: z.string().min(1),
    kind: ScannerKind,
    disposition: Disposition.optional(),
    /** JS regex source. Compiled at load; `g` is added by the engine. */
    pattern: z.string().min(1),
    /** Registered name of a compiled-in validator, e.g. "luhn". */
    validator: z.string().min(1).optional(),
    /** Registered name of a compiled-in context matcher, e.g. "account-vocab". */
    context: z.string().min(1).optional(),
    /** How far either side of a match the context matcher looks. */
    contextWindow: z.number().int().positive().default(60),
  })
  .transform((s) => ({
    ...s,
    disposition: s.disposition ?? DEFAULT_DISPOSITION[s.kind],
  }))
  .superRefine((s, ctx) => {
    try {
      new RegExp(s.pattern);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scanner "${s.id}": pattern is not a valid regex — ${(e as Error).message}`,
      });
    }
  });

export type ScannerDecl = z.infer<typeof ScannerDecl>;

export const PackFile = z
  .object({
    pack: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      /** Semver range against the PACK CONTRACT version (platform spec §3.6). */
      requiresCore: z.string().min(1),
    }),
    scanners: z.array(ScannerDecl).min(1),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    for (const s of p.scanners) {
      if (seen.has(s.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate scanner id "${s.id}"`,
        });
      }
      seen.add(s.id);
    }
  });

export type PackFile = z.infer<typeof PackFile>;
