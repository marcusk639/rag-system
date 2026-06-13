/**
 * Labeled retrieval-eval corpus.
 *
 * This is a STARTER set — a small, keyword-distinctive corpus plus golden
 * questions whose answers are known. It exists so the harness is runnable today
 * with the deterministic FakeEmbedder (bag-of-words) and so RRF-weight / rerank
 * / contextual-retrieval changes become a *measurable* delta rather than a
 * vibe.
 *
 * To grow toward the §12 target (30–50 real CPA-knowledge-base questions, each
 * labeled with the document(s) that should answer it): add `EvalDoc`s sourced
 * from the real corpus and `EvalQuestion`s that reference their `externalId`s.
 * Nothing else in the harness changes.
 *
 * Design note: the FakeEmbedder's dense similarity tracks keyword overlap, so
 * each doc is given a distinctive vocabulary and each question shares salient
 * terms with its relevant doc(s). The corpus deliberately includes near-neighbor
 * distractors (several Postgres docs, several API-protection docs) so the
 * metrics have something to discriminate.
 */

export interface EvalDoc {
  /** Stable ground-truth key, also the connector externalId. */
  externalId: string;
  title: string;
  text: string;
}

export interface EvalQuestion {
  id: string;
  query: string;
  /** externalIds of the document(s) that correctly answer this question. */
  relevant: string[];
  note?: string;
}

export const EVAL_DOCS: EvalDoc[] = [
  {
    externalId: "pg-hnsw",
    title: "Tuning pgvector HNSW indexes",
    text: "A pgvector HNSW index accelerates approximate nearest-neighbor vector search using cosine similarity. Tune the m and ef_construction build parameters for recall, and raise hnsw.ef_search per query to trade latency for higher recall on the embedding vectors.",
  },
  {
    externalId: "pg-backup",
    title: "PostgreSQL backup and point-in-time recovery",
    text: "Back up a PostgreSQL database with pg_dump for logical dumps or pg_basebackup for physical backups. Enable WAL archiving to support point-in-time recovery, then restore by replaying the write-ahead log up to a target timestamp.",
  },
  {
    externalId: "sql-index",
    title: "Why queries do sequential scans",
    text: "When a SQL query does a sequential scan instead of an index scan, the planner estimated the B-tree index would be slower. Add a B-tree index on the WHERE-clause column, run ANALYZE to refresh statistics, and check the query plan with EXPLAIN.",
  },
  {
    externalId: "rrf-fusion",
    title: "Reciprocal rank fusion for hybrid search",
    text: "Reciprocal rank fusion combines a dense vector ranking and a sparse BM25 ranking into one hybrid result. Each candidate's fused score sums a weighted 1/(k + rank) term from each retriever, so documents ranked highly by either method rise to the top.",
  },
  {
    externalId: "chunking",
    title: "Markdown chunking strategy",
    text: "The chunker splits a markdown document into roughly equal token windows while respecting heading boundaries, lists, and code blocks. A small overlap between adjacent chunks preserves context across the split, and a heading breadcrumb is prepended for self-containment.",
  },
  {
    externalId: "gemini-embed",
    title: "Gemini embedding model",
    text: "The default embedding provider is Google Gemini text-embedding-004, which produces 768-dimensional vectors. The chunks table stores these vectors so a dimension mismatch is detectable if the embedding model is swapped.",
  },
  {
    externalId: "oauth",
    title: "OAuth refresh tokens",
    text: "An OAuth client exchanges an authorization grant for a short-lived access token and a long-lived refresh token. When the access token expires, the client uses the refresh token to obtain a new access token without prompting the user to re-authenticate, scoped to the granted permissions.",
  },
  {
    externalId: "rate-limit",
    title: "Rate limiting API requests",
    text: "Rate limiting protects an endpoint from abuse by capping requests with a token-bucket algorithm. When a caller exceeds its quota the server returns HTTP 429 and a Retry-After header, and clients back off exponentially before retrying.",
  },
  {
    externalId: "docker",
    title: "Building Docker images",
    text: "A Dockerfile declares the steps to build a container image: a base image, copied files, and a run command. Each instruction creates a cached layer, and a volume mounts persistent storage into the running container.",
  },
  {
    externalId: "k8s",
    title: "Scaling Kubernetes deployments",
    text: "A Kubernetes deployment manages a set of identical pods across cluster nodes. Scale the workload by raising the replica count, and the scheduler places new pods on nodes with free capacity while a service load-balances traffic across them.",
  },
  {
    externalId: "espresso",
    title: "Pulling an espresso shot",
    text: "Pulling an espresso shot requires finely ground coffee tamped level in the portafilter and about nine bars of pump pressure to force hot water through the puck for proper extraction in roughly thirty seconds.",
  },
  {
    externalId: "sailing",
    title: "Sailing upwind",
    text: "Sailing upwind means trimming the sails close to the centerline and tacking in a zig-zag because a boat cannot sail directly into the wind. The rudder steers while the jib and mainsail trim control power and the keel resists sideways drift.",
  },
  {
    externalId: "gardening",
    title: "Growing tomatoes",
    text: "Tomato plants reward patient gardeners: plant in rich soil, water deeply once a week, stake or cage the young plants for support, prune suckers for airflow, and harvest the fruit once it is fully colored.",
  },
  {
    externalId: "redis-cache",
    title: "Redis cache eviction",
    text: "Redis serves as an in-memory cache with a configurable max-memory limit. When memory fills, an eviction policy such as LRU or LFU removes keys, and each key can carry a TTL so it expires automatically after a set time.",
  },
];

