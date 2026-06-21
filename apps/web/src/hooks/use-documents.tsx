import { useEffect, useState } from "react";
import type { Source } from "@/types";

/**
 * Read-only source list, fetched from the same-origin BFF proxy (/api/sources →
 * RAG GET /sources). Selecting a source scopes subsequent questions.
 */
export const useDocuments = () => {
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSource, setSelectedSource] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/sources", { cache: "no-store" });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? `Failed (${res.status}).`);
        }
        const data = (await res.json()) as { sources?: Source[] };
        if (active) setSources(data.sources ?? []);
      } catch (err) {
        if (active)
          setError(
            err instanceof Error ? err.message : "Failed to load sources.",
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const toggleSource = (source: Source) =>
    setSelectedSource((prev) => (prev?.id === source.id ? null : source));

  return {
    sources,
    selectedSource,
    setSelectedSource,
    toggleSource,
    error,
    loading,
  };
};
