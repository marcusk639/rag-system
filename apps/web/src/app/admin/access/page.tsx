import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin-check";
import { grantAccessAction, revokeAccessAction } from "./actions";

export default async function AdminAccessPage() {
  const session = await auth();
  if (!session?.oid || !(await isAdmin(session))) {
    redirect("/");
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">Client Access Management</h1>

      <form
        action={async (formData) => {
          "use server";
          await grantAccessAction(formData);
        }}
        className="mt-6 space-y-3"
      >
        <h2 className="text-lg font-medium">Grant access</h2>
        <input
          name="email"
          type="email"
          placeholder="staff@firm.com"
          required
          className="w-full rounded border px-3 py-2"
        />
        <input
          name="clientId"
          type="text"
          placeholder="client id (e.g. acme-2024)"
          required
          className="w-full rounded border px-3 py-2"
        />
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">
          Grant
        </button>
      </form>

      <form
        action={async (formData) => {
          "use server";
          await revokeAccessAction(formData);
        }}
        className="mt-8 space-y-3"
      >
        <h2 className="text-lg font-medium">Revoke access</h2>
        <input
          name="email"
          type="email"
          placeholder="staff@firm.com"
          required
          className="w-full rounded border px-3 py-2"
        />
        <input
          name="clientId"
          type="text"
          placeholder="client id (e.g. acme-2024)"
          required
          className="w-full rounded border px-3 py-2"
        />
        <button type="submit" className="rounded border px-4 py-2">
          Revoke
        </button>
      </form>
    </main>
  );
}
