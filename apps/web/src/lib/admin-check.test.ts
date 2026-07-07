import { describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("./graph-client.js", () => ({
  isUserInGroup: vi.fn(),
}));

import { isUserInGroup } from "./graph-client.js";
import { isAdmin } from "./admin-check.js";

const baseSession = (overrides: Partial<Session>): Session =>
  ({
    oid: "aad-oid-1",
    groups: [],
    hasGroupsOverage: false,
    user: {},
    expires: "",
    ...overrides,
  }) as Session;

describe("isAdmin", () => {
  it("returns true when the RAG-Admins group id is in the inline groups claim", async () => {
    process.env.RAG_ADMINS_GROUP_ID = "admins-group-id";
    const session = baseSession({ groups: ["admins-group-id", "other-group"] });
    await expect(isAdmin(session)).resolves.toBe(true);
  });

  it("returns false when the inline groups claim doesn't include it", async () => {
    process.env.RAG_ADMINS_GROUP_ID = "admins-group-id";
    const session = baseSession({ groups: ["other-group"] });
    await expect(isAdmin(session)).resolves.toBe(false);
  });

  it("falls back to a Graph membership check on groups overage", async () => {
    process.env.RAG_ADMINS_GROUP_ID = "admins-group-id";
    vi.mocked(isUserInGroup).mockResolvedValueOnce(true);
    const session = baseSession({ groups: undefined, hasGroupsOverage: true });
    await expect(isAdmin(session)).resolves.toBe(true);
    expect(isUserInGroup).toHaveBeenCalledWith("aad-oid-1", "admins-group-id");
  });

  it("returns false from the Graph fallback when not a member", async () => {
    process.env.RAG_ADMINS_GROUP_ID = "admins-group-id";
    vi.mocked(isUserInGroup).mockResolvedValueOnce(false);
    const session = baseSession({ groups: undefined, hasGroupsOverage: true });
    await expect(isAdmin(session)).resolves.toBe(false);
  });
});
