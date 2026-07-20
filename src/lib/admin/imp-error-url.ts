/**
 * The /admin redirect target for a failed "view as" (impersonation) attempt.
 *
 * #141: when impersonation fails the admin is redirected back to /admin with an
 * error, but the email they typed was lost (the field is uncontrolled and the
 * redirect is a fresh render), so they had to retype it. Echo the email back in
 * the URL so the form can repopulate it. Kept pure and separate from the
 * "use server" actions module (which may only export async functions) so it is
 * unit-testable.
 */
export function impersonationErrorUrl(message: string, email?: string): string {
  const params = new URLSearchParams({ imp_error: message });
  if (email) params.set("imp_email", email);
  return `/admin?${params.toString()}`;
}
