import { describe, expect, it } from "vitest";
import { assertDestructiveTestTarget } from "../helpers/db.js";

describe("assertDestructiveTestTarget", () => {
  it("allows local and docker-compose databases", () => {
    for (const url of [
      "postgres://rag:rag@localhost:5432/rag",
      "postgres://rag:rag@127.0.0.1:5432/rag_eval",
      "postgres://rag:rag@[::1]:5432/rag",
      "postgres://rag:rag@postgres:5432/rag",
    ]) {
      expect(() => assertDestructiveTestTarget(url, {})).not.toThrow();
    }
  });

  it("refuses a remote database, naming the host", () => {
    expect(() =>
      assertDestructiveTestTarget(
        "postgres://u:secret@db.prod.example.railway.app:6543/rag",
        {},
      ),
    ).toThrow(/db\.prod\.example\.railway\.app/);
  });

  it("does not leak the password in the refusal", () => {
    expect(() =>
      assertDestructiveTestTarget("postgres://u:hunter2@remote.example:5432/rag", {}),
    ).toThrow(/^(?!.*hunter2).*$/s);
  });

  it("allows a remote database only with an explicit opt-in", () => {
    expect(() =>
      assertDestructiveTestTarget("postgres://u:p@remote.example:5432/rag", {
        E2E_ALLOW_REMOTE_TRUNCATE: "1",
      }),
    ).not.toThrow();
  });

  it("refuses an unparseable URL", () => {
    expect(() => assertDestructiveTestTarget("not a url", {})).toThrow();
  });
});
