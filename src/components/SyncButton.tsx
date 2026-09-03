"use client";

import { btnSecondaryCls } from "@/components/ui/styles";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * Submit button for the Salesforce sync form, through the ONE submit control
 * (#1769).
 *
 * It used to carry its own `useFormStatus`, its own disabled and `aria-busy`, and
 * its own spinner: a third copy of `SubmitButton`, and a weaker one, because it
 * stopped at "it started". This sync takes several seconds and talks to
 * Salesforce, so it is exactly where the difference between still working and
 * stalled is worth having, and the elapsed count and the twenty second wording
 * come for free now.
 *
 * Pairs with the result banner the action redirects back with.
 */
export function SyncButton() {
  return (
    <SubmitButton
      className={`${btnSecondaryCls} min-h-11 disabled:opacity-80`}
      pendingLabel="Syncing from Salesforce"
    >
      Sync from Salesforce
    </SubmitButton>
  );
}
