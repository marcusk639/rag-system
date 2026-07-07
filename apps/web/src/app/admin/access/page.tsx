import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin-check";
import {
  grantAccessAction,
  revokeAccessAction,
  getHistoryAction,
} from "./actions";
import {
  GrantAccessForm,
  RevokeAccessForm,
  AccessHistoryForm,
} from "./access-forms";

export default async function AdminAccessPage() {
  const session = await auth();
  if (!session?.oid || !(await isAdmin(session))) {
    redirect("/");
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">Client Access Management</h1>

      <GrantAccessForm action={grantAccessAction} />
      <RevokeAccessForm action={revokeAccessAction} />
      <AccessHistoryForm action={getHistoryAction} />
    </main>
  );
}
