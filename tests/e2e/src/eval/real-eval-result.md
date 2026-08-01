### Provider: `gemini` (model `gemini-embedding-001`, 768d)

Corpus: 14 documents / 17 questions (see `corpus.ts` — this is the "STARTER set," vocabulary-distinctive, no semantic-similarity difficulty; treat these numbers as a floor, not a ceiling).

Default weights (dense=0.7, sparse=0.3):

| k   | recall@k | precision@k | nDCG@k |
| --- | -------- | ----------- | ------ |
| 1   | 91.2%    | 100.0%      | 100.0% |
| 3   | 100.0%   | 39.2%       | 99.1%  |
| 5   | 100.0%   | 23.5%       | 99.1%  |
| 10  | 100.0%   | 11.8%       | 99.1%  |

MRR: 1.000

Weight sweep (recall@5 / nDCG@5 / MRR):

| dense | sparse | recall@5 | nDCG@5 | MRR   |
| ----- | ------ | -------- | ------ | ----- |
| 1     | 0      | 100.0%   | 99.1%  | 1.000 |
| 0.7   | 0.3    | 100.0%   | 99.1%  | 1.000 |
| 0.5   | 0.5    | 100.0%   | 99.1%  | 1.000 |
| 0.3   | 0.7    | 100.0%   | 99.1%  | 1.000 |
| 0     | 1      | 100.0%   | 99.1%  | 1.000 |
