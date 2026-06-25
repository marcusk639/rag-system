import React, { useState } from "react";
import { Upload, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Source } from "@/types";

interface UploadModalProps {
  onClose: () => void;
  /** The source selected in the list. Uploads only target `custom` sources. */
  source: Source | null;
}

type UploadState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "done"; ingestionId?: string }
  | { status: "error"; message: string };

interface FileUpload {
  file: File;
  state: UploadState;
}

export const UploadModal: React.FC<UploadModalProps> = ({
  onClose,
  source,
}) => {
  const [dragActive, setDragActive] = useState(false);
  const [uploads, setUploads] = useState<FileUpload[]>([]);
  const [busy, setBusy] = useState(false);

  // Uploads require a selected `custom` source (its connector ingests staged
  // uploads). Anything else is a clear, explained no-op — never a dead button.
  const canUpload = source !== null && source.kind === "custom";

  const setFiles = (files: File[]) =>
    setUploads(files.map((file) => ({ file, state: { status: "idle" } })));

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (canUpload) setFiles(Array.from(e.dataTransfer.files));
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) setFiles(Array.from(e.target.files));
  };

  const uploadOne = async (file: File): Promise<UploadState> => {
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const res = await fetch(
        `/api/upload?sourceId=${encodeURIComponent(source!.id)}`,
        { method: "POST", body },
      );
      const data = (await res.json().catch(() => null)) as {
        ingestionId?: string;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        return {
          status: "error",
          message: data?.error?.message ?? `Upload failed (${res.status}).`,
        };
      }
      return { status: "done", ingestionId: data?.ingestionId };
    } catch {
      return { status: "error", message: "Network error during upload." };
    }
  };

  const handleUpload = async () => {
    if (!canUpload || uploads.length === 0 || busy) return;
    setBusy(true);
    // Sequential: each upload enqueues an ingestion sync; serial keeps the
    // per-file status readable and avoids hammering the API.
    for (let i = 0; i < uploads.length; i++) {
      setUploads((prev) =>
        prev.map((u, idx) =>
          idx === i ? { ...u, state: { status: "uploading" } } : u,
        ),
      );
      const state = await uploadOne(uploads[i].file);
      setUploads((prev) =>
        prev.map((u, idx) => (idx === i ? { ...u, state } : u)),
      );
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Upload Documents</CardTitle>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            <X size={20} />
          </button>
        </CardHeader>
        <CardContent>
          {!canUpload ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              {source === null ? (
                <>Select a source in the list, then upload into it.</>
              ) : (
                <>
                  Uploads are only supported for <strong>custom</strong>{" "}
                  sources. &ldquo;{source.name}&rdquo; is a{" "}
                  <strong>{source.kind}</strong> source, which ingests from its
                  connected system.
                </>
              )}
            </div>
          ) : (
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center ${
                dragActive ? "border-blue-500 bg-blue-50" : "border-gray-300"
              }`}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
            >
              <Upload className="mx-auto h-12 w-12 text-gray-400" />
              <div className="mt-1 text-sm text-gray-500">
                Uploading to &ldquo;{source.name}&rdquo;
              </div>
              <div className="mt-4">
                <label className="cursor-pointer">
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleFileSelect}
                    disabled={busy}
                  />
                  <span className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
                    Select Files
                  </span>
                </label>
                <p className="mt-2 text-sm text-gray-500">
                  or drag and drop files here
                </p>
              </div>

              {uploads.length > 0 && (
                <div className="mt-4 text-left">
                  <h4 className="font-medium mb-2">Files:</h4>
                  <ul className="space-y-2">
                    {uploads.map((u, index) => (
                      <li
                        key={index}
                        className="flex items-center justify-between bg-gray-50 p-2 rounded gap-2"
                      >
                        <span className="text-sm truncate">{u.file.name}</span>
                        <span className="text-xs whitespace-nowrap">
                          {u.state.status === "idle" &&
                            `${(u.file.size / 1024 / 1024).toFixed(2)} MB`}
                          {u.state.status === "uploading" && (
                            <span className="text-blue-600">uploading…</span>
                          )}
                          {u.state.status === "done" && (
                            <span className="text-green-600">queued ✓</span>
                          )}
                          {u.state.status === "error" && (
                            <span
                              className="text-red-600"
                              title={u.state.message}
                            >
                              failed
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={handleUpload}
                    disabled={busy}
                    className="w-full mt-4 bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 disabled:opacity-50"
                  >
                    {busy
                      ? "Uploading…"
                      : `Upload ${uploads.length} file${
                          uploads.length !== 1 ? "s" : ""
                        }`}
                  </button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
