import { endDroppedImpersonation } from "@/app/admin/actions";
import { ImpersonationDropAutoClear } from "@/components/ImpersonationDropAutoClear";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * One-time notice shown when a "view as" session was silently dropped (#652):
 * the impersonated user timed out (#653) or became ineligible mid-session, so the
 * app already reverted the admin to their own view. Explains which happened, then
 * clears the stale cookie (automatically via ImpersonationDropAutoClear, or via
 * the no-JS Dismiss form). `role="status"` so it's announced to screen readers.
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
