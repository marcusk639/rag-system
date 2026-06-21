import React from "react";
import { Database } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { Source } from "@/types";

interface DocumentListProps {
  sources: Source[];
  selectedSource: Source | null;
  onSourceSelect: (source: Source) => void;
  loading?: boolean;
  error?: string | null;
}

export const DocumentList: React.FC<DocumentListProps> = ({
  sources,
  selectedSource,
  onSourceSelect,
  loading,
  error,
}) => {
  return (
    <Card>
      <CardContent className="p-6">
        {loading && (
          <div className="text-sm text-gray-500">Loading sources…</div>
        )}
        {error && <div className="text-sm text-red-600">{error}</div>}
        {!loading && !error && sources.length === 0 && (
          <div className="text-sm text-gray-500">No sources available.</div>
        )}
        <div className="space-y-2">
          {sources.map((source) => (
            <div
              key={source.id}
              onClick={() => onSourceSelect(source)}
              className={`flex items-center justify-between p-3 rounded cursor-pointer ${
                selectedSource?.id === source.id
                  ? "bg-blue-50 border border-blue-200"
                  : "hover:bg-gray-50"
              }`}
            >
              <div className="flex items-center space-x-3">
                <Database className="text-blue-500" size={20} />
                <div>
                  <div className="font-medium">{source.name}</div>
                  <div className="text-sm text-gray-500">{source.kind}</div>
                </div>
              </div>
              {source.status && (
                <span className="text-sm text-gray-500">{source.status}</span>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
