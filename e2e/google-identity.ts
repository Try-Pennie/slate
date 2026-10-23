/**
 * A Google identity for each auth user the browser checks sign in as (#3526).
 *
 * Slate refuses a session whose auth user holds no Google identity, or two, at the
 * sign in callback and on every request, because the Google account is what says
 * whose Slate account a session is. A local run cannot reach Google, so `signIn`
 * makes its code with a magic link, and the auth user that leaves holds only an
 * email identity. So, between asking for the link and following it, the local
 * stack is given what production always has: one Google identity on that auth
 * user, with a stable account id per person. It is written straight into the
 * throwaway database (`auth.identities`), the way GoTrue would have written it;
 * nothing in the app learns to accept anything less (L719).
 *
 * The id is stable per address, so signing the same person in again adds nothing
 * (the conflict key is GoTrue's own) and matches the account their row recorded at
 * their first sign in.
 */

/** The Google account id one local person signs in with. */
export function e2eGoogleSub(email: string): string {
  return `e2e-google-${email.trim().toLowerCase()}`;
}

/**
 * $1 the account id, $2 the address. Writes nothing when the auth user does not
 * exist yet, which the read back below then refuses.
 */
export const GOOGLE_IDENTITY_INSERT = `
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  select $1, u.id, jsonb_build_object('sub', $1, 'email', u.email, 'email_verified', true), 'google', now(), now(), now()
  from auth.users u
  where lower(u.email) = lower($2)
  on conflict (provider_id, provider) do nothing
`;

/** Every Google account id on the auth user with this address, after the write. */
const GOOGLE_IDENTITIES_READ = `
  select i.identity_data ->> 'sub' as sub
  from auth.identities i
  join auth.users u on u.id = i.user_id
  where lower(u.email) = lower($1) and i.provider = 'google'
`;

export type Query = (sql: string, params: unknown[]) => Promise<{ rows: { sub?: unknown }[] }>;

/**
 * Give this person's auth user its one Google identity, and prove it: anything but
 * exactly one, carrying the expected id, fails the sign in here rather than as a
 * refusal three steps later that reads like a bug in the app.
 */
export async function attachGoogleIdentity(query: Query, email: string): Promise<void> {
  const sub = e2eGoogleSub(email);
  await query(GOOGLE_IDENTITY_INSERT, [sub, email]);
  const { rows } = await query(GOOGLE_IDENTITIES_READ, [email]);
  const subs = rows.map((r) => r.sub);
  if (subs.length !== 1 || subs[0] !== sub) {
    throw new Error(
      `the local auth user for ${email} should hold exactly one Google identity (${sub}) and holds ${JSON.stringify(subs)}`,
    );
  }
}
