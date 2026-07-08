import { z } from "zod";

export const GitMarkdownConfig = z.object({
  /** Absolute path to a local clone of the markdown repo. */
  repoPath: z.string().min(1),
  /** Only files whose repo-relative path ends in one of these extensions are ingested. */
  extensions: z.array(z.string()).default([".md"]),
});
export type GitMarkdownConfig = z.infer<typeof GitMarkdownConfig>;
