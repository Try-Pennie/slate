"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

/**
 * Cancelling a request is destructive and irreversible, so a single misclick
 * shouldn't do it. The resting state is a quiet "Cancel" link; clicking it
 * reveals an inline "Cancel this? Yes / Keep it" prompt (no modal) that submits
 * the surrounding form. The confirm button shows an in-flight spinner so the
 * cancel never feels like nothing happened.
 */

const ringCls =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky";

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`rounded-md px-2.5 py-1.5 text-sm font-semibold text-error transition-colors hover:bg-error/10 ${ringCls}`}
    >
      {pending ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
          />
          Cancelling…
        </span>
      ) : (
        "Yes, cancel"
      )}
    </button>
  );
}

export function CancelRequestButton({
  action,
  requestId,
}: {
  action: (form: FormData) => void;
  requestId: string;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={`rounded-md px-3 py-1.5 text-sm font-semibold text-fg-muted transition-colors hover:bg-error/10 hover:text-error ${ringCls}`}
      >
        Cancel
      </button>
    );
  }

  return (
    <form
      action={action}
      className="pn-confirm-enter flex items-center gap-1"
    >
      <input type="hidden" name="request_id" value={requestId} />
      <span className="mr-1 text-sm text-fg-muted">Cancel this?</span>
      <ConfirmButton />
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className={`rounded-md px-2.5 py-1.5 text-sm font-semibold text-fg-muted transition-colors hover:bg-pennie-sky-soft hover:text-fg dark:hover:bg-accent/15 ${ringCls}`}
      >
        Keep it
      </button>
    </form>
  );
}
