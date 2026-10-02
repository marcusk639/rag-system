# docs/compliance/

Compliance artifacts required by the §7216 / CPA deployment gate.

## Conformance records

Point-in-time checks of the running system against the scope contract in
`~/dev/cpa-consulting/docs/rag/compliance-scope.md`. These are engineering
evidence for counsel, not self-certifications — each row carries a file/line or a
measured value, and gaps are recorded as gaps.

- `scope-conformance-2026-09-30.md` — for P0 gate #2 (counsel + carrier sign-off).
  Naming: `scope-conformance-<YYYY-MM-DD>.md`. Supersede by adding a newer dated
  file; do not edit an old one, so a reader can see what moved.

**These do NOT satisfy the boot-time DPA check below** — that matches
`vendor-dpa-<vendor>.md` only (`packages/core/src/config.ts:778-782`).

## DPA files

When `COMPLIANCE_MODE=client-data` is set, the service refuses to boot
unless at least one `vendor-dpa-<vendor>.md` file exists in this directory.

**Naming convention:** `vendor-dpa-<vendor>.md`

Examples:

- `vendor-dpa-google-gemini.md` — Google (Gemini generation API)
- `vendor-dpa-openai.md` — OpenAI
- `vendor-dpa-cohere.md` — Cohere (reranker)

## What a DPA file must record

Each file must include:

1. **Vendor name and service** — e.g. "Google LLC — Gemini API"
2. **DPA reference** — link or document ID of the signed agreement
3. **Date signed** — ISO 8601 (YYYY-MM-DD)
4. **No-train clause confirmed** — yes/no; the vendor does NOT train on customer data
5. **Zero-retention confirmed** — yes/no; the vendor does NOT retain inputs/outputs
6. **Data region** — e.g. "United States"
7. **§7216 + GLBA adequacy** — [COUNSEL] sign-off date and name
8. **Renewal / expiry date** — if applicable

## Template

Copy and fill in `vendor-dpa-TEMPLATE.md` (below) for each vendor:

```markdown
# Vendor DPA: <Vendor Name> — <Service>

| Field                 | Value               |
| --------------------- | ------------------- |
| Vendor                |                     |
| Service               |                     |
| DPA reference         |                     |
| Date signed           |                     |
| No-train clause       | ☐ confirmed         |
| Zero-retention clause | ☐ confirmed         |
| Data region           |                     |
| §7216 + GLBA adequacy | [COUNSEL] sign-off: |
| Renewal / expiry      |                     |

## Notes

<any additional conditions, restrictions, or relevant provisions>
```

## Activation

Once a DPA file is in place, enable client-data mode in your `.env`:

```env
COMPLIANCE_MODE=client-data
EMBEDDING_PROVIDER=local          # required: no TRI egress for embeddings
EGRESS_ALLOWED_HOSTS=             # lock down to empty unless DPA covers the host
```
