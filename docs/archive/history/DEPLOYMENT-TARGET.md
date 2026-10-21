# Deployment Target — Tenant #1

> ## ⛔ SUPERSEDED — this is not what runs today (marked 2026-08-03)
>
> **The live deployment target is Railway**, not a single VM + docker-compose.
> D1 below was resolved 2026-06-14 and overtaken by events; the correction has
> been recorded in other documents since at least 2026-07-17 but had never been
> written here, which is why readers arriving via
> [`DEPLOYMENT.md`](./DEPLOYMENT.md) kept getting the stale answer.
>
> **What is actually true:** each app has a `railway.json`; `rag-worker` owns
> migrations via its `preDeployCommand` and is the single migration owner;
> `rag-api`, `rag-mcp`, and `rag-web` are deployed Railway services. See
> [`DEPLOYMENT.md` § Migrations on deploy (Railway)](./DEPLOYMENT.md#migrations-on-deploy-railway),
> [`PILOT-LAUNCH-STATUS.md`](./PILOT-LAUNCH-STATUS.md), and
> [`superpowers/specs/2026-07-17-platform-tenancy-and-plugin-boundary.md`](./superpowers/specs/2026-07-17-platform-tenancy-and-plugin-boundary.md) §2.5.
>
> **What is still valid below:** `docker/compose.prod.yml` remains a working
> self-host option, and the encryption-at-rest guidance (D4) and the
> "when to move to K8s" reasoning still apply to that path. Read this document
> for the self-host rationale — **not** as a description of the deployment.

**Decision D1 (resolved 2026-06-14; recorded here per Phase 2.0 checklist).**

## Chosen target (2026-06-14 decision): single VM + docker-compose

**Rationale:**

| Criterion        | Verdict                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Data sensitivity | LOW–MODERATE (firm work-product; see `PLAN-LAUNCH-READINESS.md` §Data-sensitivity posture)                                       |
| Ops burden       | Minimal — one host, one compose stack, no K8s cluster to maintain                                                                |
| Encrypted volume | Full control: pin the `postgres_data` volume to an encrypted disk partition at provisioning time                                 |
| Postgres version | `pgvector/pgvector:pg16` image guarantees pgvector + HNSW index support — no managed-PG guessing                                 |
| Data residency   | Single-host; everything stays on the encrypted VM                                                                                |
| Future-proofing  | Compose file is the per-tenant provisioning unit; Phase T multi-tenancy scales by adding instances, not by redesigning the stack |

## Provisioning unit

`docker/compose.prod.yml` is the single-tenant stack. To deploy a new tenant:

```bash
# 1. Copy and fill the env template for this tenant
cp env.example .env.<tenant>
$EDITOR .env.<tenant>

# 2. Boot infra first, run migrations, then start services
docker compose -f docker/compose.prod.yml --env-file .env.<tenant> -p <tenant> \
  up -d postgres parser

docker compose -f docker/compose.prod.yml --env-file .env.<tenant> -p <tenant> \
  run --rm worker node -e "import('@rag/db').then(m => m.migrate())"
  # Or run the compiled migration binary:
  # run --rm worker node dist/... (see pnpm --filter @rag/db migrate)

docker compose -f docker/compose.prod.yml --env-file .env.<tenant> -p <tenant> \
  up -d api mcp worker
```

## Encryption-at-rest (D4)

The `postgres_data` Docker named volume must be backed by an encrypted block device. Options:

- **Linux LUKS**: `cryptsetup luksFormat /dev/sdX` → mount at `/var/lib/docker/volumes/<tenant>_postgres_data/`
- **Cloud disk encryption**: AWS EBS with KMS, GCP Persistent Disk with CMEK, etc. (most cloud VMs encrypt by default — verify this is enabled)
- **Verify**: `lsblk -o NAME,FSTYPE,MOUNTPOINT,SIZE` and confirm the underlying block device is encrypted

## When to move to K8s (Phase T trigger)

Move to namespace-per-tenant K8s **only when** isolated-tenant count makes managing N compose hosts unwieldy. The same Docker images and `dataClass` model carry forward — no app changes required. See `PLAN-LAUNCH-READINESS.md` §Phase T.
