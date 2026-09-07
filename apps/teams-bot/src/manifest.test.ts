import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderManifest } from "./manifest.js";

const TEMPLATE = JSON.stringify({
  id: "${MICROSOFT_APP_ID}",
  developer: { name: "${DEVELOPER_NAME}" },
  webApplicationInfo: { id: "${MICROSOFT_APP_ID}", resource: "${BOT_ENTRA_SSO_SCOPE}" },
});

const ENV = {
  MICROSOFT_APP_ID: "11111111-2222-3333-4444-555555555555",
  DEVELOPER_NAME: "TWK CPA Firm",
  BOT_ENTRA_SSO_SCOPE: "api://botid-11111111-2222-3333-4444-555555555555/access_as_user",
};

describe("renderManifest", () => {
  it("substitutes every placeholder, including repeated ones", () => {
    const out = JSON.parse(renderManifest(TEMPLATE, ENV));
    expect(out.id).toBe(ENV.MICROSOFT_APP_ID);
    expect(out.webApplicationInfo.id).toBe(ENV.MICROSOFT_APP_ID);
    expect(out.developer.name).toBe("TWK CPA Firm");
  });

  it("names EVERY missing variable, not just the first", () => {
    expect(() => renderManifest(TEMPLATE, { MICROSOFT_APP_ID: "x" })).toThrow(
      /DEVELOPER_NAME.*BOT_ENTRA_SSO_SCOPE|BOT_ENTRA_SSO_SCOPE.*DEVELOPER_NAME/s,
    );
  });

  it("treats an empty value as missing", () => {
    expect(() => renderManifest(TEMPLATE, { ...ENV, DEVELOPER_NAME: "  " })).toThrow(
      /DEVELOPER_NAME/,
    );
  });

  it("rejects an app id that is not a GUID — the commonest go-live typo", () => {
    expect(() => renderManifest(TEMPLATE, { ...ENV, MICROSOFT_APP_ID: "botid-1234" })).toThrow(
      /MICROSOFT_APP_ID.*GUID/,
    );
  });

  it("rejects an SSO scope that does not match the app id", () => {
    expect(() =>
      renderManifest(TEMPLATE, {
        ...ENV,
        BOT_ENTRA_SSO_SCOPE: "api://botid-99999999-2222-3333-4444-555555555555/access_as_user",
      }),
    ).toThrow(/BOT_ENTRA_SSO_SCOPE/);
  });

  it("produces output with no placeholder left behind", () => {
    expect(renderManifest(TEMPLATE, ENV)).not.toMatch(/\$\{/);
  });

  it("accepts a scope whose GUID differs only in case — both refer to one app", () => {
    const upper = ENV.MICROSOFT_APP_ID.toUpperCase();
    expect(() =>
      renderManifest(TEMPLATE, { ...ENV, MICROSOFT_APP_ID: upper }),
    ).not.toThrow();
  });

  it("accepts the api://<domain>/botid-<guid>/ form Teams allows for tab+bot apps", () => {
    expect(() =>
      renderManifest(TEMPLATE, {
        ...ENV,
        BOT_ENTRA_SSO_SCOPE: `api://kb.example.com/botid-${ENV.MICROSOFT_APP_ID}/access_as_user`,
      }),
    ).not.toThrow();
  });

  it.each([
    ["missing the botid- prefix", `api://${ENV.MICROSOFT_APP_ID}/access_as_user`],
    ["a wrong host", `https://evil.example.com/${ENV.MICROSOFT_APP_ID}`],
    ["the id inside a longer GUID", `api://botid-a${ENV.MICROSOFT_APP_ID}b/access_as_user`],
    ["unstructured text", `garbage ${ENV.MICROSOFT_APP_ID} garbage`],
  ])("rejects a structurally wrong scope: %s", (_label, BOT_ENTRA_SSO_SCOPE) => {
    expect(() => renderManifest(TEMPLATE, { ...ENV, BOT_ENTRA_SSO_SCOPE })).toThrow(
      /BOT_ENTRA_SSO_SCOPE/,
    );
  });
});

describe("the real manifest template", () => {
  const template = readFileSync(
    new URL("../manifest/manifest.json", import.meta.url),
    "utf8",
  );

  it("renders to valid JSON with a full set of values", () => {
    const out = JSON.parse(
      renderManifest(template, {
        ...ENV,
        DEVELOPER_WEBSITE_URL: "https://example.com",
        DEVELOPER_PRIVACY_URL: "https://example.com/privacy",
        DEVELOPER_TERMS_OF_USE_URL: "https://example.com/terms",
      }),
    );
    expect(out.id).toBe(ENV.MICROSOFT_APP_ID);
    expect(out.webApplicationInfo.resource).toBe(ENV.BOT_ENTRA_SSO_SCOPE);
  });

  it("names every variable the packager needs when the environment is empty", () => {
    expect(() => renderManifest(template, {})).toThrow(
      /DEVELOPER_WEBSITE_URL|DEVELOPER_PRIVACY_URL|DEVELOPER_TERMS_OF_USE_URL/,
    );
  });
});
