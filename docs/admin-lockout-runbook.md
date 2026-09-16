# Recovering from admin lockout

Nobody can reach `/admin` with an admin role. This is the one incident whose fix is
a direct database write, so the steps are written down rather than rediscovered
under pressure (#1053).

Read this before typing anything: the same write that recovers an org can grant
somebody the whole system, so **who** you are promoting matters more than how fast.

## Why there is no in-product way out

Every new login is provisioned `role = 'agent'`, deliberately, with no first-admin
bootstrap (`src/lib/provision.ts`, #599). An empty organization must never mint an
admin, or a normal sign-in becomes a silent privilege escalation: whoever signs in
first would own the system. The cost of that choice is exactly this runbook.

The in-product guard also refuses to remove the last admin (`Cannot remove the last
admin`), so the reachable ways to end up locked out are narrower than they look:

- the only admin left the company and their row was deactivated;
- the only admin's Google account is gone or cannot sign in, so the role is intact
  and unreachable;
- a role was changed by a direct database write that bypassed the guard;
- a brand new deployment, which starts with no admin at all and is the ordinary
  first-run case rather than an incident.

## What a session actually resolves

A signed-in person is matched to their Slate row by `users.auth_user_id`, which
holds the `auth.users.id` Supabase Auth issued at first login. So the row you are
fixing must be the one carrying **that** person's `auth_user_id`, not merely their
email address. A row with a null `auth_user_id` has never logged in (it is a
Salesforce-synced agent), and setting its role grants nothing until somebody signs
in and gets linked to it.

Roles, lowest to highest: `agent`, `manager`, `team_lead`, `admin`, `super_admin`.
`admin` is enough for everything in `/admin`; `super_admin` additionally covers
impersonation and role management. Promote to `admin` unless you know you need more.

## Recovery

Run these through the `/db-apply` path or the Supabase SQL editor for the project
in `docs/../CLAUDE.md`'s Supabase section. Take them in order and read the output of
each before running the next.

### 1. Confirm the lockout, rather than assuming it

```sql
select u.id, u.email, u.role, u.auth_user_id is not null as has_logged_in, u.deactivated_at
from users u
where u.role in ('admin', 'super_admin')
order by u.email;
```

Zero rows is a genuine lockout. Rows whose `deactivated_at` is set, or whose
`has_logged_in` is false, are the more common cause: an admin exists on paper and
cannot get in. If a row comes back that should be able to sign in, the problem is
authentication, not roles, and promoting somebody else will not fix it.

Those two states are refused in different places, which matters for how you fix
them (#2378). A row whose `deactivated_at` is set is refused by the app on every
request, and the person is ALSO banned in Supabase Auth by the deactivation, so
clearing the column by hand is not enough on its own: see step 2a below. A row
whose `auth_user_id` is null has simply never been linked to a Google account, and
nothing is blocking them; they sign in once and the link is made.

### 2. Find the person to promote, by the account that actually signs in

```sql
select id, email, role, auth_user_id, deactivated_at, org_id
from users
where email = 'person@trypennie.com';
```

Check three things in that output: `auth_user_id` is not null (they have signed in
at least once, so the row is linked to a real Google account), `deactivated_at` is
null, and `org_id` is the organization you mean to give them admin over. If
`auth_user_id` is null, have them sign in to Slate once first: that creates the link,
and the sign-in itself grants nothing.

### 2a. If `deactivated_at` is set, reactivate through the product, not by hand

Deactivating somebody does two things (#2378): it stamps `deactivated_at`, and it
bans their Supabase auth user so they can neither refresh a session nor sign in
again. Only the first is a column you can see. Clearing it with SQL leaves the ban
in place, so the row reads as perfectly active while every sign in attempt still
fails, with nothing on any screen saying why, and you will spend the next hour
looking at roles.

Reactivate through the product, which lifts both: the Reactivate control on the
agent page, or the lifecycle endpoint an admin can still reach.

```
POST /api/users/lifecycle   { "email": "person@trypennie.com", "action": "activate" }
```

Read the response. It reports `sessionRevoke`, and only `"restored"` means the ban
was lifted; `"failed"` means the auth call did not land and re-running it is the
fix. `"no-auth-account"` means they have never signed in, so there was no ban to
lift and nothing is wrong.

If nobody can reach either (that is the lockout you are in), lift the ban in the
Supabase dashboard under Authentication, Users, by clearing the `banned_until` on
that auth user, and then clear `deactivated_at` with the statement in step 3's
shape. Doing only one of the two leaves the account broken in a way neither screen
explains.

### 3. Promote them

```sql
update users set role = 'admin' where email = 'person@trypennie.com' and auth_user_id is not null;
```

The statement must report **1 row updated**. Zero means the email does not match, or
the account has never signed in; do not re-run it with the guard removed, go back to
step 2 and find out which. More than one row means two rows share that address, which
is its own problem: stop and resolve that first, because promoting both grants admin
to an account nobody has accounted for.

### 4. Confirm from the other side

```sql
select email, role, auth_user_id is not null as has_logged_in
from users
where role in ('admin', 'super_admin')
order by email;
```

Then have them load `/admin` in a **fresh** browser session. The role is read per
request, so an existing session picks it up on the next page load with no sign-out
needed, but a fresh load is the honest check.

### 5. Record it

A direct database write leaves no `audit_log` row, because the audit trail is written
by the application and this bypassed it. That is the one gap this procedure has, and
it matters: an unexplained admin is indistinguishable from a compromise. So say in
the incident channel who was promoted, by whom, and why, on the day it happened.

## Preventing the next one

Keep **at least two** admins whose Google accounts are active, in different people's
hands. The last-admin guard protects against removing the only one through the
product, and it cannot protect against the only one leaving the company.
