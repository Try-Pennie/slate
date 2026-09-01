# No staging environment; production is the first real environment

There is one Worker and one Supabase project. `main` deploys straight to
production, and local `next dev` points at the same live Supabase and the real
Slack. Every change's first contact with real configuration is production.

## Status

Accepted (#1038), and reversible: the reversal is listed at the bottom. Recorded
because "there is no staging" reads as an oversight until somebody writes down that
it was weighed.

## Why

A staging lane is not free, and the cost is not the setup. It is a second
environment to keep in sync forever: a second set of secrets, a second Supabase whose
schema and seed data drift from production the moment somebody forgets, a second
Google Workspace delegation, and a second deploy path. A staging environment that has
drifted is worse than none, because a green staging run then reads as evidence.

What makes it skippable here is that the risky classes are covered by controls that
run against production's real shape rather than a copy of it:

- **A prod-shape build on every PR.** `pnpm cf:build` is the real Cloudflare/OpenNext
  build, in the pre-push hook and in CI, so a build-only break cannot reach main. This
  is the single largest thing a staging deploy would have caught.
- **Schema drift is gated, not hoped for.** A committed but unapplied migration fails
  both the `migration-drift` job and the deploy, and the prod monitor pages if code
  ships ahead of its schema. Migrations are applied deliberately, before the PR merges,
  through a written runbook.
- **The deploy verifies itself.** The post-deploy probe refuses to judge health until
  the expected commit is actually serving, so a broken deploy cannot be reported as
  healthy by a 200 from the previous version.
- **Isolated production fixtures.** The smoke canary runs the real booking, reschedule
  and cancel flows against live production on dedicated SMOKE agents and buckets
  (#396), which cannot touch a real agent or a real lead. This is the part that
  genuinely replaces a staging soak: it exercises production, which is the environment
  that matters, without exercising real people.
- **Failure is loud and fast.** Any canary failure, any deploy failure, and any lane
  going quiet posts to Slack.

## What this costs, stated plainly

- **A configuration mistake is found in production.** The controls above catch code
  and schema; a wrong secret, a missing binding or a mistyped variable is found by the
  monitor lane or the canary, minutes after it ships, not before.
- **`next dev` writes to live data.** Development against the real Supabase means a
  careless local run can write a real row and a real Slack alert. Test buckets and the
  `is_test` convention bound it; care is the rest of it.
- **No load or migration rehearsal.** A migration's behaviour on production-sized data
  is first observed on production. The load harness compensates for the load half by
  seeding a realistic roster, but it runs against the same project.
- **A rollback is the only undo.** With no staging to catch it, the recovery path for a
  bad deploy is a revert plus a redeploy, which is why the deploy is fast and the probe
  exists.

## What would change the decision

Any one of these, and the cost calculation flips:

- more than one engineer shipping concurrently, where "production is the first real
  environment" becomes somebody else's outage;
- a change class the controls above cannot cover, most obviously a destructive
  migration on a large table, which wants a rehearsal on a Supabase branch;
- real consumer traffic at a volume where minutes of a misconfiguration is a
  measurable number of lost bookings, rather than a canary page.

The cheapest reversal is not a full second environment: it is a **Supabase branch**
for the migration rehearsal, created per risky change and thrown away, plus a second
Worker environment in `wrangler.jsonc` if configuration ever needs a dry run. Neither
requires the permanent parallel environment this record is declining.
