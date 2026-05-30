-- One-time database bootstrap. Drizzle owns the rest of the schema.
-- This runs the first time the postgres container starts (mounted via docker-entrypoint-initdb.d).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;        -- trigram similarity for fuzzy keyword search
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";    -- uuid_generate_v4()

-- pg-boss creates its own schema on first run; we just make sure it has permission.
GRANT ALL ON DATABASE rag TO rag;
