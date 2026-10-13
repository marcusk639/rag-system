import { describe, expect, it } from "vitest";
import { EMPTY_ANSWER, isRefusal } from "./refusal.js";

describe("isRefusal", () => {
  it("accepts the prescribed case-C sentence alone", () => {
    expect(isRefusal(EMPTY_ANSWER)).toBe(true);
  });

  it("accepts case C with the prescribed closest-related-material line", () => {
    expect(
      isRefusal(`${EMPTY_ANSWER}\nClosest related material: Travel SOP [2]`),
    ).toBe(true);
  });

  it("accepts the rubric label small models echo in place of the sentence", () => {
    expect(isRefusal("The documents do not bear on the question.")).toBe(true);
  });

  // The confabulation the strict predicate exists to catch (commit 17e80bd).
  it("accepts case C whose related-material title contains a continuation word", () => {
    expect(
      isRefusal(
        `${EMPTY_ANSWER}\nClosest related material: Based on Facts and Circumstances memo [2]`,
      ),
    ).toBe(true);
  });

  it("rejects a fabricated answer smuggled into the related-material line", () => {
    expect(
      isRefusal(
        `${EMPTY_ANSWER}\nClosest related material: Mileage memo [1]. However, the 2025 rate is 70 cents per mile.`,
      ),
    ).toBe(false);
  });

  it("rejects a fabricated answer on the line after the refusal sentence", () => {
    expect(
      isRefusal(
        `${EMPTY_ANSWER}\nHowever, the standard IRS mileage rate for 2025 is 70 cents per mile [1].`,
      ),
    ).toBe(false);
  });

  it("rejects a refusal followed by a fabricated answer", () => {
    expect(
      isRefusal(
        `${EMPTY_ANSWER} However, the standard IRS mileage rate for 2025 is 70 cents per mile [1].`,
      ),
    ).toBe(false);
  });

  it("rejects an answer that only quotes the refusal sentence later on", () => {
    expect(
      isRefusal(
        `Escalate to a partner [1].\n\nStaff should never reply "${EMPTY_ANSWER}" to a client.`,
      ),
    ).toBe(false);
  });

  it("rejects an over-long reply that opens with the refusal sentence", () => {
    expect(isRefusal(`${EMPTY_ANSWER}\n${"x ".repeat(300)}`)).toBe(false);
  });

  it("rejects a partial (case B) answer", () => {
    expect(
      isRefusal(
        "The filing deadline is April 15 [1]. Not covered by the documents: extensions.",
      ),
    ).toBe(false);
  });
});
