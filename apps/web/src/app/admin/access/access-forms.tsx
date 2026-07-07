"use client";

import { useState } from "react";
import type { ActionResult } from "./actions";

type Feedback = { kind: "success" | "error"; message: string };

/**
 * Renders the ActionResult from a grant/revoke server action as visible
 * feedback. These are plain client components that call the server action
 * directly (server actions are callable as regular async functions from
 * client components in the Next.js App Router) rather than using
 * `<form action={...}>`, because the installed stack (React 18.3.1 /
 * react-dom 18.3.1) does not have `useFormState`/`useActionState` on its
 * stable channel — those hooks only exist in the `canary` type/build
 * channel for this version pairing.
 */
function FeedbackBanner({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;
  const className =
    feedback.kind === "success"
      ? "rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800"
      : "rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800";
  return (
    <p
      role={feedback.kind === "success" ? "status" : "alert"}
      className={className}
    >
      {feedback.message}
    </p>
  );
}

export function GrantAccessForm({
  action,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // Manually managed rather than useTransition's `isPending`: on React
  // 18.3.1 (installed here — see the note above), `isPending` only tracks
  // the synchronous portion of a transition. Once the callback hits its
  // first `await`, `isPending` flips back to `false` well before the actual
  // server round-trip completes, so a button disabled by `isPending` alone
  // re-enables early and no longer guards against double submission. This
  // pattern only becomes reliable under React 19's Actions model.
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const form = event.currentTarget;
    setIsSubmitting(true);
    try {
      const result = await action(formData);
      if (result.ok) {
        setFeedback({ kind: "success", message: "Access granted." });
        form.reset();
      } else {
        setFeedback({ kind: "error", message: result.error });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-3">
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
      <button
        type="submit"
        disabled={isSubmitting}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {isSubmitting ? "Granting..." : "Grant"}
      </button>
      <FeedbackBanner feedback={feedback} />
    </form>
  );
}

export function RevokeAccessForm({
  action,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // See GrantAccessForm above for why this is a manual boolean rather than
  // useTransition's `isPending` on React 18.3.1.
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const form = event.currentTarget;
    setIsSubmitting(true);
    try {
      const result = await action(formData);
      if (result.ok) {
        setFeedback({ kind: "success", message: "Access revoked." });
        form.reset();
      } else {
        setFeedback({ kind: "error", message: result.error });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mt-8 space-y-3">
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
      <button
        type="submit"
        disabled={isSubmitting}
        className="rounded border px-4 py-2 disabled:opacity-50"
      >
        {isSubmitting ? "Revoking..." : "Revoke"}
      </button>
      <FeedbackBanner feedback={feedback} />
    </form>
  );
}
