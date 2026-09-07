import { endDroppedImpersonation } from "@/app/admin/actions";
import { ImpersonationDropAutoClear } from "@/components/ImpersonationDropAutoClear";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * One-time notice shown when a "view as" session was silently dropped (#652):
 * the impersonated user timed out (#653) or became ineligible mid-session, so the
 * app already reverted the admin to their own view. Explains which happened, then
 * clears the stale cookie (automatically via ImpersonationDropAutoClear, or via
 * the no-JS Dismiss form). `role="status"` so it's announced to screen readers.
 *
 * IT STAYS AN ORDINARY BAR, and that is the #2037 decision rather than an
 * oversight (IM9). This notice says the dangerous state is OVER: the app has
 * already put you back in your own view and nothing is being done as anybody
 * else. Ordinary chrome is the right weight for that, and dressing it as a
 * warning would compete with the two surfaces that are warning about something
 * still true.
 *
 * It has to be told apart from both of them, and now is:
 *
 * - from the ACTIVE marker, by FORM rather than by colour. That is a hazard
 *   striped frame around the whole viewport with a mustard strip; this is a bar
 *   in the flow. The two can no longer be confused at a glance, which is what
 *   the old navy bar could not manage when the active state was also a navy bar.
 * - from the calendar failure bar, by colour: rose means something is wrong right
 *   now, and nothing here is.
 */
export function ImpersonationDropNotice({
  reason,
}: {
  reason: "expired" | "unavailable";
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-pennie-navy px-4 py-2 text-center text-sm text-pennie-beige"
    >
      <span>
        {reason === "expired"
          ? "Your view-as session timed out. You're back to your own view."
          : "The person you were viewing as is no longer available. You're back to your own view."}
      </span>
      {/* No-JS fallback: a real form so the cookie can be cleared without
          scripting. With JS the auto-clear already ran, so this just dismisses. */}
      <form action={endDroppedImpersonation.bind(null, reason)}>
        <SubmitButton className="pn-btn pn-btn--small pn-btn--primary" pendingLabel="Dismissing">
          Dismiss
        </SubmitButton>
      </form>
      <ImpersonationDropAutoClear reason={reason} />
    </div>
  );
}
