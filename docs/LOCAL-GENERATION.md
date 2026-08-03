# Self-Hosted (Air-Gapped) Generation

Point generation at a model running on the client's own network, so no prompt
text reaches a third party. Combined with `EMBEDDING_PROVIDER=local` (ONNX,
in-process) the deployment makes no outbound calls at all.

This exists because some deployments cannot use a hosted API: a treatment
center under 42 CFR Part 2, a hospital under HIPAA, or a firm whose engagement
terms forbid third-party disclosure. Without it, such a corpus can be indexed
but not answered from.

## Requirements

Any OpenAI-compatible server. Verified shapes:

| Server    | Typical base URL            | Notes                          |
| --------- | --------------------------- | ------------------------------ |
| Ollama    | `http://127.0.0.1:11434/v1` | Easiest to stand up            |
| vLLM      | `http://127.0.0.1:8000/v1`  | Best throughput for many users |
| LM Studio | `http://127.0.0.1:1234/v1`  | GUI, useful for evaluation     |
| llama.cpp | `http://127.0.0.1:8080/v1`  | `llama-server --api-key ...`   |

## Configuration

```bash
GENERATION_PROVIDER=openai          # required — see "Gemini" below
GENERATION_MODEL=llama3.1:8b        # the model name the server exposes
GENERATION_BASE_URL=http://127.0.0.1:11434/v1
EGRESS_ALLOWED_HOSTS=127.0.0.1      # REQUIRED — see below

EMBEDDING_PROVIDER=local            # for a fully air-gapped deployment
```

`GENERATION_API_KEY` is optional. Self-hosted servers ignore it; when no key is
configured anywhere, a placeholder is sent because the OpenAI SDK requires a
non-empty value.

## The egress allow-list applies to your endpoint

`EGRESS_ALLOWED_HOSTS` is a deny-by-default allow-list, and it validates the
host you are actually calling. If `GENERATION_BASE_URL` points at
`127.0.0.1` and the allow-list does not name it, every request fails with
`EGRESS_BLOCKED` (HTTP 503). This is deliberate: the allow-list must never
vouch for a host that is not the one being contacted.

Removing `api.openai.com` and `generativelanguage.googleapis.com` from the
list once you are fully self-hosted is the point of the exercise — it makes a
misconfiguration that would reach a third party fail loudly.

## Gemini cannot be self-hosted this way

`GENERATION_PROVIDER=gemini` with `GENERATION_BASE_URL` set **throws at
startup**. The Google SDK has no equivalent option, so accepting the setting
would leave you believing you were self-hosted while every prompt went to
Google. Use `GENERATION_PROVIDER=openai` — that provider is a client for any
OpenAI-compatible server, not only OpenAI's.

## The TRI scan is not relaxed automatically

`GENERATION_TRI_POLICY` keeps whatever value you gave it. A local-looking host
is not verifiably local — `localhost:11434` can be an SSH tunnel to anywhere —
so nothing infers "self-hosted, therefore safe."

Where you genuinely control the endpoint, the scan is guarding against a
disclosure that cannot occur, and `GENERATION_TRI_POLICY=off` is a defensible
choice. Make it deliberately. Note that `COMPLIANCE_MODE=client-data` forces
`block` regardless, so a deployment that has declared client data in scope
cannot select `off` by omission.

## Verifying

1. Boot the API. The log should carry `generation using a self-hosted endpoint`
   with your base URL.
2. Ask a question through `/ask` and confirm you get a cited answer.
3. Remove your endpoint's host from `EGRESS_ALLOWED_HOSTS`, restart, and ask
   again. It must fail with `EGRESS_BLOCKED`. If it succeeds, the allow-list is
   not being applied to your endpoint — stop and investigate.
4. For a genuinely air-gapped claim, confirm with `tcpdump` or the host
   firewall that no outbound connections leave the network during a query.
   Configuration review is not evidence.
