/**
 * Server-side Google Workspace domain gate (#589).
 *
 * The Google `hd` parameter set on the login page is only a UI hint: it can be
 * dropped by hitting the OAuth URL directly, so it cannot be trusted to keep
 * outsiders out. The real enforcement lives in the auth callback, which calls
 * this with the *verified* email from the exchanged session.
 *
 * When `domain` is empty (GOOGLE_HOSTED_DOMAIN unset) every account is allowed,
 * preserving the open PoC mode. Otherwise the email's domain must equal the
 * configured domain exactly (case-insensitive) — no subdomain or suffix
 * wildcarding, so `foo@evil.trypennie.com` and `foo@trypennie.com.evil.com`
 * are both rejected.
 */
export function isAllowedEmail(email: string, domain: string): boolean {
  const allowed = domain.trim().toLowerCase();
  if (!allowed) return true;

  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const emailDomain = email.slice(at + 1).toLowerCase();
  return emailDomain === allowed;
}
