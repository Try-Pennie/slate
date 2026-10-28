# Disaster recovery runbook

What to do when the Slate database has to be restored, and what has to be
reconciled afterwards. Read the whole page before starting: the restore itself is
the easy half, and the order of the reconciliation matters.

The reason this page exists at all: **a booking is not one write.** Confirming a
call writes a row in Postgres, creates an event on a Google calendar, sends the
lead and the agent a calendar invite, and emits a webhook to Regal. A restore
rolls back only the first of those. Everything else stays exactly as it was, so a
database-only restore is **guaranteed** to leave Slate disagreeing with Google,
with the customer's inbox, and with Regal. Reconciling those is most of this
page.

---

## Recovery objectives

| | Objective | What is in force today |
|---|---|---|
| **RPO, bookings** (and the other five mirrored tables: `booking_events`, `booking_outbox`, `routing_decisions`, `webhook_deliveries`, `audit_log`) | **About 30 minutes** | The Snowflake export lane copies every change to these tables to the warehouse every 30 minutes (`MIRROR_TABLES` in `src/lib/snowflake/export-core.ts`). If it stops, the lane watchdog pages once its heartbeat is 90 minutes old (`MIRROR_STALE_BOUNDS_MS`), so the worst case before anybody is told is 90 minutes. Section 4 writes them back with `pnpm restore:from-snowflake`. |
| **RPO, everything else** (advisors, pools, working hours, business hours, settings, time off, calendars) | **24 hours** | Two full logical dumps a day (07:40 and 19:40 UTC), stored off platform in Cloudflare R2 by `.github/workflows/db-backup.yml`. The objective is a day; the second slot is for resilience, because GitHub runs these scheduled jobs hours late and a single slot twice drifted past the alarm. The lane watchdog pages when the newest dump is older than 26 hours (`BACKUP_STALE_BOUNDS_MS`), and when none has ever landed. Supabase's own daily backups still exist beside it, in the same account as production. |
| **RTO** (time to serve again) | **Same business day** | Slate's bookings are business hours only, so a restore that lands before the next working morning has not breached. |

These are deliberate choices, not aspirations.

