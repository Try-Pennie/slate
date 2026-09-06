import { startImpersonation } from "@/app/admin/actions";
import { SaveForm } from "@/components/ui/SaveForm";
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
/**
 * Whether `actorRole` may view as `target` (#1794).
 *
 * Exported because a caller that has to decide whether the CONTROL belongs in a
 * menu needs the same answer the control gives itself, and two copies of a
 * permission rule is how the two quietly stop agreeing. `startImpersonation`
 * re-checks it server side regardless; this decides only what is drawn.
 */
export function canViewAs(
  actorRole: Role,
  actorId: string,
  target: { id: string; role: Role },
): boolean {
  if (target.id === actorId) return false;
  return canImpersonate(actorRole, target.role);
}

export function ViewAsButton({
  actorRole,
  actorId,
  target,
  className,
  role,
}: {
  actorRole: Role;
  actorId: string;
  target: { id: string; email: string; name: string | null; role: Role };
  className?: string;
  /** Set to "menuitem" when this is an item in a row's actions menu (#1794). */
  role?: string;
}) {
  if (!canViewAs(actorRole, actorId, target)) return null;

  const who = target.name ?? target.email;
  return (
    <SaveForm
      action={startImpersonation}
      name={`view-as-${target.email}`}
      // #1998: reload rather than a notice. This form is deliberately taken out
      // of the layout and the accessibility tree below so the button can be the
      // menu's own child, and an alert rendered inside that would be a
      // `role="alert"` in a `role="menu"`. Nothing is typed here either.
      onStale="reload"
      // Inside a menu the form sits between `role="menu"` and its `menuitem`,
      // which is a structure the role does not allow, so it is taken out of the
      // accessibility tree and out of the layout: `display: contents` promotes
      // the button to the menu's own child so it fills the width, and `role`
      // none does the same for assistive tech. Neither affects submission.
      role={role === "menuitem" ? "none" : undefined}
      className={role === "menuitem" ? "contents" : "inline"}
    >
      <input type="hidden" name="email" value={target.email} />
      <SubmitButton
        role={role}
        className={className ?? "text-sm text-pennie-blue underline dark:text-pennie-sky"}
        pendingLabel="Switching…"
      >
        {`View as ${who}`}
      </SubmitButton>
    </SaveForm>
  );
}
