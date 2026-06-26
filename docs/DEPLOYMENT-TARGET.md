# Deployment Target — Tenant #1

**Decision D1 (resolved 2026-06-14; recorded here per Phase 2.0 checklist).**

## Chosen target: single VM + docker-compose

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
