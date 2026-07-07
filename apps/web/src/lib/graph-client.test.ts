import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { resolveOidByEmail, isUserInGroup } from "./graph-client.js";

beforeEach(() => {
  fetchMock.mockReset();
  process.env.MS_TENANT_ID = "test-tenant";
  process.env.MS_CLIENT_ID = "test-client";
  process.env.MS_CLIENT_SECRET = "test-secret";
});

function mockTokenThenResponse(responseBody: unknown, responseStatus = 200) {
  fetchMock
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "fake-graph-token" }), {
        status: 200,
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify(responseBody), { status: responseStatus }),
    );
}

describe("resolveOidByEmail", () => {
  it("returns the user's oid when found", async () => {
    mockTokenThenResponse({ id: "aad-oid-123" });
    await expect(resolveOidByEmail("jane@firm.com")).resolves.toBe(
      "aad-oid-123",
    );
  });

  it("returns null when the user is not found (404)", async () => {
    mockTokenThenResponse({ error: { message: "not found" } }, 404);
    await expect(resolveOidByEmail("nobody@firm.com")).resolves.toBeNull();
  });

  it("throws on unexpected error statuses", async () => {
    mockTokenThenResponse({ error: { message: "forbidden" } }, 403);
    await expect(resolveOidByEmail("jane@firm.com")).rejects.toThrow(
      "Graph user lookup failed: 403",
    );
  });
});

describe("isUserInGroup", () => {
  // Real Graph contract (verified against Microsoft's live v1.0 docs):
  // POST /users/{id}/checkMemberGroups with { groupIds: [...] } (max 20)
  // returns { value: string[] } — the subset of the requested groupIds the
  // user actually belongs to. This is NOT a { value: true/false } boolean
  // shape (that was only an illustrative placeholder in the task brief).

  it("returns true when checkMemberGroups reports the group in its value array", async () => {
    mockTokenThenResponse({ value: ["group-id-1"] });
    await expect(isUserInGroup("aad-oid-123", "group-id-1")).resolves.toBe(
      true,
    );
  });

  it("returns false when checkMemberGroups' value array omits the group", async () => {
    mockTokenThenResponse({ value: [] });
    await expect(isUserInGroup("aad-oid-123", "group-id-1")).resolves.toBe(
      false,
    );
  });

  it("sends a POST request with the single groupId in the request body", async () => {
    mockTokenThenResponse({ value: ["group-id-1"] });
    await isUserInGroup("aad-oid-123", "group-id-1");

    const checkMemberGroupsCall = fetchMock.mock.calls[1];
    expect(checkMemberGroupsCall[0]).toBe(
      "https://graph.microsoft.com/v1.0/users/aad-oid-123/checkMemberGroups",
    );
    expect(checkMemberGroupsCall[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ groupIds: ["group-id-1"] }),
    });
  });

  it("throws on a non-ok response", async () => {
    mockTokenThenResponse({ error: { message: "bad request" } }, 400);
    await expect(isUserInGroup("aad-oid-123", "group-id-1")).rejects.toThrow(
      "Graph group membership check failed: 400",
    );
  });
});
