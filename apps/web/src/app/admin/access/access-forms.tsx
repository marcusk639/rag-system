"use client";

import { useState, useTransition } from "react";
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
    <p role="status" className={className}>
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
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const form = event.currentTarget;
    startTransition(async () => {
      const result = await action(formData);
      if (result.ok) {
        setFeedback({ kind: "success", message: "Access granted." });
        form.reset();
      } else {
        setFeedback({ kind: "error", message: result.error });
      }
    });
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
        disabled={isPending}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {isPending ? "Granting..." : "Grant"}
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
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const form = event.currentTarget;
    startTransition(async () => {
      const result = await action(formData);
      if (result.ok) {
        setFeedback({ kind: "success", message: "Access revoked." });
        form.reset();
      } else {
        setFeedback({ kind: "error", message: result.error });
      }
    });
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
        disabled={isPending}
        className="rounded border px-4 py-2 disabled:opacity-50"
      >
        {isPending ? "Revoking..." : "Revoke"}
      </button>
      <FeedbackBanner feedback={feedback} />
    </form>
  );
}
