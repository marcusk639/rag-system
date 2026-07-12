import { z } from "zod";

export const EcfrPart4Config = z.object({
  title: z.number().int().positive().default(38),
  part: z.string().min(1).default("4"),
});
export type EcfrPart4Config = z.infer<typeof EcfrPart4Config>;
