import { describe, expect, it, vi } from "vitest";
import { ADMIN_SCOPE, ComplianceError } from "@rag/core";
import { searchDocuments } from "./search.js";
import type { ServiceDeps } from "./deps.js";

function deps(generator: unknown, search = vi.fn().mockResolvedValue([])) {
  return {
    deps: {
      db: {},
      queue: {},
      retriever: { search },
      generator,
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    } as unknown as ServiceDeps,
    search,
  };
}

describe("searchDocuments TRI screening", () => {
  it("screens the query with the configured generator's policy before it is embedded", async () => {
    const screen = vi.fn(() => {
      throw new ComplianceError("TRI in query");
    });
    const { deps: d, search } = deps({ screen });
    await expect(
      searchDocuments(d, { query: "SSN 123-45-6789" }, 8, ADMIN_SCOPE),
    ).rejects.toBeInstanceOf(ComplianceError);
    expect(screen).toHaveBeenCalledWith("SSN 123-45-6789", []);
    expect(search).not.toHaveBeenCalled();
  });

  it("searches normally when the query passes screening", async () => {
    const { deps: d, search } = deps({ screen: vi.fn((_q, ctx) => ctx) });
    await searchDocuments(d, { query: "engagement letter" }, 8, ADMIN_SCOPE);
    expect(search).toHaveBeenCalled();
  });

  it("still searches in a deployment with no generator (no policy to apply)", async () => {
    const { deps: d, search } = deps(null);
    await searchDocuments(d, { query: "engagement letter" }, 8, ADMIN_SCOPE);
    expect(search).toHaveBeenCalled();
  });
});
