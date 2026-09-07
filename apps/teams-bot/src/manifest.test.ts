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
});
