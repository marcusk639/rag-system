# CPA Real-Embedder Eval

provider=local model=Xenova/bge-base-en-v1.5 dims=768
weights dense=0.3 sparse=0.7

Retrieval eval — weights dense=0.3 sparse=0.7 | 20 questions
k recall precision nDCG
@1 97.5% 100.0% 100.0%
@3 100.0% 35.0% 100.0%
@5 100.0% 21.0% 100.0%
@10 100.0% 10.5% 100.0%
MRR: 1.000

## Negative (out-of-corpus) top scores

Highest negative top-score (RRF, per-query-normalized): 1.0000

**Caveat:** `RetrievalResult.score` is normalized WITHIN each query's own result set (rank-1 always lands at ~1.0000 regardless of query relevance — see `hybridSearch` in `packages/db/src/queries.ts`). A max-negative-top-score of ~1.0000 is therefore an expected artifact of the normalization, NOT evidence of poor retrieval separation. The raw component scores below are the valid, cross-query-comparable separation signal.

- cpa-n01: score=1.0000 dense=0.5956 sparse=0.0000
- cpa-n02: score=1.0000 dense=0.6211 sparse=0.0000
- cpa-n03: score=1.0000 dense=0.5883 sparse=0.0000
- cpa-n04: score=1.0000 dense=0.5889 sparse=0.0000
- cpa-n05: score=1.0000 dense=0.6218 sparse=0.0000
- cpa-n06: score=1.0000 dense=0.5726 sparse=0.0000
- cpa-n07: score=1.0000 dense=0.6324 sparse=0.0000
- cpa-n08: score=1.0000 dense=0.5711 sparse=0.0000

### Raw component separation (valid cross-query signal)

| component           | lowest positive (rank-1) | highest negative (rank-1) | separation holds? |
| ------------------- | ------------------------ | ------------------------- | ----------------- |
| dense (cosine)      | 0.5868                   | 0.6324                    | NO                |
| sparse (ts_rank_cd) | 0.0000                   | 0.0000                    | NO                |
