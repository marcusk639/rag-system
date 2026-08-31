import { describe, expect, it } from "vitest";
import { EgressError } from "./errors.js";
import { EgressPolicy, egressSafeFetch } from "./egress-policy.js";

describe("EgressPolicy", () => {
  // ── Construction ──────────────────────────────────────────────────────────────

  it("allows a listed host", () => {
    const policy = new EgressPolicy(["api.openai.com"]);
    expect(() =>
      policy.assertAllowed("https://api.openai.com/v1/completions"),
    ).not.toThrow();
  });

  it("blocks an unlisted host", () => {
    const policy = new EgressPolicy(["api.openai.com"]);
    expect(() =>
      policy.assertAllowed("https://api.anthropic.com/v1/messages"),
    ).toThrow(EgressError);
  });

  it("empty allow-list blocks everything", () => {
    const policy = new EgressPolicy([]);
    expect(() => policy.assertAllowed("https://api.openai.com")).toThrow(
      EgressError,
    );
    expect(() =>
      policy.assertAllowed("https://generativelanguage.googleapis.com"),
    ).toThrow(EgressError);
  });

  it("normalizes hostnames to lowercase", () => {
    const policy = new EgressPolicy(["API.OpenAI.COM"]);
    expect(() =>
      policy.assertAllowed("https://api.openai.com/v1/chat"),
    ).not.toThrow();
  });

  it("strips whitespace from configured hosts", () => {
    const policy = new EgressPolicy(["  api.openai.com  "]);
    expect(() => policy.assertAllowed("https://api.openai.com")).not.toThrow();
  });

  it("ignores empty strings in the host list", () => {
    const policy = new EgressPolicy(["", "api.openai.com", ""]);
    expect(() => policy.assertAllowed("https://api.openai.com")).not.toThrow();
    expect(() => policy.assertAllowed("https://evil.com")).toThrow(EgressError);
  });

  it("allows multiple hosts", () => {
    const policy = new EgressPolicy([
      "generativelanguage.googleapis.com",
      "api.openai.com",
    ]);
    expect(() =>
      policy.assertAllowed("https://generativelanguage.googleapis.com/v1beta"),
    ).not.toThrow();
    expect(() =>
      policy.assertAllowed("https://api.openai.com/v1/chat"),
    ).not.toThrow();
    expect(() => policy.assertAllowed("https://api.cohere.ai/v1")).toThrow(
      EgressError,
    );
  });

  it("blocks an unparseable URL", () => {
    const policy = new EgressPolicy(["api.openai.com"]);
    expect(() => policy.assertAllowed("not-a-url")).toThrow(EgressError);
  });

  it("exposes the allow-list via allowedHosts", () => {
    const policy = new EgressPolicy(["api.openai.com", "example.com"]);
    const hosts = policy.allowedHosts;
    expect(hosts).toContain("api.openai.com");
    expect(hosts).toContain("example.com");
  });

  // ── EgressError ───────────────────────────────────────────────────────────────

  it("EgressError carries the blocked host and a descriptive message", () => {
    const policy = new EgressPolicy([]);
    let caught: EgressError | undefined;
    try {
      policy.assertAllowed("https://evil.example.com/path");
    } catch (err) {
      caught = err as EgressError;
    }
    expect(caught).toBeInstanceOf(EgressError);
    expect(caught!.host).toBe("evil.example.com");
    expect(caught!.message).toMatch(/EGRESS_ALLOWED_HOSTS/);
    expect(caught!.code).toBe("EGRESS_BLOCKED");
  });

  // ── fromEnv() ─────────────────────────────────────────────────────────────────

  it("fromEnv() parses EGRESS_ALLOWED_HOSTS as comma-separated hosts", () => {
    const original = process.env["EGRESS_ALLOWED_HOSTS"];
    try {
      process.env["EGRESS_ALLOWED_HOSTS"] =
        "generativelanguage.googleapis.com,api.openai.com";
      const policy = EgressPolicy.fromEnv();
      expect(() =>
        policy.assertAllowed("https://generativelanguage.googleapis.com"),
      ).not.toThrow();
      expect(() =>
        policy.assertAllowed("https://api.openai.com"),
      ).not.toThrow();
      expect(() => policy.assertAllowed("https://api.anthropic.com")).toThrow(
        EgressError,
      );
    } finally {
      if (original === undefined) delete process.env["EGRESS_ALLOWED_HOSTS"];
      else process.env["EGRESS_ALLOWED_HOSTS"] = original;
    }
  });

  it("fromEnv() with empty EGRESS_ALLOWED_HOSTS produces deny-all policy", () => {
    const original = process.env["EGRESS_ALLOWED_HOSTS"];
    try {
      process.env["EGRESS_ALLOWED_HOSTS"] = "";
      const policy = EgressPolicy.fromEnv();
      expect(() => policy.assertAllowed("https://api.openai.com")).toThrow(
        EgressError,
      );
    } finally {
      if (original === undefined) delete process.env["EGRESS_ALLOWED_HOSTS"];
      else process.env["EGRESS_ALLOWED_HOSTS"] = original;
    }
  });

  it("fromEnv() with missing EGRESS_ALLOWED_HOSTS produces deny-all policy", () => {
    const original = process.env["EGRESS_ALLOWED_HOSTS"];
    try {
      delete process.env["EGRESS_ALLOWED_HOSTS"];
      const policy = EgressPolicy.fromEnv();
      expect(() => policy.assertAllowed("https://api.openai.com")).toThrow(
        EgressError,
      );
    } finally {
      if (original === undefined) delete process.env["EGRESS_ALLOWED_HOSTS"];
      else process.env["EGRESS_ALLOWED_HOSTS"] = original;
    }
  });
});

describe("egressSafeFetch", () => {
  // The allow-list validates the URL we INTEND to dial. Following a redirect
  // means the transport can end up somewhere the allow-list never saw, with the
  // request body re-sent on 307/308 — for generation, that body is the prompt.
  it("forces redirect:error on every request", async () => {
    const calls: RequestInit[] = [];
    const base = (async (_i: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("ok");
    }) as typeof globalThis.fetch;

    await egressSafeFetch(base)("https://example.test/x");

    expect(calls[0]!.redirect).toBe("error");
  });

  it("overrides a caller that asked to follow redirects", async () => {
    const calls: RequestInit[] = [];
    const base = (async (_i: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("ok");
    }) as typeof globalThis.fetch;

    await egressSafeFetch(base)("https://example.test/x", {
      redirect: "follow",
    });

    expect(calls[0]!.redirect).toBe("error");
  });

  it("preserves the caller's other request options", async () => {
    const calls: RequestInit[] = [];
    const base = (async (_i: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response("ok");
    }) as typeof globalThis.fetch;

    await egressSafeFetch(base)("https://example.test/x", {
      method: "POST",
      body: "payload",
    });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toBe("payload");
  });
});
