# Smoke-test setup runbook

The production smoke test (`scripts/smoke-booking-api.ts`) exercises the live
direct booking API end to end. It never books a real round-robin agent because it
routes only to a dedicated, isolated test agent and its buckets (#396, PR #452).
That isolation has a manual side that has to be set up once and is easy to forget.
This runbook captures it.

It runs both by hand (below) and automatically as a scheduled canary (#525): see
[Automated canary](#automated-canary) at the end.

The moving parts:

- **`smoketest@trypennie.com`**: the primary test agent. Booking impersonates it
  (domain-wide delegation) to create the calendar event, and every synthetic
  attendee is a plus-alias of it (`smoketest+<tag>@trypennie.com`), so Google's
  invite and cancel emails deliver into that one inbox instead of bouncing an
  "undeliverable" notice onto a real agent.
- **`smoketest2@trypennie.com`**: a second bookable test agent. It is the reassign
  target (#450) and, as a member of the `SMOKE` bucket (#464), the second agent
  the reschedule-stickiness scenario (#523) needs.
- **`SMOKE` and `SMOKE2` buckets**: the isolated buckets those agents serve. The
  smoke test defaults to them, so a run never touches the live fleet.

## Preconditions

- `.env.local` at the repo root holds `NEXT_PUBLIC_SUPABASE_URL` and
  `SUPABASE_SECRET_KEY` (the seed script reads both from that file). The smoke
  test also reads `BOOKING_API_KEY` (and, for the optional reassign scenario,
  `REASSIGN_API_KEY`) from `.env.local` or `.dev.vars`, so no key needs to be
  typed on the command line.
- Node with `--experimental-strip-types` support (the same runtime the other
  `scripts/*.ts` helpers use).

## Steps

1. **Create the two Workspace mailboxes.** In Google Workspace admin, create
   `smoketest@trypennie.com` and `smoketest2@trypennie.com` as real mailboxes
   under the same domain-wide-delegation scope the app already uses to impersonate
   agents. Both must be real, delivering mailboxes: booking impersonates each
   address to create its calendar event, `smoketest@` receives the plus-alias
   invite and cancel emails, and `smoketest2@` receives the moved event from the
   reassign scenario. This is the one genuinely manual, one-time step; the rest is
   scripted.

2. **Preview the seed (writes nothing).** From the repo root, run the seed in its
   default dry-run mode and read the planned rows:

   ```
   node --experimental-strip-types scripts/seed-smoke-test.ts
   ```

3. **Apply the seed.** Re-run with `APPLY=1` to write the agents, schedules,
   rules, buckets, and members to the project in `.env.local`. It is idempotent,
   so re-running only refreshes the rows in place:

   ```
   APPLY=1 node --experimental-strip-types scripts/seed-smoke-test.ts
   ```

4. **Wait for the crons to publish SMOKE slots.** The seed does not create the
   calendar link or the availability directly. The per-calendar watch cron adds
   the `agent_calendars` row on its next pass once each mailbox exists, and the
   recompute cron then publishes open `SMOKE` and `SMOKE2` slots. Give it a cycle
   or two, then confirm the slots are live before running the test:

   ```
   node --experimental-strip-types scripts/smoke-booking-api.ts
   ```

   The run first checks that `SMOKE` has at least five open slots and exits early
   if not. If it exits on "Not enough slots", the crons have not published yet;
   wait another cycle and re-run. To confirm routing is healthy without creating
   any bookings, run the side-effect-free dry-run only:

   ```
   SMOKE_DRY_RUN_ONLY=1 node --experimental-strip-types scripts/smoke-booking-api.ts
   ```

## Notes

- **Keys live in `.env.local`, never on the command line.** `BOOKING_API_KEY` is
  required; the test exits with a message if it is missing. `REASSIGN_API_KEY`
  enables the reassign scenario (#450), which otherwise reports SKIP. Add both to
  `.env.local` or `.dev.vars` so a plain `node ... scripts/smoke-booking-api.ts`
  works.
- **Skips are surfaced loudly.** A clean run with skipped scenarios prints
  "coverage incomplete". Set `SMOKE_STRICT=1` to make any skip a non-zero exit so
  a scheduled run requires full coverage.
- **Teardown is guaranteed.** Each scenario cancels its own bookings, and a
  final sweep cancels every booking under every identity it booked, running from a
  `finally` block. A partway failure does not leak a live booking onto the fleet.
- **Override the target only on purpose.** `SMOKE_BUCKET`, `SMOKE_BUCKET_B`, and
  `SLATE_BASE_URL` let you point at a different bucket or deployment. Leave them at
  their defaults (`SMOKE`, `SMOKE2`, prod) so a run stays isolated to the test
  agents.

## Automated canary

`.github/workflows/smoke-canary.yml` runs the same scripts on a schedule (#525),
so a booking regression is caught without anyone remembering to run it:

- **Every ~30 min**: the side-effect-free dry-run tick (`SMOKE_DRY_RUN_ONLY=1`) as
  a fast health check against the live fleet.
- **Every 6h**: the full strict pass (`SMOKE_STRICT=1`, plus
  `scripts/smoke-reschedule.ts`). It sets `SMOKE_SKIP_EVENT_CLEANUP=1` because the
  runner has no Google service-account creds; the API-driven cancels still tear
  down every booking server-side, only the belt-and-suspenders orphan-event sweep
  is skipped.
- **On demand**: `workflow_dispatch` runs either pass (pick `dry` or `full`).

Two ways it stays honest:

- **Alert on failure.** Any failed step (a real regression, a bad key, a missing
  fixture) posts a Slack alert via `scripts/notify-smoke-failure.ts`.
- **Alert on not-having-run.** Each successful run stamps the `smoke-canary`
  heartbeat (`POST /api/smoke/heartbeat`, Bearer `BOOKING_API_KEY`). The
  lane-watchdog pages if that heartbeat goes stale past `CANARY_STALE_BOUNDS_MS`
  (90 min), so a schedule that silently stops firing is noticed. This is kept out
  of `LANE_STALE_BOUNDS_MS` on purpose: a dead canary must not flip the external
  `/api/health` 503 as if the app itself were down.

**Required repo settings (Actions):** the workflow needs `BOOKING_API_KEY` and
`REASSIGN_API_KEY` as repo **secrets** (the Worker's keys, added to Actions), plus
the existing `SLACK_BOT_TOKEN` secret and `SLACK_ALERTS_CHANNEL` variable. Until
`BOOKING_API_KEY` is set, the scheduled runs fail (and alert). Trigger a first run
manually from the Actions tab once the secrets are in.
