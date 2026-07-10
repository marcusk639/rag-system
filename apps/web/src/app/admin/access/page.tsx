import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin-check";
import { getWebDb } from "@/lib/db";
import { listSources } from "@rag/db";
import {
  grantAccessAction,
  revokeAccessAction,
  getHistoryAction,
  grantSourceAccessAction,
  revokeSourceAccessAction,
  getSourceHistoryAction,
} from "./actions";
import {
  GrantAccessForm,
  RevokeAccessForm,
  AccessHistoryForm,
  GrantSourceAccessForm,
  RevokeSourceAccessForm,
  SourceAccessHistoryForm,
} from "./access-forms";

export default async function AdminAccessPage() {
  const session = await auth();
  if (!session?.oid || !(await isAdmin(session))) {
    redirect("/");
  }

  const sources = await listSources(getWebDb());
  const sourceOptions = sources.map((source) => ({
    id: source.id,
    name: source.name,
  }));

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">Client Access Management</h1>

      <GrantAccessForm action={grantAccessAction} />
      <RevokeAccessForm action={revokeAccessAction} />
      <AccessHistoryForm action={getHistoryAction} />

      <h1 className="mt-12 text-2xl font-semibold">
        Direct Source Access Management
      </h1>

      <GrantSourceAccessForm
        action={grantSourceAccessAction}
        sources={sourceOptions}
      />
      <RevokeSourceAccessForm
        action={revokeSourceAccessAction}
        sources={sourceOptions}
      />
      <SourceAccessHistoryForm action={getSourceHistoryAction} />
    </main>
  );
}
