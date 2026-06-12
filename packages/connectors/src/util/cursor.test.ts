import { describe, expect, it } from "vitest";
import { ValidationError } from "@rag/core";
import { makeCursorCodec } from "./cursor.js";

/** Identity normalize — exercises the pure encode/decode transport. */
const identity = makeCursorCodec<Record<string, unknown>>(
  "identity",
  (parsed) => parsed as Record<string, unknown>,
);

describe("makeCursorCodec encode/decode", () => {
  it("round-trips an object so decode(encode(x)) deep-equals x", () => {
    const cursor = {
      mode: "delta",
      pageToken: "abc",
      nested: { a: 1, b: [2, 3] },
    };
    expect(identity.decode(identity.encode(cursor))).toEqual(cursor);
  });

  it("produces an opaque base64 string that is not the raw JSON", () => {
    const encoded = identity.encode({ link: "https://example.test/next" });
    expect(encoded).not.toContain("https://");
    expect(Buffer.from(encoded, "base64").toString("utf8")).toContain(
      "https://",
    );
  });
});

describe("makeCursorCodec decode rejection", () => {
  it("throws ValidationError naming the connector on undecodable input", () => {
    expect(() => identity.decode("%%%not base64 at all%%%")).toThrow(
      ValidationError,
    );
    expect(() => identity.decode("%%%not base64 at all%%%")).toThrow(
      "invalid identity cursor",
    );
  });

  it("throws ValidationError on valid base64 that is not JSON", () => {
    const notJson = Buffer.from("this is not json {{{", "utf8").toString(
      "base64",
    );
    let caught: unknown;
    try {
      identity.decode(notJson);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    // The underlying JSON.parse SyntaxError is preserved as the cause.
    expect((caught as ValidationError).cause).toBeInstanceOf(Error);
  });

  it("wraps a normalize() rejection, attaching it as the cause", () => {
    const rejecting = makeCursorCodec<{ mode: string }>("gmail", (parsed) => {
      const p = parsed as { mode?: string };
      if (p.mode !== "initial" && p.mode !== "delta") {
        throw new Error(`invalid mode: ${String(p.mode)}`);
      }
      return { mode: p.mode };
    });
    const badMode = Buffer.from(JSON.stringify({ mode: "bogus" })).toString(
      "base64",
    );
    let caught: unknown;
    try {
      rejecting.decode(badMode);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toBe("invalid gmail cursor");
    expect((caught as ValidationError).cause).toBeInstanceOf(Error);
    expect(((caught as ValidationError).cause as Error).message).toBe(
      "invalid mode: bogus",
    );
  });
});

describe("makeCursorCodec per-connector normalize defaulting", () => {
  // Mirrors the gmail connector's normalize: required mode, nulled tokens.
  interface GmailCursor {
    mode: "initial" | "delta";
    pageToken: string | null;
    historyId: string | null;
  }
  const gmail = makeCursorCodec<GmailCursor>("gmail", (parsed) => {
    const p = parsed as Partial<GmailCursor>;
    if (p.mode !== "initial" && p.mode !== "delta") {
      throw new Error(`invalid mode: ${String(p.mode)}`);
    }
    return {
      mode: p.mode,
      pageToken: p.pageToken ?? null,
      historyId: p.historyId ?? null,
    };
  });

  it("defaults gmail missing tokens to null for an initial cursor", () => {
    const encoded = Buffer.from(JSON.stringify({ mode: "initial" })).toString(
      "base64",
    );
    expect(gmail.decode(encoded)).toEqual({
      mode: "initial",
      pageToken: null,
      historyId: null,
    });
  });

  // Mirrors the outlook connector's normalize: link defaults to null.
  interface OutlookCursor {
    link: string | null;
  }
  const outlook = makeCursorCodec<OutlookCursor>("outlook", (parsed) => ({
    link: (parsed as Partial<OutlookCursor>).link ?? null,
  }));

  it("defaults outlook empty object to { link: null }", () => {
    const encoded = Buffer.from(JSON.stringify({})).toString("base64");
    expect(outlook.decode(encoded)).toEqual({ link: null });
  });

  it("preserves an existing outlook link verbatim", () => {
    const link =
      "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=x";
    const encoded = Buffer.from(JSON.stringify({ link })).toString("base64");
    expect(outlook.decode(encoded)).toEqual({ link });
  });
});
