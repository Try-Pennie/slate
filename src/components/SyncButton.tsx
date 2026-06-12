"use client";

import { useFormStatus } from "react-dom";
import { btnSecondaryCls } from "@/components/ui/styles";

/**
 * Submit button for the Salesforce sync form. The sync takes a few seconds, so
 * the button shows a live "Syncing…" pending state with a spinner (instead of
 * looking frozen) and disables to prevent double-submits. Pairs with the result
 * banner the action redirects back with.
 */
export function SyncButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`${btnSecondaryCls} min-h-11 disabled:opacity-80`}
    >
      {pending ? (
        <>
          <span
            aria-hidden
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          Syncing…
        </>
      ) : (
        "Sync from Salesforce"
      )}
    </button>
  );
}
