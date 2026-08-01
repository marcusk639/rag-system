"use client";

import React, { useState } from "react";
import { ThumbsUp, ThumbsDown } from "lucide-react";

interface AnswerFeedbackProps {
  /** Server-assigned answer id. The control renders nothing without one. */
  answerId?: string;
}

type Rating = "helpful" | "not_helpful";
type Status = "idle" | "sending" | "sent" | "error";

/**
 * Thumbs up / down on an answer, with an optional comment on a thumbs-down.
 *
 * The backend (migration 0018, `POST /feedback`) has existed since 2026-07-17
 * and had no caller, so no in-product quality signal was ever captured. This is
 * that caller.
 *
 * Two deliberate choices:
 *
 * 1. **The comment box appears only on "not helpful."** Asking why something
 *    worked produces little; asking why it failed produces the ISS-05 sort —
 *    "the knowledge base doesn't contain this" (an authoring job) versus "it's
 *    in there and the assistant missed it" (a retrieval job). Those need
 *    different fixes and different owners, and free text is the only place that
 *    distinction shows up.
 *
 * 2. **A failed submission says so.** Silently swallowing the error would make
 *    the feedback data quietly incomplete while looking healthy — the same
 *    class of failure as an unmonitored backup.
 */
export const AnswerFeedback: React.FC<AnswerFeedbackProps> = ({ answerId }) => {
  const [rating, setRating] = useState<Rating | null>(null);
  const [comment, setComment] = useState("");
  const [showComment, setShowComment] = useState(false);
  const [status, setStatus] = useState<Status>("idle");

  // No answerId means the stream never completed — there is nothing to attach
  // feedback to, and a control that 400s on click is worse than no control.
  if (!answerId) return null;

  async function submit(next: Rating, withComment?: string): Promise<void> {
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answerId,
          rating: next,
          ...(withComment?.trim() ? { comment: withComment.trim() } : {}),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setRating(next);
      setStatus("sent");
      setShowComment(false);
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent" && !showComment) {
    return (
      <p className="mt-2 text-xs text-gray-500" role="status">
        Thanks — feedback recorded.
        {rating === "not_helpful" && !comment && (
          <button
            onClick={() => setShowComment(true)}
            className="ml-1 underline hover:text-gray-700"
          >
            Add what was wrong
          </button>
        )}
      </p>
    );
  }

  return (
    <div className="mt-2 border-t border-gray-200 pt-2">
      {!showComment && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Was this helpful?</span>
          <button
            aria-label="Helpful"
            disabled={status === "sending"}
            onClick={() => void submit("helpful")}
            className="rounded p-1 text-gray-400 hover:bg-green-50 hover:text-green-600 disabled:opacity-50"
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>
          <button
            aria-label="Not helpful"
            disabled={status === "sending"}
            onClick={() => {
              setRating("not_helpful");
              setShowComment(true);
            }}
            className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
          {status === "error" && (
            <span className="text-xs text-red-600" role="alert">
              Could not send — try again.
            </span>
          )}
        </div>
      )}

      {showComment && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`fb-${answerId}`} className="text-xs text-gray-600">
            What was wrong? Most useful: was the answer missing from the
            knowledge base, or in it but not found?
          </label>
          <textarea
            id={`fb-${answerId}`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={1000}
            rows={2}
            className="w-full rounded border border-gray-300 p-1.5 text-xs"
          />
          <div className="flex gap-2">
            <button
              disabled={status === "sending"}
              onClick={() => void submit("not_helpful", comment)}
              className="rounded bg-gray-800 px-2 py-1 text-xs text-white hover:bg-gray-900 disabled:opacity-50"
            >
              {status === "sending" ? "Sending…" : "Send"}
            </button>
            <button
              onClick={() => void submit("not_helpful")}
              className="px-2 py-1 text-xs text-gray-500 underline hover:text-gray-700"
            >
              Skip
            </button>
          </div>
          {status === "error" && (
            <span className="text-xs text-red-600" role="alert">
              Could not send — try again.
            </span>
          )}
        </div>
      )}
    </div>
  );
};
