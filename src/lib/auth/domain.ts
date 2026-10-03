/**
 * Server-side Google Workspace domain gate (#589).
 *
 * The Google `hd` parameter set on the login page is only a UI hint: it can be
 * dropped by hitting the OAuth URL directly, so it cannot be trusted to keep
 * outsiders out. The real enforcement lives in the auth callback, which calls
 * this with the *verified* email from the exchanged session.
 *
 * When `domain` is empty every account is allowed. That open mode is only
 * reachable through `resolveHostedDomain` below with an explicit
 * ALLOW_ANY_GOOGLE_DOMAIN=1, never by the var going missing (#3083). Otherwise the email's domain must equal the
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

/** GOOGLE_HOSTED_DOMAIN is unset and nothing opted into the open mode (#3083). */
export class HostedDomainMissingError extends Error {
  constructor() {
    super(
      "GOOGLE_HOSTED_DOMAIN is not set; refusing every sign-in. Set it, or set " +
        "ALLOW_ANY_GOOGLE_DOMAIN=1 to allow any Google account on purpose.",
    );
    this.name = "HostedDomainMissingError";
  }
}

/**
 * The domain sign-in is limited to, failing CLOSED (#3083). An unset or blank
 * GOOGLE_HOSTED_DOMAIN used to read as "allow any Google account", so a deploy
 * that lost the var opened sign-in to everyone and provisioned each outsider as
 * an agent. Now it throws, and only ALLOW_ANY_GOOGLE_DOMAIN set to exactly "1"
 * returns the empty "allow any" value. A configured domain always wins over the
 * flag, so the flag can only widen a gate nobody configured.
 */
export function resolveHostedDomain(env: Record<string, string | undefined>): string {
  const domain = (env.GOOGLE_HOSTED_DOMAIN ?? "").trim();
  if (domain) return domain;
  if (env.ALLOW_ANY_GOOGLE_DOMAIN === "1") return "";
  throw new HostedDomainMissingError();
}
