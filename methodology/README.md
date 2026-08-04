# methodology/ — generic, portable, authored first

**Owner: Marcus Klein.** Background IP under Schedule A of the pre-employment IP
instrument.

Everything in this directory is **generic by construction**: methods, schemas,
prompt structures, evaluation harnesses, and patterns that reference no client,
no firm, and no tenant-specific configuration.

## The one rule

> **Flow is one-way: `methodology/` → `clients/*/`. Never the reverse.**

Client-specific work may be _derived from_ generic material here. Generic
material may **not** be extracted back out of client work without explicit
de-identification **and** written permission.

## Why this is a directory and not a policy

A generic template _extracted later_ from a firm-owned artifact is **derivative
of a work the firm owns** — under 17 U.S.C. §201(b), work made for hire vests in
the employer automatically. Residuals clauses protect **unaided memory only**; a
repository is recorded material with no such protection.

Authored here **first and separately**, the generic version is neither. That is
the entire reason this directory exists, and it only works if the sequencing is
real: **write the generic version here, then specialise it into `clients/`.**
Retrofitting does not work, and it cannot be fixed after the fact.

## What belongs here

- Retrieval, ingestion, and evaluation methods
- Schemas: issue register, solution design, gold set, corpus claims
- Prompt and agent structures
- The data-classification model as a model (**not** its mapping onto any specific
  tenant's systems)

## What does not

Anything naming a client, a firm, a staff member, or a tenant configuration.
That is `clients/<name>/`, and it belongs to that client or firm.
