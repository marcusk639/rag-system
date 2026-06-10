import { getDocumentById } from "@rag/services";
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

  // GET /documents/:id — return the full document row (parsed markdown +
  // metadata). Thin adapter: getDocumentById throws NotFoundError → 404.
  typed.get(
    "/documents/:id",
    { schema: { params: IdParams } },
    async (request) => {
      return getDocumentById(deps, request.params.id);
    },
  );
}
