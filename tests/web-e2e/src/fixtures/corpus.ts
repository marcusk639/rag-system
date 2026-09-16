import { markdownDoc } from "@rag/test-fixtures";

export const FIXTURE_SOURCE_NAME = "web-e2e-fixture-source";
/** A source the fixture user is deliberately NOT granted (see seed.ts). */
export const OUT_OF_SCOPE_SOURCE_NAME = "web-e2e-out-of-scope-source";

/**
 * Nonces: invented tokens that exist nowhere except in these fixtures. An
 * answer can only contain one if the document carrying it reached the model's
 * context — which is what lets the specs check answer CONTENT soundly without
 * a golden corpus.
 */
export const NONCE_A = "zephyrine-quokka";
export const NONCE_B = "marmalade-thistledown";
export const NONCE_C = "obsidian-halyard";
export const NONCE_D = "periwinkle-gantry";

export const DOC_A_EXTERNAL_ID = "web-e2e-onboarding";
export const DOC_B_EXTERNAL_ID = "web-e2e-facilities";
export const DOC_C_EXTERNAL_ID = "web-e2e-partner-draws";
export const DOC_D_EXTERNAL_ID = "web-e2e-courier";

export const FIXTURE_DOCS = [
  markdownDoc({
    externalId: DOC_A_EXTERNAL_ID,
    title: "Admin - SOP - New Client Onboarding",
    markdown: [
      "# New Client Onboarding",
      "",
      `The first step is to open a Karbon work item named "Client Intake".`,
      `Completing the ${NONCE_A} checklist is mandatory before any engagement`,
      "letter is countersigned.",
    ].join("\n"),
  }),
  markdownDoc({
    externalId: DOC_B_EXTERNAL_ID,
    title: "Admin - Note - Office Equipment",
    markdown: [
      "# Office Equipment",
      "",
      "Printers are serviced quarterly by the facilities vendor.",
      // State the nonce as the code's VALUE. The earlier phrasing "ordered
      // against the <nonce> purchase code" reads as naming a code without
      // giving it, and llama3.1:8b refused "What purchase code is toner
      // ordered against?" 5/5 under the prompt's no-stretching rule.
      `The purchase code for toner orders is ${NONCE_B}.`,
    ].join("\n"),
  }),
  /**
   * Deliberately NAME-SHAPED ("billed against the <nonce> account code"), the
   * phrasing real SOPs use. With doc A in context — which closely mirrors the
   * worked example in generator.ts's prompt — llama3.1:8b refused this exact
   * shape 5/5, while removing either the prompt example or doc A made it answer
   * 5/5. This document exists to measure that interference on the pilot model.
   */
  markdownDoc({
    externalId: DOC_D_EXTERNAL_ID,
    title: "Admin - Note - Courier Shipments",
    markdown: [
      "# Courier Shipments",
      "",
      "Outbound client packages are sent by overnight courier.",
      `Courier shipments are billed against the ${NONCE_D} account code.`,
    ].join("\n"),
  }),
];

/**
 * Ingested into OUT_OF_SCOPE_SOURCE_NAME, which the fixture user has no grant
 * to. It must never be retrieved, cited, or fetchable for that user.
 */
export const OUT_OF_SCOPE_DOCS = [
  markdownDoc({
    externalId: DOC_C_EXTERNAL_ID,
    title: "Partners - SOP - Partner Draws",
    markdown: [
      "# Partner Draws",
      "",
      `Partner draws are reconciled monthly against the ${NONCE_C} ledger.`,
    ].join("\n"),
  }),
];
