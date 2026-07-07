import type { Session } from "next-auth";
import { isUserInGroup } from "./graph-client";

/**
 * Determines whether the signed-in user is a member of the `RAG-Admins`
 * security group — the single source of truth for who can manage client
 * access grants. Handles Entra ID's "groups overage" case: when a user
 * belongs to too many groups, the ID token omits inline group values
 * entirely (`hasGroupsOverage: true`) and membership must instead be
 * confirmed via a direct Microsoft Graph call.
 */
export async function isAdmin(session: Session): Promise<boolean> {
  const adminGroupId = process.env.RAG_ADMINS_GROUP_ID;
  if (!adminGroupId) return false;

  if (session.hasGroupsOverage) {
    return isUserInGroup(session.oid, adminGroupId);
  }
  return (session.groups ?? []).includes(adminGroupId);
}
