import {
  type DocumentMetadata,
  isSourceAllowed,
  NotFoundError,
  sanitizeMetadata,
} from "@rag/core";
import { getDocument } from "@rag/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { scopeFromRequest } from "./authz.js";
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
      // Confidentiality boundary (P1b): a scoped caller must not be able to read
      // — or even confirm the existence of — a document outside its enforced
      // source set. Treat a forbidden source EXACTLY like a missing id (same
      // 404) so the two cases are indistinguishable.
      const scope = scopeFromRequest(request);
      if (!row || !isSourceAllowed(scope, row.sourceId))
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