**On the RPO (decided 2026-10-03, #3075).** Until that date this page said 24 hours
for everything and accepted it because the only bookings were the canary's, with a
note to revisit once real leads were booking. They are: the pilot went live on
2026-09-29 and real bookings per day were **18, 73, 357 and 446** on 29 September to
2 October. A day of lost bookings at that volume is hundreds of leads holding a
calendar invite for a call Slate has no record of.

So the objective is now two numbers, because the data is two kinds. Bookings and the
tables around them change all day and are already copied off platform every ten
minutes by the Snowflake mirror, so they recover from there. The rest changes a few
times a day by hand (somebody edits a pool or approves time off), so a daily dump is
enough. Dan's words: "bookings every 10 minutes is enough" and "the rest once a day
and be fine".

**Point-in-Time Recovery was considered and NOT bought** (2026-10-03). Supabase prices
it at about **$100 a month for 7 days of retention** (about $200 for 14, $400 for
28), and a project using it must also run at least the **Small compute** add-on
([Supabase backups](https://supabase.com/docs/guides/platform/backups#point-in-time-recovery)).
It would give a two minute RPO on every table, but the mirror already gives ten
minutes on the tables where minutes matter, and the rest does not change fast enough
for minutes to be worth that.

**On the 30 minute cadence (decided by Dan on 2026-10-28, #4349).** The booking RPO
went from about 10 minutes to about 30, knowingly. Every export run wakes `SLATE_WH`,
and once real leads arrived around the clock (the pilot, from 2026-09-29) nearly
every 10 minute run had rows to copy: about 135 wakes a day at about 1.5 billed
minutes each, roughly $300 a month, measured in Snowflake's own usage views on
2026-10-28. A 30 minute cadence cuts the wakes to at most 48 a day. Dan accepted the
cost knowing Slate was moving from half to all of the pilot traffic the following
week, so 30 minutes is then roughly 30 to 60 bookings at the busiest hours. The
paragraph above, which declined PITR because the mirror gave ten minutes, predates
this; weigh PITR against a 30 minute RPO when it is next revisited.

**Revisit when** either of these holds, both of which can be re-measured:

- **real bookings pass 2,000 a day** (`select count(*) from bookings where created_at
  >= now() - interval '1 day'`, excluding test buckets), because thirty minutes of
  bookings is then about 42 leads, and a minute by minute objective starts to cost
  more in reconciliation than PITR costs in money; or
- **the non booking tables start changing continuously** rather than by hand, for
  example an automated roster or hours sync writing all day, because a day of those
  is then no longer a handful of edits somebody can redo.

**On the RTO.** The restore is minutes; the reconciliation is not. Budget the
whole morning and work the sections in order.

**On the forensic window, which is a third objective nobody usually writes down**
(#1047, #3105). Two copies of the logs exist, and the window is whichever reaches
further back:

- **Cloudflare** keeps every log line, unredacted, for **7 days**.
- **Better Stack** holds a REDACTED copy of every line, exception and invocation
  outcome, shipped by the tail worker since #3105 (DEPLOY.md, "Log shipping to Better
  Stack"), for the plan's retention.

**On the free tier Better Stack starts on, that retention is 3 days, which is shorter
than Cloudflare's 7, so the window is NOT widened: it is still 7 days.** What the
free tier adds is search, error grouping and a per deploy `version_id` over the most
recent 3 days, not history. The window grows only on a paid plan of more than 7 days
(30 to 90), and then only for what survives the redaction: a full URL, a query
string and a manage token exist only in Cloudflare's copy, for its 7 days.

So, today: anything older than a week can only be reconstructed from the database:
the tables, `booking_events`, `audit_log`, `webhook_deliveries`. That is enough to
answer what HAPPENED (every state change a booking went through is a durable row) and
not enough to answer WHY at the level a log line would (which agent's calendar read
failed, what Google actually returned, which code path a request took).

That is accepted while the free tier measures real volume. The longer retained copy
was made acceptable as a place holding data by redacting it before it leaves
(`docs/pii.md` §5); what is left is a cost decision about the paid plan, and a PII
decision if that plan keeps more than 45 days (`docs/pii.md` §5 again). In practice
the constraint is simpler than it sounds, because an incident that matters is noticed
by an alert within minutes, and every alert here fires while the window is wide open.

The operational consequence, worth knowing before you need it: **when an incident starts,
capture the logs first.** They expire; the database rows do not. If the shipped copy
looks thin, check `tag=log-tail` in the tail worker's own Cloudflare logs: a missing
token, a refused POST or a log storm past its per invocation budget is counted there.

---

## 0. Before you restore

**Stop and confirm a restore is actually the answer.** Restores are destructive:
they replace the current database. Most incidents that feel like they need one
(a bad deploy, a broken migration, a runaway lane) are fixed by
`wrangler rollback` or by a corrective migration, and both are reversible where
this is not.

A restore IS the answer when data has been destroyed or corrupted and no forward
fix can reconstruct it.

1. **Take a pre-change dump first. This is required, not advice**, and it applies
   to every manual migration, backfill or destructive SQL as much as to a restore.
   The current (broken) state has to stay readable: section 4 depends on reading the
   rows that existed after the restore point, and Point-in-Time Recovery is not
   enabled, so this dump is the only copy of them that is not in the warehouse.

   From the repo root, with `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` in the
   shell. It writes five files to a folder named for the moment it ran: the roles,
   the schema, the data, and the migration history's schema and data (the default
   dump leaves the history out, and a database restored without it does not know
   which migrations it already has). Then set `TABLES` to the tables the change or
   the incident touches, and each one's rows are pulled out of the data dump into a
   file of its own, so what was lost can be read without restoring anything.
<!-- runbook-unverified: this reads production, and a production dump was not taken while writing this page (2026-10-03, #3076). The same five dump commands, with --db-url pointed at a throwaway local copy of the schema instead of --linked, were run that day and produced files the restore in section 1b loaded with every table count identical; the table extraction loop was run against that dump and pulled out audit_log (5,000 rows) and business_hours (7) exactly. What is unproven is only the production read itself: the link and the time five dumps take at production's size. The daily workflow runs these same dump commands against production once its secrets exist. -->
```bash
supabase link --project-ref drukfvgaynzrralbzkzj
dir="$HOME/slate-snapshots/$(date -u +%Y%m%dT%H%M%SZ)" && mkdir -p "$dir" && echo "$dir"
supabase db dump --linked --role-only -f "$dir/roles.sql"
supabase db dump --linked -f "$dir/schema.sql"
supabase db dump --linked --data-only --use-copy -f "$dir/data.sql"
supabase db dump --linked --schema supabase_migrations -f "$dir/history_schema.sql"
supabase db dump --linked --data-only --use-copy --schema supabase_migrations -f "$dir/history_data.sql"
TABLES="bookings booking_events ooo_requests"
echo "$TABLES" | tr ' ' '\n' | while read -r t; do awk -v t="$t" 'index($0, "COPY \"public\".\"" t "\" ") == 1 {on=1} on {print} on && $0 == "\\." {on=0}' "$dir/data.sql" > "$dir/table-$t.sql"; echo "$t: $(($(wc -l < "$dir/table-$t.sql") - 2)) rows"; done
pnpm check:db-dump "$dir"
```

   The last line is the same judge the daily backup runs: it refuses a dump that is
   empty, cut short, or missing a table, and prints the row count per table. Do not
   go further until it passes. The folder holds customer contact data; keep it on an
   encrypted disk and delete it once the incident is closed.

2. **Write down the restore target** as a UTC timestamp, and the current UTC time.
   Everything below is scoped to the window between them. Call it the **gap
   window**.
   Then run the erasure list query in section 5 now, against the database as it
   stands, and keep its output: after the restore those rows are gone.
3. **Check the migration version.** Restoring to a point before a migration was
   applied puts the database *behind* the deployed Worker, which fails the
   migration drift check in CI and pages the production monitor. If the restore target
   predates the newest applied migration, plan to re-apply the migrations
   immediately after the restore (see `docs/migrations-runbook.md`) and do not
   deploy anything in between.
4. **Tell whoever owns Regal.** Section 5 is a downstream problem you cannot fix
   from here, and they need the gap window.

---

## 1. Restore the database

Supabase project **`slate`**, ref `drukfvgaynzrralbzkzj`
([dashboard](https://supabase.com/dashboard/project/drukfvgaynzrralbzkzj)).

Dashboard → Database → Backups → choose the backup → Restore.

<!-- runbook-unverified: a real restore replaces the production database, so this cannot be executed to prove it. The 2026-09-02 rehearsal (#1584) used a Supabase preview branch, which is a fresh database with the migrations applied rather than a backup restored into it, so it exercised everything AFTER this step and not this step itself. The steps mirror DEPLOY.md's backup section and Supabase's dashboard flow. -->
<!-- runbook-verified: 2026-09-02 (fd5067c4) rehearsal for #1584. The health check below was run against production and returned exactly the shape this section tells you to expect: {"status":"ok","reason":"ok","db":"ok","alerting":"ok","staleLane":null,...}. The migration catch-up instruction is confirmed too: the rehearsal branch reported 113 of 113 migrations applied, so a target behind production is brought forward by the documented flow. -->
```
# Confirm the app is talking to a live database again before going further.
curl -s https://slate.trypennie.app/api/health
```

Expect `{"status":"ok"|"degraded", "db":"ok", ...}`. `db` must read `ok`. A
`degraded` status here is normal and expected: the cron lanes have not stamped a
heartbeat since the restore, so several will read as stale for a few minutes.

If the restore target predated a migration, apply the outstanding migrations now,
following `docs/migrations-runbook.md`, before anything below.

### 1b. When Supabase's own backups are not there: restore the R2 dump

Supabase's daily backups live in the same account as production, and deleting the
project deletes them. The daily dump in R2 is the copy that survives that. It is
restored into a NEW Supabase project (create it in the dashboard, same region, then
point the Worker's `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` at it).

List the dumps and fetch the newest, with the R2 token Dan holds for the backup
bucket (the same four values the workflow reads as `R2_BACKUP_*` secrets) in the
shell as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `R2_BACKUP_ENDPOINT` and
`R2_BACKUP_BUCKET`. Then load it in ONE transaction, so a failure part way leaves the
new project empty rather than half restored. `NEW_DB_URL` is the new project's
session pooler connection string from its dashboard (Connect).

<!-- runbook-unverified: the R2 half needs a dump in the backup bucket (slate-db-backups, created 2026-10-03), and none had been taken when this was written. The psql half was rehearsed on 2026-10-03 (#3076) against two throwaway local Postgres containers running the Supabase image (supabase/postgres:17.6.1.175), never a Supabase project: a source carrying all 157 migrations plus 5,001 synthetic rows (and the 21 the migrations seed) was dumped with the same five supabase db dump commands as Step 0 (21 seconds), then these exact psql flags loaded the five files into a fresh container in 2 seconds with exit 0, after which all 49 public tables had identical row counts, 247 functions, the triggers and the RLS policy matched, and the migration history read back with the same number of rows as the source. What is unproven: the R2 download, a Supabase project as the target, and the time at production's size. -->
```bash
aws s3 ls "s3://$R2_BACKUP_BUCKET/slate/db/" --recursive --endpoint-url "$R2_BACKUP_ENDPOINT" | sort | tail -3
key="$(aws s3 ls "s3://$R2_BACKUP_BUCKET/slate/db/" --recursive --endpoint-url "$R2_BACKUP_ENDPOINT" | sort | tail -1 | awk '{print $4}')"
dir="$HOME/slate-restore/$(basename "$key" .tar.gz)" && mkdir -p "$dir"
aws s3 cp "s3://$R2_BACKUP_BUCKET/$key" "$dir/dump.tar.gz" --endpoint-url "$R2_BACKUP_ENDPOINT"
tar -xzf "$dir/dump.tar.gz" -C "$dir"
pnpm check:db-dump "$dir"
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file "$dir/roles.sql" --file "$dir/schema.sql" --file "$dir/history_schema.sql" \
  --command 'SET session_replication_role = replica' \
  --file "$dir/data.sql" --file "$dir/history_data.sql" \
  --dbname "$NEW_DB_URL"
```

`session_replication_role = replica` is not optional: the data has circular foreign
keys (`busy_blocks` and `ooo_requests`), and the dump's own warning says it cannot be
loaded with them enforced. The dump is up to a day old by design, so the restore
point for everything after this is the dump's timestamp (it is in the file name), and
section 4 starts with the warehouse writing back the bookings since then.

**Rehearsal record.** 2026-10-03, offline, as described in the marker above: dump 21
seconds and restore 2 seconds, against a database of about 5,000 rows. That proves the
commands and the file set (it is how the missing migration history was found: the
first rehearsal restored every table and no history at all, which is why the dump is
five files and not three). It does not measure production; time the first real
restore drill and record it here.

---

## 2. Re-register the Google push channels (do this FIRST)

**This is the step that will be missed, and it fails silently.**

Slate keeps each calendar's push channel id and its expiry in `agent_calendars`.
The watch lane only re-registers a calendar whose stored expiry is inside three
days, and a channel lasts about a week. So after a restore the stored expiry is
still comfortably in the future and **the watch lane will decide every calendar
is current and do nothing.**

Meanwhile Google is pushing to whatever channel was live at the moment of the
outage, which for any calendar re-registered inside the gap window is a channel
id the restored database has never heard of. `/api/google/push` looks the channel
up by id, finds no row, and drops the notification. Nothing errors. Nothing
pages. Calendar changes simply stop reaching Slate, and the only thing keeping
availability honest is the one-minute backstop sync, which is slower and
coarser than push.

The fix is to make every calendar read as due, then run the lane:

<!-- runbook-verified: 2026-09-02 (065e6dd7) rehearsal for #1584. The statement below was run against a Supabase preview branch carrying the identical schema (all 113 migrations applied), with its SET clause exactly as written here and a RETURNING appended so it reported the rows it touched. This is the claim the issue singled out as a deduction rather than an observation, and both directions were measured on three seeded calendars.

BEFORE: a calendar whose restored expiry sits 6 days out reported due_for_renewal = FALSE against the lane's own predicate (watch_expiration is null or watch_expiration - now() < interval '3 days', transcribed from src/lib/google/sync.ts:951-957). One at 1 day and one already lapsed reported TRUE. So the paragraph above is right: after a restore the lane really does read a healthy-looking expiry as current and do nothing.

AFTER: the statement below affected all 3 rows and every one reported due_for_renewal = TRUE. So the fix really does make them due.

The other half of the claim was confirmed by reading the live code path rather than by pushing a real notification: syncByChannel (src/lib/google/sync.ts:846-858) resolves the channel with .eq("watch_channel_id", channelId).maybeSingle() and returns "unknown-channel" when there is no row, and /api/google/push ignores that resolved value and answers 200 (only a THROWN error is logged). So an orphaned channel is dropped with no error and no alert, exactly as written.

What is still not proven here: running this across the LIVE roster, which would tear down production push channels. -->
```sql
-- Force every calendar to re-register its push channel on the next watch tick.
-- Safe: a null expiry reads as "due for renewal", and the renewal stops the old
-- channel first where it still has the ids to do so.
update agent_calendars
set watch_channel_id = null,
    watch_resource_id = null,
    watch_expiration = null,
    watch_consecutive_failures = 0,
    watch_last_error = null,
    watch_last_failure_kind = null;
```

Then trigger the watch lane rather than waiting up to five minutes for it:

<!-- runbook-unverified: running this with the CORRECT secret re-registers push channels across the live roster, which is an action on production rather than a check, so it stays for a real recovery. What the 2026-09-02 rehearsal (#1584) DID confirm is that the line is not wrong: GET https://slate.trypennie.app/api/cron/watch answers 401 with no bearer and 401 with a wrong one, so the URL is right, the route is deployed, and the Bearer CRON_SECRET it uses is really what the route wants. -->
```
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://slate.trypennie.app/api/cron/watch
```

Channels that the restore orphaned at Google (registered inside the gap window,
unknown to the restored database) cannot be stopped, because stopping one needs
the channel id and resource id that the restore discarded. They expire on their
own within about a week, and until then they push to an endpoint that ignores
them. That is noise, not a fault.

---

## 3. Rebuild the availability cache

`busy_blocks` is a **cache**, not a source of truth, which is the one piece of
good news on this page: it can be rebuilt from Google in full, and nothing has to
be reconciled by hand.

Two lanes do it, and they do different halves:

- **`/api/cron/hydrate-calendars`** re-bootstraps calendars over the whole cached
  window (21 days ahead). This is the one that matters after a restore, because
  the incremental delta from Google will not re-send events that have not changed
  since the restored sync token.
- **`/api/cron/sync`** is the every-minute backstop and will catch up on its own.

<!-- runbook-unverified: same as the watch lane above, running it for real is a live action against the roster. The 2026-09-02 rehearsal (#1584) confirmed the line itself: GET https://slate.trypennie.app/api/cron/hydrate-calendars answers 401 with no bearer, so the URL is right and the route is deployed behind the Bearer CRON_SECRET this uses. -->
```
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://slate.trypennie.app/api/cron/hydrate-calendars
```

The hydration lane deliberately refreshes a **slice** of the roster per tick, so
one call does not cover everybody. It reaches every calendar at least once a day
at any roster size; if you need the whole roster fresh sooner, call it repeatedly
and watch the log line for the slice it took.

Do not try to speed this up by deleting `busy_blocks` wholesale. An empty cache
reads as "everybody is free", and the booker will happily offer times that are
already taken until hydration catches up.

---

## 4. Find the bookings the restore threw away

This is the part with real customer consequence, and there is no automation for
it. Every booking confirmed inside the gap window is now:

- **gone from Postgres**, so Slate has no record of it, will not remind anybody,
  will not mark it complete, and will happily offer the same slot to somebody
  else;
- **still on the agent's Google calendar**, as a real event with the lead
  attached;
- **still in the lead's inbox**, as a calendar invite for a call they are
  expecting to happen.

So the customer's expectation is intact and Slate's record of it is not. The
agent's calendar is the surviving source of truth, and it is the one to
reconcile against.

**The order that matters:**

0. **Write the mirrored tables back from Snowflake first.** Every booking, booking
   event, outbox row, routing decision, webhook delivery and audit entry written
   since the restore point is in the warehouse, copied there within about ten
   minutes of being written. Dry run first, which reads both sides and writes
   nothing:

<!-- runbook-unverified: it reads the live warehouse and writes a live project, so it was not run while writing this page (2026-10-03, #3075), and the brief that built it forbade running it against production. Every rule it applies (the keyset paging, decoding Snowflake's text cells, never over a newer row, never over a redacted one, parents first, the write gate) is driven offline by scripts/test-snowflake-restore.ts. Unproven: the Snowflake read and the Supabase write against real systems. Rehearse it against a scratch project before it is needed. -->
```bash
RESTORE_POINT=2026-10-03T06:00:00Z pnpm restore:from-snowflake
RESTORE_POINT=2026-10-03T06:00:00Z APPLY=1 RESTORE_CONFIRM_HOST=drukfvgaynzrralbzkzj.supabase.co pnpm restore:from-snowflake
```

   Set `RESTORE_POINT` to the restore target from step 0 (a UTC time ending in Z), and
   `RESTORE_CONFIRM_HOST` to the host of the project being written to (the example is
   production's; after a 1b restore it is the new project's). It needs the Snowflake
   key (`SNOWFLAKE_PRIVATE_KEY`, `SNOWFLAKE_ACCOUNT`) in the shell, which only the
   Worker holds today. It never writes over a row Supabase holds a newer copy of
   (Slate is serving again, so a booking cancelled after the restore stays cancelled),
   never over a row Supabase holds redacted, and it prints the columns the mirror does
   not carry, which a restored row cannot get back: `reminder_sent_for` and
   `hour_reminder_sent_for` are the ones that matter, because a restored booking may be
   sent its 24 hour or 1 hour reminder email twice. Since #4298 the reminder lane also
   reads `booking_reminder_sends`, which is not mirrored either, so a restored booking
   has no record of ANY reminder email it was sent. It is safe to
   run again. What it cannot see: a booking written and then lost inside the last
   export interval (up to thirty minutes, or up to 90 if the export lane was stalled),
   which is what the rest of this list is for.

1. **Read the pre-restore snapshot you took in step 0.** That is the fastest and
   most complete list of what was lost: `bookings` rows created or modified
   inside the gap window. If for any reason there is no snapshot, fall back to
   listing Slate-created events on the agents' calendars inside the gap window.
2. **Decide per booking whether to recreate it.** Recreating through the normal
   booking path writes a new Postgres row AND a second Google event, so the
   original event has to be deleted first or the agent ends up double booked for
   one call.
3. **Leave the customer's invite alone unless you are changing the time.** They
   have a correct invite for a call that will happen; a cancellation followed by
   a new invite for the same slot is a worse experience than a silent repair.
4. **Cancellations and reschedules inside the gap window are the dangerous
   direction.** A booking cancelled inside the window is back in the restored
   database as `confirmed`, so Slate now believes in a call the lead has already
   been told is off. Those have to be re-cancelled by hand, and they are the ones
   to work first.

There is deliberately no script here. Writing one that had never been run against
a real restore would be worse than none, because it would read as proven while
being untested against the only situation it exists for.

---

## 5. Downstream systems Slate cannot roll back

**Regal has already been told.** Every `booking.created`, `booking.rescheduled`
and `booking.cancelled` webhook emitted inside the gap window was delivered and
acted on. There is no compensating event for "that booking no longer exists", and
inventing one is not something to do under pressure. Hand whoever owns Regal the
gap window and let them decide what to reconcile on their side.

**The Snowflake mirror is now ahead of the source.** The export walks each
mirrored table on a strictly forward keyset over `export_cursor`, and the restore
rolled that cursor backwards along with everything else. Two consequences:

- The export will re-send rows it has already sent. That is harmless: the load is
  a MERGE on `id` with no DELETE.
- Rows exported inside the gap window still exist in the warehouse and no longer
  exist in Supabase. The six-hourly reconcile lane counts both sides and **will
  page on the drift**, correctly. Expect that alert, do not treat it as a second
  incident, and clear it by removing the stranded warehouse rows once section 4
  is settled and you know which bookings are genuinely gone.

**Any completed PII erasure inside the gap window has been undone.** A restore
from before an erasure reintroduces the data it deleted. `docs/pii-erasure-runbook.md`
(section 6, Backups) states the obligation: re-run the erasure runbook for every
`pii.erasure` audit entry in the gap window. This is a legal commitment rather
than a tidiness one, so it is not optional and it is not deferrable.

The list comes from this query (#3132). **Run it BEFORE the restore, in step 0,
against the database as it stands, or afterwards against the snapshot step 0
took.** Never run it against the restored database: the restore removes the gap
window's audit rows along with everything else in it, so there it returns nothing,
which reads exactly like a window with no erasures in it. Replace
`RESTORE_TARGET_UTC` with the restore target written down in step 0, for example
`2026-10-03 06:00:00+00`; left unreplaced, it is refused as an unreadable timestamp
rather than run against the wrong window.

<!-- runbook-unverified: read only, and it reads only rows written by erase_booking_pii; it has not been run against production because there has been no restore to run it for. Its shape is pinned offline by scripts/test-dr-erasure-replay-sql.ts against the code that writes and reads these rows: the action literal erase_booking_pii inserts and the erasure audit lane filters on, the columns the lane selects, the two detail keys the trail carries, and that it holds no write. -->
```sql
-- Every erasure honoured inside the gap window. Read only.
select id,
       org_id,
       created_at,
       details ->> 'email_sha256' as email_sha256,
       details -> 'booking_ids' as booking_ids,
       jsonb_array_length(details -> 'booking_ids') as booking_count
from audit_log
where action = 'pii.erasure'
  and created_at >= timestamptz 'RESTORE_TARGET_UTC'
  and created_at <= now()
order by created_at;
```

For each row, the booking ids name the bookings the restore brought back with their
contact data. Read the attendee email off one of those restored bookings, check that
its SHA-256, taken over the address lowercased and trimmed exactly as
`erase_booking_pii` hashes it, matches `email_sha256`, and run the whole erasure runbook again for that email: the Supabase step,
the Snowflake purge, and the verify. Zero rows is a real answer only when the query ran
against the pre-restore database or the snapshot.

---

## 6. Verify

Work down this list. Each line is a different failure, and passing one says
nothing about the next.

<!-- runbook-verified: 2026-08-20 (7b71692a) run against production; /api/health returned 200 {"status":"ok","db":"ok","alerting":"ok"} and /api/health/availability returned 200. -->
```
# The app and the database.
curl -s https://slate.trypennie.app/api/health

# Availability specifically: 200 means the routing pool can still offer times,
# 503 means it cannot. This is the check the external uptime monitor watches.
curl -s -o /dev/null -w "%{http_code}\n" https://slate.trypennie.app/api/health/availability
```

Then, in order:

1. **Every cron lane is stamping again.** `/api/health` returns `status: "ok"`
   once no covered lane is stale. Give it fifteen minutes; the lanes on longer
   cadences take that long to prove themselves.
2. **Push is live again.** Change an event on one agent's calendar by hand and
   confirm the corresponding `busy_blocks` row moves within a minute or so. This
   is the only check that distinguishes a working push channel from the
   every-minute backstop quietly covering for a dead one, which is section 2's
   whole failure mode.
3. **A booking can actually be made.** Run the full smoke pass against the
   isolated SMOKE agents and buckets. It creates, reschedules and cancels a real
   booking end to end and is the only automated proof of the funnel.

<!-- runbook-unverified: the full strict smoke pass creates a real booking, so it is left to be run deliberately during a recovery rather than executed while writing this page. The invocation is the same one docs/smoke-test-runbook.md documents. -->
```
SMOKE_STRICT=1 node --experimental-strip-types --import ./scripts/register-paths.mjs \
  scripts/smoke-booking-api.ts
```

4. **The Snowflake reconcile drift alert has been dealt with**, per section 5,
   rather than muted.
5. **Nothing in section 4 is still outstanding.** A restore is not finished when
   the app is up; it is finished when Slate's record of the world matches the
   calendars and inboxes of the people in it.

---

## When Supabase or Google hangs rather than fails

Not a restore, and nothing here needs reconciling afterwards, but it is the
outage most likely to arrive first, so what Slate does in it is written down
(#3102). A dependency that refuses a request fails fast and every path already
handles that. One that accepts the request and never answers used to hold the
caller until something outside Slate gave up: a lead's confirm until the browser
aborted at 20 seconds, and a cron lane until its invocation ran out. Every call
now carries a deadline instead, enforced in one wrapper
(`src/lib/fetch-within-deadline.ts`).

**Per call.** Each request waits no longer than its own limit:

| Call | Deadline | Where it is set |
|---|---|---|
| Every Supabase request (the secret key client, the cookie client, the middleware's session refresh). The slowest statement measured on production is 7.9 seconds | 15 seconds | `SUPABASE_FETCH_TIMEOUT_MS`, `src/lib/supabase/fetch-deadline.ts` |
| Google calls a lead waits on: verify on book, the event insert, a lead's move, cancel or correction. One expiry for the call, token mint included | 8 seconds | `GOOGLE_CONFIRM_TIMEOUT_MS`, `src/lib/google/calendar.ts` |
| Google calls the sync lanes make: the event sync, the calendar list, push watches | 15 seconds | `GOOGLE_SYNC_TIMEOUT_MS`, same file |
| The OOO calendar writes a manager waits on | 8 seconds | `CALENDAR_WRITE_TIMEOUT_MS`, same file |
| The delegated token mint | shares the expiry of the calendar call it is minting for (the confirm path, the OOO writes, the reminder lane's invite read and rewrite, the sync lanes); 8 seconds for every Gmail send (the 24 hour reminder email and the OOO approvals digest), the photo lane, the smoke canary's event cleanup and the after response token refresh. Measured over seven full days in October 2026 and kept: no 8 second mint timed out (a lead's confirm minted for 3% of its token reads, slowest 338ms), and the sync lanes' 15 seconds saw one timeout in about 149,000 (#3298, #3980; the numbers and how to re-measure are on the constant) | `DELEGATED_TOKEN_TIMEOUT_MS`, `src/lib/google/dwd.ts` |
| Each Salesforce attempt | 10 seconds, three attempts | `SF_TIMEOUT_MS`, `src/lib/salesforce/retry.ts` |

A Google call can only be sent without one by writing `NO_DEADLINE` at the call
site, and today nothing does. `NO_DEADLINE` opts out of the per call limit only:
inside a request budget (below) such a call is still held to what the budget has
left, and refused once it is spent.

**Per request a lead is waiting on.** A per call limit bounds one call, and a
confirm makes a dozen Supabase reads and two or three Google calls in a row, so
those limits alone still add up past the booker's 20 seconds. So the three lead
facing booking routes (`/booking`, the key authed `POST /api/bookings`, and a
lead's reschedule) run under one budget (`src/lib/booking/confirm-budget.ts`,
carried through the async context by `src/lib/call-budget.ts`). Every Supabase,
Google and Salesforce call inside it waits for the smaller of its own limit and
what the budget has left, and once the budget is spent the next call fails at
once instead of starting.

| Part | Length |
|---|---|
| The confirm budget, for everything the request does | 12 seconds (`BOOKING_CONFIRM_BUDGET_MS`) |
| The cleanup allowance after it, for the whole failure path: handing back the lead's rate limit hit, recording the outcome, reporting the error and sending the page. One allowance per request, however many layers open it | 2 seconds (`BOOKING_CLEANUP_BUDGET_MS`) |
| Worst case, against the booker's 20 | 14 seconds, leaving 6 for computation and the response |

Work deferred past the response (webhook sends, recomputes) leaves the budget and
gets the per call limits again, because the lead already has their answer. The
cron lanes never run under a budget, so for them only the per call limits apply.

**What a lead sees.** A confirm, an API booking or a lead's reschedule whose
dependency times out answers **503** with the same sentence a verify outage
uses ("We hit a temporary issue confirming this time. Please try again in a
moment."), which the booker already shows, and the lead's rate limit hit is handed
back. It is counted as `verify_unavailable` and pages under
`verify_on_book_outage`, with the words naming which dependency did not answer.

**What can still happen after that 503.** If the timeout came after the booking's
reservation was written (the Google insert is the usual one), the reservation
stays pending and the reservation drain retries it on later ticks, never before
it is `RESERVATION_DRAIN_MIN_AGE_MS` old (twice the 14 second worst case, #3466), so
the drain never takes a reservation a live confirm is still completing. The event
insert carries a fixed client id, so a retry reuses an event that landed rather
than writing a second. So the lead can receive an invite even though the page
asked them to try again; the page does not say whether that happened, because
nothing knows at that moment, and points at `booking_reservations` instead. A retry that carries the same stable booking key
resumes that reservation rather than making a second booking; an anonymous retry
has no key to resume by, which is the existing posture for any confirm that
failed after its reservation was written.

**How long a reservation is kept.** The drain retries a failing reservation on a
backoff (1, 2, 4 minutes and so on, capped at an hour), pages
`reservation_drain_stuck` from its fifth failed attempt, and stops retrying at
`DRAIN_GIVE_UP_AT` (50 attempts, about 44 hours). A retention sweep on the same lane
deletes pending reservations older than a day, because each one holds the whole
attendee record. It deletes only those whose booking never committed. A reservation
whose booking DID commit (an active booking holds its idempotency key, the one booking
the drain's resume still sends `booking.created` for) while that send could not be made, most often
because the booked bucket no longer resolves (#3516), is the only record that Regal
was never told about that booking, so the sweep keeps it (#3847) and pages
`reservation_created_owed` once a day for as long as it stays. To resolve one: read
`booking_reservations.last_error`; restore the bucket and set the reservation's
`attempts` to 0 so the drain sends `booking.created` and deletes the reservation
itself, or tell Regal about the booking by hand and then delete the reservation. The
page clears on the first sweep that reads every candidate and finds none owed. A
sweep whose read fails measured nothing, so it neither pages nor clears: a page
already up stays up, and none is raised about owed bookings nobody counted. Its
error is logged under `tag=booking` ("expired-reservation cleanup failed"), and the
next tick tries again.

**A reservation whose booking was cancelled or completed is settled, never made
again** (#3847). When the drain resumes a reservation it looks for the newest
booking on its idempotency key in ANY status. It used to ask only about active
bookings, so a booking cancelled (or completed) after it committed read as never
made, and the drain made it again: a new calendar event for a call the lead had
called off, a new booking row and a `booking.created` to Regal. Now a cancelled or
completed booking made by that reservation (created after it) settles it: the
reservation is deleted, with no event, no booking and no webhook, and a
`reservation settled` line is logged under `tag=reservations`. A cancelled booking
OLDER than the reservation belongs to an earlier booking on the same key (a lead who
cancelled and then booked the same time again), so that reservation is a new create
and completes as one. A lead's own retry that finds such a reservation pending books
afresh. If the lookup cannot be read, the drain makes nothing and backs off like any
failed attempt.

**A budget miss.** When the budget runs out, the page names the call that was in
flight AND the budget that cut it short ("supabase was still running when the
booking confirm ran out of its 12 seconds"), so it says which dependency to look
at and that it was slow on top of others. A call refused because the budget was
already spent says so ("was not started, because the booking confirm had already
used its 12 seconds").

**What the lanes do.** A sync tick stops waiting on a hung calendar after 15
seconds and records an ordinary failed sync for it; the next tick tries again.
A hung Supabase read reaches the lane as an error rather than an empty result,
so a lane that `unwrap`s it fails loudly and its heartbeat goes stale, as for any
database outage. PostgREST does not retry a request that hit the deadline, so one
hung read costs one deadline, not four.

**Staff pages.** The middleware's session refresh gives up after 15 seconds and
the page renders as signed out, so staff are sent to sign in again rather than
facing a page that never loads.

**What the deadline does not cover.** It runs until the response headers arrive.
A response that starts and then stalls mid body is not cut by it; every call
here reads a small JSON body, so that has not been worth arming for.

---

## What would make the next one easier

Recorded here rather than in an issue nobody reads during an incident:

- **Point-in-Time Recovery** was priced and not bought on 2026-10-03 (see "On the
  RPO" above, with the volume at which to revisit it). The Snowflake mirror plus
  `pnpm restore:from-snowflake` is what does that job for bookings instead.
- **The pre-change dump in step 0**, taken every time, is what makes section 4
  tractable at all. Never skip it.
- **The daily dump is not encrypted on the runner, by decision** (Dan, 2026-10-03,
  #3076). R2 encrypts every object at rest and the bucket's token is scoped to that
  one bucket. A scheme added later goes between packaging and upload in the workflow,
  and section 1b then needs the matching decrypt.
- **The backup bucket is `slate-db-backups`, and its lifecycle rule expires each dump
  after 30 days** (set by Dan, 2026-10-03). Each dump holds customer contact data, so
  that rule is part of the retention story in `docs/pii-retention.md`, not just
  storage housekeeping.
- **A rehearsal of the RESTORE ITSELF.** Most of this page has now been
  exercised (2026-09-02, #1584): section 2's SQL was run verbatim against a
  branch with the identical schema and both directions were measured, the two
  cron lanes were confirmed deployed and correctly gated, and section 1's health
  check was run against production. What has still never happened here is a real
  restore, because there is nothing to restore INTO short of production: a
  Supabase preview branch is a fresh database with the migrations applied, not a
  backup restored into it. So section 1 and the live-roster halves of sections 2
  and 3 remain deductions. Buying that would mean a scratch project big enough to
  take a real backup, and it is worth deciding deliberately rather than
  discovering the answer mid-incident.
- **The rehearsal is worth repeating** whenever `dueForRenewal`, the watch
  columns, or the push channel lookup changes. What was measured was the
  BEHAVIOUR of those three, and a change to any of them makes this page a
  deduction again.
