import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin-check";
import { getWebDb } from "@/lib/db";
import { listDocsGapDigestRuns } from "@rag/db";

// No shared admin layout exists yet (known gap) -- this page repeats the
// same self-contained auth()/isAdmin() guard as apps/web/src/app/admin/access/page.tsx
// rather than inventing one here.

function formatDate(date: Date): string {
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function AdminDocsGapDigestPage() {
  const session = await auth();
  if (!session?.oid || !(await isAdmin(session))) {
    redirect("/");
  }

  const runs = await listDocsGapDigestRuns(getWebDb());

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Documentation Gap Digest</h1>
      <p className="mt-2 text-sm text-gray-600">
        Weekly counts of weak/zero-result questions, grouped by endpoint and by
        which source(s) were queried. No question text is stored or shown here
        -- only aggregate counts.
      </p>

      {runs.length === 0 ? (
        <p className="mt-8 text-sm text-gray-500">
          No digest runs recorded yet.
        </p>
      ) : (
        <table className="mt-8 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="py-2 pr-4">Run date</th>
              <th className="py-2 pr-4">Window</th>
              <th className="py-2 pr-4">Total weak events</th>
              <th className="py-2 pr-4">By endpoint</th>
              <th className="py-2 pr-4">By source group</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="border-b align-top">
                <td className="py-2 pr-4">{formatDate(run.runAt)}</td>
                <td className="py-2 pr-4">
                  {formatDate(run.windowSince)} &ndash;{" "}
                  {formatDate(run.windowUntil)}
                </td>
                <td className="py-2 pr-4">{run.totalWeakEvents}</td>
                <td className="py-2 pr-4">
                  {Object.entries(run.byEndpoint).length === 0
                    ? "—"
                    : Object.entries(run.byEndpoint).map(
                        ([endpoint, count]) => (
                          <div key={endpoint}>
                            {endpoint}: {count}
                          </div>
                        ),
                      )}
                </td>
                <td className="py-2 pr-4">
                  {run.bySourceGroup.length === 0
                    ? "—"
                    : run.bySourceGroup.map((group) => (
                        <div key={group.sourceIds.join(",")}>
                          [{group.sourceIds.join(", ")}]: {group.count}
                        </div>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
