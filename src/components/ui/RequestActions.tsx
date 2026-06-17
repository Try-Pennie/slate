"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { EditRequestButton } from "@/components/ui/EditRequestButton";

/**
 * Edit + Cancel for a request row. Cancelling is destructive, so it asks first
 * with an inline confirm — but the confirm REPLACES the Edit/Cancel pair (rather
 * than crowding in beside them) and lives in its own soft-rose group with a
 * clear "this is the destructive one" hierarchy, so the row never reads as a
 * run-on of text links.
 */

const ghost =
  "rounded-md px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky";

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`${ghost} bg-error/10 text-error hover:bg-error/20`}
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

export function RequestActions({
  requestId,
  cancelAction,
}: {
  requestId: string;
  cancelAction: (form: FormData) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <form
        action={cancelAction}
        className="pn-confirm-enter flex shrink-0 items-center gap-1 rounded-lg bg-error/5 p-1"
      >
        <input type="hidden" name="request_id" value={requestId} />
        <span className="pl-2 pr-1 text-sm text-fg-muted">Cancel this?</span>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className={`${ghost} text-fg-muted hover:bg-pennie-sky-soft hover:text-fg dark:hover:bg-accent/15`}
        >
          Keep it
        </button>
        <ConfirmButton />
      </form>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <EditRequestButton requestId={requestId} />
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={`${ghost} text-fg-muted hover:bg-error/10 hover:text-error`}
      >
        Cancel
      </button>
    </div>
  );
}
