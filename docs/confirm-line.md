# The confirm line, shared across isolates (#3325)

## What it is for

Confirms for one time slot take turns (#3221, #3257, #3274): the first leads and
runs the whole confirm, the rest wait, and when the leader's verdict shows the slot
is full everybody waiting is answered "taken" without doing any work. Until #3325
that line lived in each isolate's memory, so it only coordinated confirms that
landed on the same isolate. In load run 37333201026 (2026-10-05) a hundred confirms
for one slot spread across many isolates, each formed its own line, about 52 leaders
ran the full path together, the database saturated, and nobody was booked.

The shared line is the same rules, hosted in ONE Durable Object that every isolate
reaches as the same instance. Correctness never rests on it: the bookings indexes
and verify on book still decide who gets a slot. The line is capacity and fairness,
so a crowd gets one booking per free advisor and fast "taken" answers.

## Where the code is

| piece | file |
|---|---|
| the line's rules, the only implementation | `src/lib/booking/confirm-queue.ts` (`makeConfirmQueue`) |
| the async interface the confirm path uses, and the per isolate adapter | same file (`ConfirmLine`, `isolateLine`) |
| the protocol the object runs | `src/lib/booking/confirm-line-object.ts` |
| the object itself (a shell) | `worker/confirm-line.ts`, exported from `worker/index.ts` |
| the confirm path's client, every fallback named | `src/lib/booking/shared-confirm-line.ts` |
| the wiring to the runtime | `src/lib/booking/confirm-line-live.ts` |
| what pages, and what only logs | `src/lib/booking/confirm-line-alert.ts` |
| the switch | `src/lib/booking/shared-line-switch*.ts`, `booking_settings.shared_confirm_line` |
| the pool grouping snapshot, its directory and its reader (#3460) | `src/lib/booking/pool-grouping.ts` |
| publishing it, wired to the binding | `src/lib/booking/pool-grouping-live.ts`, `src/app/api/cron/recompute/route.ts` |

## The key

A line key is a GROUP and an instant. One object per group, one line per instant
inside it, because creating an object costs about 170ms and calling an existing one
about 13ms (measured below): an object per instant would create one on almost every
booking. The group is:

- `link:<userId>` for a named advisor's link, whatever code it came through;
- `ladder:<fingerprint>` when this server holds a fresh grouping of every rung of the
  code's fallback ladder into its pool (`src/lib/booking/line-key.ts`). A leader's
  "full" verdict means nobody in any rung of ITS ladder was free, so it may settle
  only followers that would walk the same pools at every rung. Today 510, 511, 500
  and 501 share one; a bucket that gains a hand named member splits off by itself
  (Dan, 2026-10-05);
- `code:<code>` otherwise: a server holding no fresh grouping, or one whose grouping
  does not list the confirm's own code (a grouping read before the bucket existed,
  or a partial one, whose gaps cannot be trusted, #3460).

**Where the grouping comes from, and the invariant #3460 retired.** #3325 shipped "a
confirm never adds a read before its line": the grouping was looked at without
waiting (`peekPoolKey` in `slot-cache.ts`) and warmed after the response. Load run
37566700055 showed what that costs: most of each burst ran on servers holding
nothing, so a hundred confirms on 120 and 121 split across a `ladder:` line and both
codes' own lines, three leaders, and one slow losing leader timed out 41 followers.
#3355 (items 1 and 2, which #3460 supersedes) had already decided a confirm may WAIT,
within a short bound, for the grouping before its key. So it now does: see "The pool
grouping snapshot" below. `lineGroupOf` stays synchronous; the wait happens before
the orchestration builds the key, never inside it.

Accepted, and stated: for up to one minute after an admin edits a bucket's members,
a server holding the old grouping can put two codes whose ladders now differ in
one line, so a follower can be told "taken" while the edited bucket's new member is
free. The lead picks another time; nothing is double booked. The snapshot extends
nothing here: it is installed under the time its read STARTED, so a snapshot and a
local read of the same age expire at the same moment.

## The pool grouping snapshot (#3460)

The every minute recompute lane already reads the bucket list. It groups it by pool
and publishes `[code, pool digest]` for every code, with the time the read started,
to the **directory**: a reserved instance of this same class, named
`directory:pool-grouping:v<format>` (no new class, binding or migration). The directory
keeps its snapshot in the instance's own storage, not only its memory (#3479): the
platform hibernates an idle object with no timers after ten seconds and discards its
memory, so a memory only directory was empty for most of every minute, and load run
37601024392's bursts, each arriving about 48 seconds after the last publish, read
nothing. A put writes storage before it answers `stored`, a failed write is refused (so
the heartbeat below is not stamped), and a failed read is refused rather than answered
as an empty directory. It publishes
BEFORE taking its lock, because a tick that finds the lock held is skipped, and it
adds no read: the same list feeds the recompute. Any server's own read publishes too,
after the response, as a backup. A publish that landed stamps the `pool-grouping`
heartbeat, watched by `POOL_GROUPING_STALE_BOUNDS_MS` (Slack only, ten minutes), so a
publisher that stops is paged rather than every cold server quietly keying by code.

A confirm starts fetching the snapshot, alongside the shared line switch read (#3355
item 1), after the booking API's key authenticates (inside the authorizer, before its
ceilings) or after the booker's address passes its edge limiter. A bad key, or an
address past its minute, starts neither (L498). It waits for it in the service, before
the orchestration builds the key, at most `POOL_GROUPING_FETCH_MS` (500ms: #3325
measured a new object's first call at p95 323ms and worst 452ms), counted from that
point and not from when the fetch started, so the ceilings and the body read in between
overlap the fetch without spending the bound. One fetch per server
however many confirms ask, and a fetch older than the bound is never joined, because a
fetch started by a request that has since ended can be left pending for ever. A fetch a
request starts is kept alive past its response, so a confirm that joined it is never
stranded.

**What a caller over its ceiling can cause, stated.** Both reads start before the per
key and per address hourly ceilings answer, so a good key that those ceilings then
refuse with a 429 has started them too. That is bounded per server and never per
request: the switch is read at most once per server per 15 seconds (once per 5 while
the read is failing), coalesced; the snapshot is not fetched at all while the server
holds a fresh grouping, is fetched once however many ask, and is not fetched again for
`POOL_GROUPING_RETRY_MS` (one second) after a fetch that installed nothing. So a flood
of over ceiling requests costs each server about one switch read every 5 seconds and
two directory calls a second at most, what the same number of real confirms would
cost, and nothing more for each request it sends. `startConfirmPrelude` carries the
same statement beside the code, and the bookings route's tests send a burst of refused
requests to a cold server and count both.

Every refusal leaves the confirm on its code's own line, which is today's behaviour,
and over grouping is the one failure this must not have:

| what the directory answers | what the server does | `line_group_source` |
|---|---|---|
| a fresh snapshot, newer than what the server holds | installs it under its own read time | `snapshot` |
| nothing needed: the server already holds a fresh grouping | fetches nothing | `local` (or `snapshot` if that is where it came from) |
| a snapshot older than one minute | installs nothing | `stale` |
| no snapshot (a new instance before the next publish) | installs nothing | `absent` |
| an empty or partial snapshot, a malformed one, or an older object's refusal | installs nothing | `refused` |
| a snapshot of another format | installs nothing | `format-mismatch` |
| no answer within the bound | keys by code; an answer inside the fetch's own 2s give up still installs, for the next confirm | `timeout` |
| the call failed | installs nothing | `unreachable` |
| no binding (off the runtime) | fetches nothing | `unbound` |
| nothing: a fetch on this server installed nothing less than a second ago | fetches nothing, keys by code | `backoff` |
| a grouping that does not list the confirm's own code | keys by code | `own-code-missing` |

Two guards keep the snapshot from ever grouping differently from a local read:
**both routes derive their entries in one place** (`groupingEntriesOf`), and
`scripts/test-pool-grouping-reader.ts` builds the same ladder key both ways for all
sixty codes of a realistic roster, through the real object, reader, store and JSON. And
because deploys are gradual, so one build may install what another published, the
**format** is in the directory's name and the snapshot, and
`scripts/test-pool-grouping.ts` pins the derivation's sources and a fixture's digests
under each format, so changing the pool key, `listPoolBuckets`, the
ladder or the digest fails until the format is bumped.

**The gap, stated (L614).** The lane stamps a snapshot with its read's START, and a
server accepts it for one minute from then, the same minute a local read has. So in
each minute there is a short gap, between one snapshot expiring and the next landing
(cron lateness, the read, the put), in which a cold server meets a stale snapshot and
keys by code, said as `stale`. Widening the window to close it would extend the
staleness accepted above; it was left as is and is measured instead.

Every confirm's `confirm answered` line carries `line_group_source`, its own wait for
the fetch (counted from its line key, so a fetch that answered during the ceilings reads
0) as `grouping_fetch_ms` and the snapshot's age as `grouping_age_ms`, and the load run's
burst breakdown reports, per burst, how many line keys came from the snapshot and why
the rest did not, with the spread of the wait.

## The switch, and which way everything fails

`booking_settings.shared_confirm_line`, on the admin Hours page, read once per
isolate per 15 seconds. A failed read is never cached as the answer: an isolate with
no good read uses the deployment default `SHARED_CONFIRM_LINE_DEFAULT` (on in the
load test Worker, off in production until activation).

Every confirm records how it was served, on its `confirm answered` log line:
`line` (`shared`, `isolate`, `fallback`), `line_reason`, `line_key` and `line_ms`
(the time the line added, waiting excluded).

| what happened | what the confirm does | `line` / `line_reason` | pages? |
|---|---|---|---|
| switch off | its isolate's line, as before | `isolate` / `off` (`unread-default` when it fell back to the default) | no |
| switch on, no binding | its isolate's line | `fallback` / `unbound` | after 3 in a minute on one isolate |
| `enter` refused or not answered in 1.5s | its isolate's line, and abandons the attempt | `fallback` / `reach-timeout`, `enter-error` | same |
| a deploy replaced the object | re-enters the new instance | `shared` / `gone` | never |
| a leader's call fails mid turn | carries on; the insert decides | unchanged | no |

## Timings, and why

A new lead must acknowledge within 1s and renew within 4s (every leader call, plus
a heartbeat every 1.5s), so an abandoned leader frees the line well inside a
follower's 10s wait. Followers poll in 1.5s long polls, so a deploy, which leaves
calls already held on the old instance until their own timeout, strands a follower
for at most one poll. The relations are pinned by `scripts/test-confirm-line-object.ts`.

The lead SENDS its ack at once and does not wait for the answer (#3355): nothing the
confirm does depends on it, since a `gone` only marks the turn detached, which every
later call checks. Waiting on it put a line object's round trip in front of every
confirm, 1.3s on an object fresh from a deploy (load run 37572839375). Nothing waits
on the ack at all, neither the confirm's start nor its report, and it is not counted
in `line_ms`.

## Traced calls (load test only, #3354)

Under SLATE_LOADTEST the route mints a trace for each confirm, and the client adds
it to every message with the stage it was sent in: `wait` until `enter` hands back a
turn, `turn` after. The object logs each traced call (`tag=confirm-line-object
msg="line call"`, with the op, trace and stage) and the runtime records the call's
`wallTime` on the same event, so the load run joins the object's side of a confirm to
the confirm's own `confirm answered` line (`line_trace`). Production confirms carry
no trace, so the object logs nothing for them. Nothing in the protocol depends on it:
an object that ignored both fields would answer every call the same.

## Tests

`test-confirm-queue.ts` (the rules), `test-confirm-line-object.ts` (the protocol,
every lost, late, repeated or outlived message), `test-shared-confirm-line.ts` (the
client against the real host through a transport that can fail each message, or
swap the host for a deploy), `test-confirm-contention.ts` (fifty isolates: per
isolate lines leave dozens told to retry, one shared line answers the whole crowd;
and #3460's burst on sibling codes across warm, cold and stale servers, which elects
three leaders keyed as main keys it and one once every server fetches the snapshot),
`test-pool-grouping.ts` (the snapshot, every refusal, the directory through the real
object, and the format pin), `test-pool-grouping-reader.ts` (the server's grouping,
newest wins, the reader's bound counted from the line key, coalescing and backoff, and
the same key both ways for sixty codes), `test-unawaited-line-calls.ts` (no unawaited line call),
`test-confirm-line-binding.ts` (bound, created and exported in production and the load
test, the deployed class logging a traced call, and serving the directory only on its
own path and, when the runtime names it, its own instance).

Against production, `pnpm verify:confirm-line` (#3340) runs daily in
`burst-counter.yml` and stamps `verdict:confirm-line`: the confirm path's own client
against the live object, a follower refused after a full verdict, handed the lead
after a not full one, freed behind an unacknowledged lead, and nothing left held; and
(#3460) the pool grouping directory storing a put, keeping the newest over an older
one, and holding a live grouping a cold server would install. It writes only its own
verification directory and only reads the live one. It cannot prove two isolates
share one object; only the load run can. Exit codes and
decisions: `docs/verify-commands.md`.

## Measured before it was built (2026-10-05)

A throwaway Worker, deleted after, timed calls from inside an invocation:

| call | p50 | p95 |
|---|---|---|
| first call to a new object, same region | 171ms | 266ms |
| call to a warm object, same region | 11ms | 19ms |
| first call to a new object, cross country | 215ms | 323ms |
| call to a warm object, cross country | 53ms | 59ms |

An existing object re-woken after 90 to 180 seconds idle answered in about 55ms.
100 held calls on one object were all released by one call with no lag. A deploy
left 30 held calls on the old instance until their own 45s timeout while new calls
reached the new version about 6 seconds in. Full figures are on #3325.
