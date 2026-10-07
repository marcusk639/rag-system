import { randomUUID } from "node:crypto";
import {
  NotFoundError,
  SourceKind,
  StorageNotConfiguredError,
  ValidationError,
} from "@rag/core";
import {
  createPendingUpload,
  createSource,
  getSource,
  toPublicSource,
} from "@rag/db";
import { listPublicSources, purgeSource, triggerSync } from "@rag/services";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { scopeFromRequest } from "./authz.js";

/**
 * MIME types accepted for browser uploads. Kept deliberately narrow — the
 * parser sidecar handles these document formats; arbitrary binaries are
 * rejected at the boundary. (Validated again, structurally, by the pipeline.)
 */
const ALLOWED_UPLOAD_MIME = new Set<string>([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.ms-powerpoint", // .ppt
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
]);

const CreateSourceBody = z.object({
  kind: SourceKind,
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
      // Authz: creating a new connected source (SharePoint site, Drive,
      // mailbox) is an admin-only operation. `Principal` today has no
      // "may create sources" capability distinct from "scoped to existing
      // sourceIds" — a brand-new source doesn't fit that model, so admin-only
      // is the minimal viable gate (see PLAN-KB-GOVERNANCE-AND-USAGE-ANALYTICS.md
      // Phase 1). Mirrors the direct `reply.code(...)` pattern `auth.ts` uses
      // for 401s rather than throwing a new error class.
      if (request.principal?.kind !== "admin") {
        request.log.warn(
          { principalKind: request.principal?.kind ?? "unknown" },
          "source creation forbidden: non-admin principal",
        );
        return reply.code(403).send({
          error: {
            code: "FORBIDDEN",
            message: "creating a source requires an admin principal",
          },
        });
      }

      const body = request.body;
      const row = await createSource(deps.db, {
        kind: body.kind,
        name: body.name,
        config: body.config,
      });
      // Strip `config` from the create response too — it may carry
      // credential-like values, and GET routes already sanitize it.
      return reply.code(201).send(toPublicSource(row));
    },
  );

  // GET /sources — list (config-stripped by the service, and now scoped: a
  // scoped principal only sees sources within its `allowedSourceIds`).
  typed.get("/sources", async (request) => {
    const sources = await listPublicSources(deps, scopeFromRequest(request));
    return { sources };
  });

  // GET /sources/:id — one
  typed.get(
    "/sources/:id",
    { schema: { params: IdParams } },
    async (request) => {
      const { id } = request.params;

      // Authz: admin (null enforcedSourceIds) or a scoped principal whose
      // allow-list includes this source. NotFoundError — no existence leak,
      // same convention as DELETE /sources/:id below.
      const scope = scopeFromRequest(request);
      const permitted =
        scope.enforcedSourceIds === null ||
        scope.enforcedSourceIds.includes(id);
      if (!permitted) throw new NotFoundError(`Source ${id} not found`);

      const row = await getSource(deps.db, id);
      if (!row) throw new NotFoundError(`Source ${id} not found`);
      return toPublicSource(row);
    },
  );

  // DELETE /sources/:id — purge a source and all its documents/chunks
  // Tighter per-route rate limit (6/min): a purge is irreversible and
  // administratively significant; burst protection mirrors the sync cap.
  typed.delete(
    "/sources/:id",
    {
      schema: { params: IdParams },
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params;

      // Authz: admin (null enforcedSourceIds) or a scoped principal whose
      // allow-list includes this source. NotFoundError — no existence leak.
      const scope = scopeFromRequest(request);
      const permitted =
        scope.enforcedSourceIds === null ||
        scope.enforcedSourceIds.includes(id);
      if (!permitted) throw new NotFoundError(`Source ${id} not found`);

      await purgeSource(deps, id);

      request.log.info({ sourceId: id }, "source purged");

      return reply.code(204).send();
    },
  );

  // POST /sources/:id/sync — enqueue ingestion
  // Tighter per-route rate limit (6/min) — triggers a full connector sync job
  // that may hit external rate-limited APIs (Graph, Drive, Gmail) and queue
  // many embedding/parse tasks. The global 60/min bucket is too permissive here.
  typed.post(
    "/sources/:id/sync",
    {
      schema: {
        params: IdParams,
        body: SyncBody,
      },
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { mode } = request.body;

      // Authz: admin (unrestricted) or a scoped principal whose allow-list
      // includes this source. A forbidden source returns 404 (no existence
      // leak) — same convention as DELETE /sources/:id and POST .../documents.
      // Without this, a source-restricted token could force a (Graph-quota
      // and embedding-cost consuming) sync against a source it can't read.
      const scope = scopeFromRequest(request);
      const permitted =
        scope.enforcedSourceIds === null ||
        scope.enforcedSourceIds.includes(id);
      if (!permitted) throw new NotFoundError(`Source ${id} not found`);

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

  // POST /sources/:id/documents — upload a single file into a `custom` source.
  // The original bytes are written to the object store and a `pending_uploads`
  // row is recorded; an incremental sync is then enqueued, and the custom
  // connector ingests the staged file on the worker (parse → chunk → embed).
  // Multipart, so the body is read via `request.file()` (no Zod body schema).
  typed.post(
    "/sources/:id/documents",
    { schema: { params: IdParams } },
    async (request, reply) => {
      const { id } = request.params;

      // Authz: admin (unrestricted) or a scoped principal whose allow-list
      // includes this source. A forbidden source returns 404 (no existence
      // leak) — same convention as GET /documents/:id.
      const scope = scopeFromRequest(request);
      const permitted =
        scope.enforcedSourceIds === null ||
        scope.enforcedSourceIds.includes(id);
      if (!permitted) throw new NotFoundError(`Source ${id} not found`);

      const source = await getSource(deps.db, id);
      if (!source) throw new NotFoundError(`Source ${id} not found`);

      // Uploads only target `custom` sources: their connector reads the staged
      // uploads. Other kinds ingest from their external system via sync.
      if (source.kind !== "custom") {
        throw new ValidationError(
          "documents can only be uploaded to a 'custom' source",
        );
      }

      // Originals must be persisted so cited documents stay downloadable.
      if (!deps.objectStore) {
        throw new StorageNotConfiguredError();
      }

      const file = await request.file();
      if (!file) {
        throw new ValidationError("multipart upload contained no file");
      }

      if (!ALLOWED_UPLOAD_MIME.has(file.mimetype)) {
        throw new ValidationError(`unsupported file type: ${file.mimetype}`);
      }

      // Buffer the file. @fastify/multipart throws a 413 past the configured
      // fileSize limit; `truncated` is a belt-and-suspenders guard in case the
      // throwing behavior is ever disabled.
      const content = await file.toBuffer();
      if (file.file.truncated) {
        throw new ValidationError("file exceeds the upload size limit");
      }
      if (content.byteLength === 0) {
        throw new ValidationError("uploaded file is empty");
      }

      const externalId = randomUUID();
      const storageKey = `uploads/${id}/${externalId}`;
      await deps.objectStore.put(storageKey, content, file.mimetype);

      await createPendingUpload(deps.db, {
        sourceId: id,
        externalId,
        filename: file.filename,
        mimeType: file.mimetype,
        sizeBytes: content.byteLength,
        storageKey,
        storageBucket: deps.objectStore.bucket,
      });

      // Reuse the standard sync path so the upload flows through the exact same
      // worker → runIngestion → ingestOne machinery as every other source.
      const result = await triggerSync(deps, {
        sourceId: id,
        mode: "incremental",
      });

      request.log.info(
        {
          sourceId: id,
          externalId,
          filename: file.filename,
          sizeBytes: content.byteLength,
          ingestionId: result.ingestionId,
        },
        "document upload staged and sync enqueued",
      );

      return reply.code(202).send({
        ...result,
        documentId: externalId,
        filename: file.filename,
      });
    },
  );
}
