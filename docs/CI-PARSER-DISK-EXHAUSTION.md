# CI: the `parser` job exhausts runner disk

**Status:** 🟠 open, unfixed. **Blocks every PR**, not just the one that found it.
**Found:** 2026-09-02, on PR #50 (a docs-only change).
**Merged over:** yes — PR #50 was merged with this red. Reasoning in [§7](#7-why-pr-50-was-merged-with-this-red).

---

## 1. What fails

Two of three CI jobs fail. One root cause.

| Job       | Result   | Failure                                                                                                             |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `e2e`     | **pass** | —                                                                                                                   |
| `parser`  | fail     | `ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device`                           |
| `quality` | fail     | `failed to solve: process "/bin/sh -c pip install -r requirements.txt" did not complete successfully: exit code: 1` |

`parser` fails in its own `Install dependencies` step. `quality` fails later, in
`Unit tests`, because `pnpm test` recurses into `@rag/e2e`, whose global setup
runs `docker compose up -d`, which builds `services/parser-py/Dockerfile`, whose
`RUN pip install -r requirements.txt` hits the same wall. Same cause, two
symptoms, one fix.

## 2. It is not caused by the change that surfaced it

Worth stating explicitly, because the instinct on a red pipeline is to look at
the diff:

1. **The diff cannot reach it.** PR #50 touched `CLAUDE.md`,
   `docs/HANDOFF-2026-09-02.md`, and `docs/PILOT-LAUNCH-STATUS.md`. No
   `requirements.txt`, no Dockerfile, no source.
2. **`main` passed with identical dependencies.** Commit `15aa017` passed both
   `CI` and `E2E` on 2026-09-01, and `services/parser-py/requirements.txt` is
   byte-identical between it and PR #50's head.
3. **The dedicated `e2e` job passed on the same commit**, so the suite and the
   compose stack are both fine.

The conclusion that matters: **this is latent on `main` right now.** The next PR
to touch anything will hit it. It is not a branch-local problem waiting for
someone to rebase.

## 3. Root cause

`services/parser-py/requirements.txt:14`:

```
unstructured[local-inference]==0.16.11
```

The `local-inference` extra pulls the full document-layout vision stack —
`torch`, `torchvision`, `layoutparser`, `effdet`, `timm`, `onnx`,
`onnxruntime`, `opencv-python`, `pycocotools`. And because `torch`'s default
PyPI wheel for `linux_x86_64` is the **GPU build**, it drags the CUDA runtime in
with it. From the failing install list, verbatim:

```
nvidia-cusparselt-cu13, nvidia-nvtx, nvidia-nvshmem-cu13, nvidia-nvjitlink,
nvidia-nccl-cu13, nvidia-curand, nvidia-cufile, nvidia-cuda-runtime,
nvidia-cuda-nvrtc, nvidia-cuda-cupti, nvidia-cusparse, nvidia-cufft,
nvidia-cublas, nvidia-cusolver, nvidia-cudnn-cu13,
cuda-toolkit, cuda-bindings, cuda-pathfinder, triton
```

Nineteen CUDA/GPU packages. **Nothing in this system has a GPU.** The parser runs
as a CPU container on Railway; the CI runner is CPU-only. Every byte of that is
installed, never loaded, and here it is what tips the runner over.

### Why it started failing now

The direct dependencies are pinned — 10 of the 11 requirement lines carry `==`.
The **transitive** ones are not. `torch`, `torchvision`, `scipy` and the
`nvidia-*` wheels are resolved fresh on every build, and they only grow. Note
`cu13` in those names and `torchvision-0.29.0` in the install list: the CUDA 13
generation of wheels is materially larger than what resolved a day earlier.

So the trigger was upstream publication, not anything in this repo. That is
precisely why it is dangerous: **the build is not reproducible**, so it can break
without a commit, and it broke between 2026-09-01 16:00 and 2026-09-02 15:56.

## 4. A second, independent problem this exposed

`.github/workflows/ci.yml:64-65`:

```yaml
- name: Unit tests
  run: pnpm test
```

`pnpm test` is `pnpm -r run test`, which includes `@rag/e2e`. So the `quality`
job builds Docker images and runs the full e2e suite — despite:

- a **separate `e2e` job** already doing exactly that (and passing), and
- `CLAUDE.md` documenting pre-push as deliberately `--filter '!@rag/e2e'`
  because e2e needs Docker, and
- `ci.yml:3` describing this very job as a "Fast, infra-free quality gate:
  build + typecheck + lint + unit tests."

The job is not infra-free and has not been for as long as that comment has been
wrong. This is why a Python dependency problem can fail the TypeScript quality
gate, and it doubles e2e's wall-clock cost on every run.

## 5. Options

