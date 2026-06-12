import { describe, expect, it } from "vitest";
import {
  filterSchema,
  MAX_FILTER_KEYS,
  MAX_FILTER_KEY_LEN,
  MAX_FILTER_VALUES_PER_KEY,
  MAX_FILTER_VALUE_LEN,
} from "./validation.js";

describe("filterSchema value shapes", () => {
  it("accepts a string value", () => {
    expect(filterSchema.parse({ author: "alice" })).toEqual({
      author: "alice",
    });
  });

  it("accepts a string[] value", () => {
    expect(filterSchema.parse({ tag: ["a", "b"] })).toEqual({
      tag: ["a", "b"],
    });
  });

  it("rejects a non-string value", () => {
    expect(() => filterSchema.parse({ count: 3 })).toThrow();
    expect(() => filterSchema.parse({ flag: true })).toThrow();
  });
});

describe("filterSchema DoS caps — keys", () => {
  const buildKeys = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));

  it(`accepts exactly ${MAX_FILTER_KEYS} keys`, () => {
    expect(() => filterSchema.parse(buildKeys(MAX_FILTER_KEYS))).not.toThrow();
  });

  it(`rejects ${MAX_FILTER_KEYS + 1} keys`, () => {
    expect(() => filterSchema.parse(buildKeys(MAX_FILTER_KEYS + 1))).toThrow();
  });
});

describe("filterSchema DoS caps — key length", () => {
  it(`accepts a key of exactly ${MAX_FILTER_KEY_LEN} chars`, () => {
    const key = "k".repeat(MAX_FILTER_KEY_LEN);
    expect(() => filterSchema.parse({ [key]: "v" })).not.toThrow();
  });

  it(`rejects a key of ${MAX_FILTER_KEY_LEN + 1} chars`, () => {
    const key = "k".repeat(MAX_FILTER_KEY_LEN + 1);
    expect(() => filterSchema.parse({ [key]: "v" })).toThrow();
  });
});

describe("filterSchema DoS caps — value length", () => {
  it(`accepts a value of exactly ${MAX_FILTER_VALUE_LEN} chars (string)`, () => {
    const value = "v".repeat(MAX_FILTER_VALUE_LEN);
    expect(() => filterSchema.parse({ k: value })).not.toThrow();
  });

  it(`rejects a value of ${MAX_FILTER_VALUE_LEN + 1} chars (string)`, () => {
    const value = "v".repeat(MAX_FILTER_VALUE_LEN + 1);
    expect(() => filterSchema.parse({ k: value })).toThrow();
  });

  it(`rejects an over-length value inside a string[]`, () => {
    const value = "v".repeat(MAX_FILTER_VALUE_LEN + 1);
    expect(() => filterSchema.parse({ k: ["ok", value] })).toThrow();
  });
});

describe("filterSchema DoS caps — values per key", () => {
  it(`accepts exactly ${MAX_FILTER_VALUES_PER_KEY} values`, () => {
    const values = Array.from({ length: MAX_FILTER_VALUES_PER_KEY }, () => "v");
    expect(() => filterSchema.parse({ k: values })).not.toThrow();
  });

  it(`rejects ${MAX_FILTER_VALUES_PER_KEY + 1} values`, () => {
    const values = Array.from(
      { length: MAX_FILTER_VALUES_PER_KEY + 1 },
      () => "v",
    );
    expect(() => filterSchema.parse({ k: values })).toThrow();
  });
});
