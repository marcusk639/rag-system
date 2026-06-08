import { NotFoundError } from "@rag/core";
import { createSource, getSource, type Source } from "@rag/db";
import { listPublicSources, triggerSync } from "@rag/services";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";

/**
 * Drop the raw `config` blob before returning a source over the wire. The
 * config contains connector-specific values (SharePoint site IDs, Drive
 * folder IDs, Gmail queries, OAuth impersonation subjects) — leaking these
 * to anyone with a read token both exposes source topology to potential
 * attackers and risks surfacing operator-supplied credential-like values
 * that should never have been stored there.
 *
 * Source creation still accepts the full config (POST /sources); we just
 * never echo it back in list/get responses.
 */
function sanitizeSource(row: Source): Omit<Source, "config"> {
  const { config: _config, ...safe } = row;
  return safe;
}

const SourceKindSchema = z.enum([
  "sharepoint",
  "gdrive",
  "gmail",
  "outlook",
  "custom",
]);

const CreateSourceBody = z.object({
  kind: SourceKindSchema,
  name: z.string().min(1).max(120),
  // Connector-specific config — kept opaque here; connectors validate at use time.
  config: z.record(z.unknown()),
});

const SyncBody = z.object({
  mode: z.enum(["full", "incremental"]).default("incremental"),
});

const IdParams = z.object({ id: z.string().uuid() });

export async function registerSourceRoutes(
  app: FastifyInstance,
  deps: Deps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // POST /sources — create
  typed.post(
    "/sources",
    {
      schema: {
        body: CreateSourceBody,
      },
    },
    async (request, reply) => {
      const body = request.body;
      const row = await createSource(deps.db, {
        kind: body.kind,
        name: body.name,
        config: body.config,
      });
      // Strip `config` from the create response too — it may carry
      // credential-like values, and GET routes already sanitize it.
      return reply.code(201).send(sanitizeSource(row));
    },
  );

  // GET /sources — list (config-stripped by the service).
  typed.get("/sources", async () => {
    const sources = await listPublicSources(deps);
    return { sources };
  });

  // GET /sources/:id — one
  typed.get(
    "/sources/:id",
    { schema: { params: IdParams } },
    async (request) => {
      const row = await getSource(deps.db, request.params.id);
      if (!row)
        throw new NotFoundError(`Source ${request.params.id} not found`);
      return sanitizeSource(row);
    },
  );

  // POST /sources/:id/sync — enqueue ingestion
  typed.post(
    "/sources/:id/sync",
    {
      schema: {
        params: IdParams,
        body: SyncBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { mode } = request.body;

      // triggerSync is the sole writer of ingestion_jobs (C2a fix): it creates
      // exactly one row and threads its id into the queue payload. NotFoundError
      // (unknown source) and SyncAlreadyRunningError (duplicate) propagate to the
      // central error handler → 404 / 409.
      const result = await triggerSync(deps, { sourceId: id, mode });

      request.log.info(
        {
          sourceId: id,
          mode,
          jobId: result.jobId,
          ingestionId: result.ingestionId,
        },
        "sync enqueued",
      );

      return reply.code(202).send(result);
    },
  );
}
