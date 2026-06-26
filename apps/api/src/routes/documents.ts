import { getDocumentById, getDocumentDownload } from "@rag/services";
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

  // GET /documents/:id — return the full document row (parsed markdown +
  // metadata). Thin adapter: getDocumentById throws NotFoundError → 404.
  typed.get(
    "/documents/:id",
    { schema: { params: IdParams } },
    async (request) => {
      // The service enforces P1b (forbidden source is indistinguishable from a
      // missing id — same NotFoundError → 404) and the PII metadata allowlist;
      // the route only resolves the principal's scope and delegates.
      return getDocumentById(
        deps,
        request.params.id,
        scopeFromRequest(request),
      );
    },
  );

  // GET /documents/:id/download — stream the ORIGINAL file bytes as an
  // attachment. Same scope check as getDocumentById (forbidden/missing/
  // not-stored all surface as 404 via NotFoundError). Streams from the object
  // store; bytes never pass through the markdown/metadata path.
  typed.get(
    "/documents/:id/download",
    { schema: { params: IdParams } },
    async (request, reply) => {
      const dl = await getDocumentDownload(
        deps,
        request.params.id,
        scopeFromRequest(request),
      );
      reply.header("content-type", dl.contentType);
      reply.header(
        "content-disposition",
        `attachment; filename="${dl.filename}"`,
      );
      if (dl.contentLength != null) {
        reply.header("content-length", String(dl.contentLength));
      }
      return reply.send(dl.body);
    },
  );
}
