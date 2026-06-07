import {
  type DocumentMetadata,
  NotFoundError,
  sanitizeMetadata,
} from "@rag/core";
import { getDocument } from "@rag/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";

const IdParams = z.object({ id: z.string().uuid() });

export async function registerDocumentRoutes(
  app: FastifyInstance,
  deps: Deps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // GET /documents/:id — return the full document row (parsed markdown + metadata)
  typed.get(
    "/documents/:id",
    { schema: { params: IdParams } },
    async (request) => {
      const row = await getDocument(deps.db, request.params.id);
      if (!row)
        throw new NotFoundError(`Document ${request.params.id} not found`);
      // PII boundary: the stored `metadata` jsonb carries email author/from/
      // to/subject and connector `extra`. Apply the allowlist before returning
      // the row to the caller. See @rag/core metadata-policy.
      return {
        ...row,
        metadata: sanitizeMetadata(row.metadata as DocumentMetadata),
      };
    },
  );
}
