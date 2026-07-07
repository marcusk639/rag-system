"use server";

import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin-check";
import { resolveOidByEmail } from "@/lib/graph-client";
import { getWebDb } from "@/lib/db";
import {
  grantClientAccess,
  revokeClientAccess,
  listAssignmentHistoryForStaff,
} from "@rag/db";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Every action re-checks admin membership server-side, in addition to
 * whatever page-level gating exists — a server action is a public,
 * independently-callable HTTP endpoint under the hood, so it must not rely
 * solely on the calling page having hidden a button.
 */
async function requireAdmin(): Promise<
  { ok: true; oid: string } | { ok: false; error: string }
> {
  const session = await auth();
  if (!session?.oid) return { ok: false, error: "Unauthenticated" };
  if (!(await isAdmin(session))) return { ok: false, error: "Forbidden" };
  return { ok: true, oid: session.oid };
}

export async function grantAccessAction(
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate;

  const email = String(formData.get("email") ?? "");
  const clientId = String(formData.get("clientId") ?? "");

  const targetOid = await resolveOidByEmail(email);
  if (!targetOid) {
    return { ok: false, error: `No Entra ID user found for ${email}` };
  }

  await grantClientAccess(getWebDb(), {
    userId: targetOid,
    clientId,
    grantedBy: gate.oid,
  });
  return { ok: true };
}

export async function revokeAccessAction(
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate;

  const email = String(formData.get("email") ?? "");
  const clientId = String(formData.get("clientId") ?? "");

  const targetOid = await resolveOidByEmail(email);
  if (!targetOid) {
    return { ok: false, error: `No Entra ID user found for ${email}` };
  }

  await revokeClientAccess(getWebDb(), { userId: targetOid, clientId });
  return { ok: true };
}

export async function getHistoryAction(email: string) {
  const gate = await requireAdmin();
  if (!gate.ok) return { ok: false as const, error: gate.error };

  const targetOid = await resolveOidByEmail(email);
  if (!targetOid) {
    return {
      ok: false as const,
      error: `No Entra ID user found for ${email}`,
    };
  }
  const history = await listAssignmentHistoryForStaff(getWebDb(), targetOid);
  return { ok: true as const, history };
}
