import { startImpersonation } from "@/app/admin/actions";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { canImpersonate } from "@/lib/auth/roles";
import type { Role } from "@/lib/db/types";

/**
 * "View as this person", on the person (#1749).
 *
 * The control renders NOTHING when the actor could not impersonate this target,
 * rather than rendering and being refused. Impersonation carries a role ceiling
 * (#588): `canImpersonate` requires the actor to be an admin and to rank STRICTLY
 * below nobody, so an admin cannot view as another admin, and nobody can view as
 * themselves. On the free text field those refusals arrive after you type and
 * press, which is acceptable there. On a per row control it would put a visible
 * button on rows where pressing it can only ever produce that error, which is a
 * control that reads as available until it is used (L109).
 *
 * The gate is presentation only. `startImpersonation` re-checks both conditions
 * itself and is the thing that actually enforces them; hiding a control is never
 * the control.
 *
 * The action resolves its target by EMAIL, so the row submits the row's own
 * address in a hidden field. That also keeps the accessible name carrying who the
 * button is for: a table of identical "View as" buttons is a control addressed by
 * position rather than by identity (L237).
 */
export function ViewAsButton({
  actorRole,
  actorId,
  target,
  className,
}: {
  actorRole: Role;
  actorId: string;
  target: { id: string; email: string; name: string | null; role: Role };
  className?: string;
}) {
  if (target.id === actorId) return null;
  if (!canImpersonate(actorRole, target.role)) return null;

  const who = target.name ?? target.email;
  return (
    <form action={startImpersonation} className="inline">
      <input type="hidden" name="email" value={target.email} />
      <SubmitButton
        className={className ?? "text-sm text-pennie-blue underline dark:text-pennie-sky"}
        pendingLabel="Switching…"
      >
        {`View as ${who}`}
      </SubmitButton>
    </form>
  );
}
