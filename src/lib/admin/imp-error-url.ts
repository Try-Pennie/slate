/**
 * The redirect target for a failed "view as" (impersonation) attempt.
 *
 * IT HAS TO POINT AT A PAGE THAT RENDERS THE ERROR, and for a while it did not
 * (#1795). This sent the admin to `/admin` while the only surface rendering
 * `imp_error` was `/admin/agents`, which is where the roster moved when the admin
 * area was split into sections (#1748). The parameter arrived on the health
 * dashboard, which ignores it, so every impersonation failure was silent: a bounce
 * to a different screen with nothing said. `scripts/test-impersonation-error-surface.ts`
 * derives the page file from this URL and asserts it renders the parameter, so the
 * two cannot drift apart again by editing one of them (L70).
 *
 * #141 also echoed the typed email back so the free text field could repopulate
 * itself. That field is gone (#1795) and nothing reads the echo, so it is gone
 * too: every remaining caller is a per row control that already knows its target,
 * and the messages name the address anyway. Dead code is worse than deleted code.
 *
 * Kept pure and separate from the "use server" actions module (which may only
 * export async functions) so it is unit-testable.
 */
export function impersonationErrorUrl(message: string): string {
  const params = new URLSearchParams({ imp_error: message });
  return `/admin/agents?${params.toString()}`;
}
