"use client";

import { btnSecondaryCls } from "@/components/ui/styles";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * Submit button for the roster sync form, through the ONE submit control (#1769).
 *
 * It used to carry its own `useFormStatus`, its own disabled and `aria-busy`, and
 * its own spinner: a third copy of `SubmitButton`, and a weaker one, because it
 * stopped at "it started". This sync takes several seconds and talks to two outside
 * systems, so it is exactly where the difference between still working and stalled
 * is worth having, and the elapsed count and the twenty second wording come for
 * free now.
 *
 * IT NAMES BOTH SOURCES (#2097). The job reads Salesforce for debt teams and
 * profiles and Twilio for the Redistribute tag, and it is managers who do the
 * tagging in Twilio, so a label saying only Salesforce would have them press this
 * after tagging somebody with no idea whether it covers what they just did.
 *
 * Pairs with the result banner the action redirects back with.
 */
export function SyncButton() {
  return (
    <SubmitButton
      className={`${btnSecondaryCls} min-h-11 disabled:opacity-80`}
      pendingLabel="Syncing from Salesforce and Twilio"
    >
      Sync from Salesforce and Twilio
    </SubmitButton>
  );
}
