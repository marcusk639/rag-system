import { describe, expect, it, vi } from "vitest";

// `submitAnswerFeedback` calls the `@rag/db` query as a free function imported
// from a sibling package, so we mock the module rather than injecting it —
// mirrors the pattern in sources.test.ts for `triggerSync`.
const dbSubmitMock = vi.fn();

vi.mock("@rag/db", () => ({
  submitAnswerFeedback: (...args: unknown[]) => dbSubmitMock(...args),
}));

const { submitAnswerFeedback } = await import("./feedback.js");
import type { ServiceDeps } from "./deps.js";

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const deps = { db: {}, queue: {}, logger } as unknown as ServiceDeps;

describe("submitAnswerFeedback", () => {
  it("records feedback with the server-provided principalSubject (not from the client)", async () => {
    dbSubmitMock.mockResolvedValue(undefined);

    await submitAnswerFeedback(deps, {
      answerId: "a1",
      rating: "not_helpful",
      comment: "off-topic",
      principalSubject: "oid-A",
      channel: "web",
    });

    expect(dbSubmitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        answerId: "a1",
        rating: "not_helpful",
        comment: "off-topic",
        principalSubject: "oid-A",
        channel: "web",
      }),
    );
  });

  it("passes deps.db as the db handle to the underlying query", async () => {
    dbSubmitMock.mockResolvedValue(undefined);

    await submitAnswerFeedback(deps, {
      answerId: "a2",
      rating: "helpful",
      principalSubject: null,
      channel: "web",
    });

    expect(dbSubmitMock).toHaveBeenCalledWith(deps.db, expect.anything());
  });

  it("defaults a missing comment to null rather than undefined", async () => {
    dbSubmitMock.mockResolvedValue(undefined);

    await submitAnswerFeedback(deps, {
      answerId: "a3",
      rating: "helpful",
      principalSubject: null,
      channel: "teams",
    });

    expect(dbSubmitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ comment: null }),
    );
  });
});