| #     | Fix                                                   | Effort    | Reduces install | Risk                                   |
| ----- | ----------------------------------------------------- | --------- | --------------- | -------------------------------------- |
| **1** | Install CPU-only torch from PyTorch's CPU index       | ~15 min   | large           | very low — same code paths on CPU      |
| **2** | Filter e2e out of the `quality` job                   | ~5 min    | none            | very low — `e2e` job already covers it |
| **3** | Reclaim runner disk before install                    | ~10 min   | none            | low — but treats the symptom           |
| **4** | Pin the transitive ML deps (lockfile / `pip-compile`) | ~1 h      | none            | low — restores reproducibility         |
| **5** | Drop `local-inference` and force `strategy="fast"`    | ~half day | very large      | **real** — changes parsing behaviour   |

### Option 1 — CPU-only torch

```
--extra-index-url https://download.pytorch.org/whl/cpu
unstructured[local-inference]==0.16.11
```

Or pin the CPU builds explicitly. This removes all nineteen CUDA packages and
`triton`. Behaviour on a CPU host is identical, because the GPU wheel's CUDA
libraries are dead weight there — torch dispatches to the CPU backend either
way.

### Option 5 — the biggest win, and why it is not first

`app/main.py:307` calls `partition(filename=str(path))` with **no `strategy=`
argument**, so whatever unstructured's default resolves to is what runs, and for
scanned PDFs that can reach the `hi_res` layout model — which is the only reason
the vision stack is there at all. Unstructured is also just a _fallback_:
`main.py:249` tries MarkItDown first and only falls through on failure. And OCR
proper comes from the `tesseract-ocr` **system** package installed in the
Dockerfile, not from torch.

So there is a real possibility that `local-inference` is unnecessary and the
whole stack could go. But proving that needs the scanned-PDF path exercised
against real documents, and getting it wrong degrades parsing quality silently —
a document returns worse markdown, nothing errors. That is a deliberate piece of
work, not a CI unblock.

## 6. Recommendation

**Do 1 and 2 now. Then 4. Treat 5 as separate work, and 3 only if 1 is somehow
insufficient.**

Reasoning:

**Option 1 first, because it is the only fix that is simultaneously the largest
and the safest.** It removes gigabytes by declining to install software for
hardware that does not exist. There is no behavioural tradeoff to weigh on a CPU
host, which is rare enough in a CI fix to be worth taking immediately. Every
other option either treats a symptom (3), costs behaviour risk (5), or does not
reduce the install at all (2, 4).

**Option 2 alongside it, because it is unrelated cheap correctness.** It restores
the job to what its own comment claims, stops a Python problem from failing the
TypeScript gate, and removes a duplicated e2e run. It would also have contained
_this_ incident to one red job instead of two — and, note, would have let PR #50
merge on a green `quality`.

**Option 4 next, because 1 fixes today's failure while 4 fixes the class.** The
real defect is that the build is not reproducible: an upstream release broke CI
with no commit, and it will happen again. Pinning is the cure, but it is also
churn — it needs a refresh discipline, or pins rot into a security liability. So
it is important, not urgent, and it should follow rather than block.

**Option 3 explicitly not, as a primary fix.** Reclaiming disk to make room for
libraries nothing loads is the wrong shape of solution: it buys headroom that the
next upstream release consumes, and it hides the real problem — an image carrying
a GPU stack it cannot use. Worth adding as belt-and-braces after 1, not instead
of it.

**Option 5 deferred on risk asymmetry.** It is the largest win and the most
likely to be _correct_ in the long run — the parser probably does not need the
vision stack. But its failure mode is silent quality regression in document
parsing, which in this system means worse retrieval from a corpus that has
already been purged once. That deserves its own change, its own eval evidence,
and its own review — not a slot in an urgent CI fix.

### Verification for whoever does this

```bash
# Before: watch it install nineteen CUDA packages
docker build --no-cache -t parser-before services/parser-py
docker image inspect parser-before --format '{{.Size}}'

# After option 1: no nvidia-*, no triton, image materially smaller
docker build --no-cache -t parser-after services/parser-py
docker image inspect parser-after --format '{{.Size}}'
docker run --rm parser-after pip list | grep -icE 'nvidia|triton'   # expect 0

# Parsing must be unchanged, not just smaller
cd services/parser-py && pytest
```

The `pip list | grep -c` check is the one that actually proves option 1 worked.
Image size alone can shrink for unrelated reasons.

## 7. Why PR #50 was merged with this red

PR #50 carried the migration handoff — the document telling a session on new
hardware how to resume in-flight work. Leaving it unmerged had a concrete cost:
a fresh clone checks out `main`, so on a branch neither the handoff nor its
`CLAUDE.md` pointer would have been found.

Set against that, the risk of merging was as close to zero as it gets: the change
is three markdown files, and the failing job is a Python dependency install that
`main` was already going to fail on its next PR regardless. Merging did not
introduce the breakage, worsen it, or hide it — it is written down here, linked
from the standing backlog, and the fix is the same either way.

Waiting for green would have blocked a time-sensitive document behind an
unrelated infrastructure failure that no amount of waiting fixes.