export const EVAL_QUESTIONS: EvalQuestion[] = [
  {
    id: "q-hnsw",
    query:
      "How do I tune an HNSW index for vector similarity search in Postgres?",
    relevant: ["pg-hnsw"],
  },
  {
    id: "q-rrf",
    query: "What is reciprocal rank fusion in hybrid search?",
    relevant: ["rrf-fusion"],
  },
  {
    id: "q-redis",
    query: "How does Redis evict keys when memory is full?",
    relevant: ["redis-cache"],
  },
  {
    id: "q-chunk",
    query:
      "How do I split a markdown document into chunks that respect headings?",
    relevant: ["chunking"],
  },
  {
    id: "q-oauth",
    query: "How do OAuth refresh tokens get a new access token?",
    relevant: ["oauth"],
  },
  {
    id: "q-ratelimit",
    query: "How do I throttle API requests with a token bucket and return 429?",
    relevant: ["rate-limit"],
  },
  {
    id: "q-docker",
    query: "How do I build a container image from a Dockerfile?",
    relevant: ["docker"],
  },
  {
    id: "q-k8s",
    query:
      "How do I scale pods by raising the replica count in a Kubernetes deployment?",
    relevant: ["k8s"],
  },
  {
    id: "q-espresso",
    query: "What pump pressure is needed to pull an espresso shot?",
    relevant: ["espresso"],
  },
  {
    id: "q-sailing",
    query: "How do I trim the sails when sailing upwind?",
    relevant: ["sailing"],
  },
  {
    id: "q-tomato",
    query: "When should I water and stake tomato plants?",
    relevant: ["gardening"],
  },
  {
    id: "q-gemini",
    query: "What embedding model and how many dimensions does Gemini produce?",
    relevant: ["gemini-embed"],
  },
  {
    id: "q-seqscan",
    query:
      "Why is my SQL query doing a sequential scan instead of using an index?",
    relevant: ["sql-index"],
  },
  {
    id: "q-pgbackup",
    query: "How do I back up Postgres and restore to a point in time with WAL?",
    relevant: ["pg-backup"],
  },
  // Multi-document questions: more than one document is a correct answer.
  {
    id: "q-pg-indexes",
    query:
      "How does Postgres use indexes to speed up queries and vector search?",
    relevant: ["sql-index", "pg-hnsw"],
    note: "Both Postgres-index docs are relevant.",
  },
  {
    id: "q-hybrid-stack",
    query:
      "How do dense embedding vectors and sparse ranking combine in hybrid retrieval?",
    relevant: ["rrf-fusion", "gemini-embed"],
    note: "Fusion + the embedding model that produces the dense side.",
  },
  {
    id: "q-containers",
    query: "How do container images and orchestration with pods relate?",
    relevant: ["docker", "k8s"],
    note: "Docker images run as Kubernetes pods.",
  },
];
