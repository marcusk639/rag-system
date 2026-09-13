import { markdownDoc } from "@rag/test-fixtures";

export const FIXTURE_SOURCE_NAME = "web-e2e-fixture-source";
export const NONCE_A = "zephyrine-quokka";
export const NONCE_B = "marmalade-thistledown";

export const FIXTURE_DOCS = [
  markdownDoc({
    externalId: "web-e2e-onboarding",
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
    externalId: "web-e2e-facilities",
    title: "Admin - Note - Office Equipment",
    markdown: [
      "# Office Equipment",
      "",
      "Printers are serviced quarterly by the facilities vendor.",
      `Toner is ordered against the ${NONCE_B} purchase code.`,
    ].join("\n"),
  }),
];
