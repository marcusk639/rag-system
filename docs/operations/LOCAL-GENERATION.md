---
title: Self-hosted (air-gapped) generation
status: current
last_verified: 2026-10-21
verified_against: be4b30e
answers: How to point answer generation at an OpenAI-compatible model on your own network so no prompt text leaves it, and how to prove that it doesn't.
read_when: Deploying where a hosted LLM is not allowed (42 CFR Part 2, HIPAA, engagement terms), or evaluating a self-hosted model.
supersedes: []
code:
  [
    packages/core/src/generation-credentials.ts,
    packages/rag/src/generation/generator.ts,
    packages/runtime/src/index.ts,
    tests/e2e/src/eval/run-local-generation-eval.ts,
  ]
---

# Self-hosted (air-gapped) generation

Set `GENERATION_PROVIDER=openai`, `GENERATION_BASE_URL` to your server and `EGRESS_ALLOWED_HOSTS` to that server's host,
and generation runs against a model on your own network. Add `EMBEDDING_PROVIDER=local` (ONNX, in-process) and the
deployment makes no outbound model calls at all. Gemini can't be used this way, and the TRI scan is never relaxed
automatically.

This exists because some deployments can't use a hosted API: a treatment center under 42 CFR Part 2, a hospital under
HIPAA, or a firm whose engagement terms forbid third-party disclosure. Without it, such a corpus can be indexed but not
answered from.

## Requirements

Any OpenAI-compatible server works. The default ports below come from each project's documentation. They have not
been exercised in this environment.

| Server    | Typical base URL            | Notes                          |
| --------- | --------------------------- | ------------------------------ |
| Ollama    | `http://127.0.0.1:11434/v1` | Easiest to stand up            |
| vLLM      | `http://127.0.0.1:8000/v1`  | Best throughput for many users |
| LM Studio | `http://127.0.0.1:1234/v1`  | GUI, useful for evaluation     |
| llama.cpp | `http://127.0.0.1:8080/v1`  | `llama-server --api-key ...`   |

**Port clash:** vLLM's default port 8000 is also the parser's. `PARSER_URL` defaults to `http://localhost:8000`
(`packages/core/src/config.ts`), and the parser container listens on 8000. On a single host, start vLLM on another port
(`--port 8001`), or set `PARSER_URL` explicitly. Otherwise parse requests or generation requests hit the wrong server.

## Configuration

```bash
GENERATION_PROVIDER=openai          # required; see "Gemini cannot be self-hosted this way"
GENERATION_MODEL=llama3.1:8b        # the model name the server exposes
GENERATION_BASE_URL=http://127.0.0.1:11434/v1
EGRESS_ALLOWED_HOSTS=127.0.0.1      # required; see below

EMBEDDING_PROVIDER=local            # for a fully air-gapped deployment
```

The env.example comment block next to `GENERATION_BASE_URL` is the canonical reference for these variables.

### Which API key is sent

`GENERATION_API_KEY` is optional. Most self-hosted servers ignore it. When it is unset, a placeholder
(`local-endpoint-no-key`) is sent, because the OpenAI SDK rejects an empty key. The precedence
(`packages/core/src/generation-credentials.ts` `resolveGenerationCredentials`):

1. `GENERATION_API_KEY`, if set, always wins.
2. Otherwise, when `GENERATION_BASE_URL` is set, the placeholder is sent, **never** the embedding provider's key.
3. Otherwise, in the hosted case, the embedding provider's key (`GEMINI_API_KEY` or `OPENAI_API_KEY`) is inherited, but
   only when generation and embedding name the same vendor. `claude` never inherits one.

A self-hosted endpoint is not verifiably yours, which is the same reason the TRI scan isn't relaxed for it, so it isn't
handed a hosted vendor's production key by default. If your server requires auth (llama.cpp or vLLM `--api-key`, or a
reverse proxy in front of it), set `GENERATION_API_KEY` explicitly.

## The egress allow-list applies to your endpoint

`EGRESS_ALLOWED_HOSTS` is a deny-by-default allow-list, and it checks the host actually being called. If
`GENERATION_BASE_URL` points at `127.0.0.1` and the list doesn't name it, every `/ask` fails with `EGRESS_BLOCKED`
(HTTP 503). This is deliberate: the allow-list must never vouch for a host other than the one being contacted.

Removing `api.openai.com` and `generativelanguage.googleapis.com` once you are fully self-hosted is the point of the
exercise. It turns a misconfiguration that would reach a third party into a loud failure. Keep any host you still
need: a hosted embedding provider, or `ollama.railway.internal` for the content scanner.

## Gemini cannot be self-hosted this way

`GENERATION_PROVIDER=gemini` with `GENERATION_BASE_URL` set **throws at startup** (`packages/rag/src/generation/generator.ts`
`GEMINI_BASE_URL_REFUSAL`). The Google SDK does expose `httpOptions.baseUrl`; the refusal is a design choice.
Self-hosted generation goes through the `openai` provider only, because that provider is a client for any
OpenAI-compatible server and one self-hosted path is easier to keep honest than two. Accepting the setting on the
Gemini path would let you believe you were self-hosted while every prompt went to Google, so it fails loudly instead.

## The TRI scan is not relaxed automatically

`GENERATION_TRI_POLICY` keeps whatever value you gave it. A local-looking host isn't verifiably local
(`localhost:11434` can be an SSH tunnel to anywhere), so nothing infers "self-hosted, therefore safe".

Where you genuinely control the endpoint, the scan guards against a disclosure that can't happen, and
`GENERATION_TRI_POLICY=off` is a defensible choice. Make it deliberately. `COMPLIANCE_MODE=client-data` forces `block`
regardless, overriding even an explicit `off` (`packages/runtime/src/index.ts` `resolveTriPolicy`). A deployment that
has declared client data in scope can't select `off` at all.

## Verifying

1. Boot the API. The log should include `generation using a self-hosted endpoint` with your base URL. That line is
   emitted only after the host has passed the `EGRESS_ALLOWED_HOSTS` check. If it is missing, look for the error line
   `GENERATION_BASE_URL host is not in EGRESS_ALLOWED_HOSTS`. The API still boots and serves retrieval in that case,
   but every `/ask` will fail.
2. Ask a question through `/ask` and confirm you get a cited answer.
3. Remove your endpoint's host from `EGRESS_ALLOWED_HOSTS`, restart, and ask again. It must fail with `EGRESS_BLOCKED`.
   If it succeeds, the allow-list isn't being applied to your endpoint: stop and investigate.
4. For an air-gapped claim, confirm with `tcpdump` or the host firewall that no outbound connection leaves the network
   during a query. Configuration review is not evidence.

Done when: steps 2 and 3 behave as described, and step 4 has a captured record if you are claiming air-gapped operation.

## Comparing self-hosted models

`tests/e2e/src/eval/run-local-generation-eval.ts` runs a list of models (`LOCAL_EVAL_MODELS=qwen2.5:3b,llama3.1:8b`)
against the same locally seeded corpus, holding retrieval constant. It reports citation validity, self-retrieval and
refusal on out-of-corpus negatives. It measures grounding, not correctness. Its refusal count is a floor, and its
"confabulated" list is an upper bound to read by hand. It **truncates the target database**, so point `DATABASE_URL`
at a local dev database only. The header comment in the file has the usage line. Evaluation in general is in
[`EVALUATION.md`](../evaluation/EVALUATION.md).
