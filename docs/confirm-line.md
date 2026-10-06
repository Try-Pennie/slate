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

## The key

A line key is a GROUP and an instant. One object per group, one line per instant
inside it, because creating an object costs about 170ms and calling an existing one
about 13ms (measured below): an object per instant would create one on almost every
booking. The group is:

- `link:<userId>` for a named advisor's link, whatever code it came through;
- `ladder:<fingerprint>` when this isolate knows the pool of every rung of the code's
  fallback ladder (`src/lib/booking/line-key.ts`). A leader's "full" verdict means
  nobody in any rung of ITS ladder was free, so it may settle only followers that
  would walk the same pools at every rung. Today 510, 511, 500 and 501 share one;
  a bucket that gains a hand named member splits off by itself (Dan, 2026-10-05);
- `code:<code>` otherwise, which is what a cold isolate uses. The pool grouping is
  read without waiting (`peekPoolKey` in `slot-cache.ts`) and warmed after the
  response when unknown, so a confirm never adds a read before its line.

Accepted, and stated: for up to one minute after an admin edits a bucket's members,
an isolate holding the old grouping can put two codes whose ladders now differ in
one line, so a follower can be told "taken" while the edited bucket's new member is
free. The lead picks another time; nothing is double booked.

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
isolate lines leave dozens told to retry, one shared line answers the whole crowd),
`test-unawaited-line-calls.ts` (no unawaited line call), `test-confirm-line-binding.ts`
(bound, created and exported in production and the load test, and the deployed class
logging a traced call).

Against production, `pnpm verify:confirm-line` (#3340) runs daily in
`burst-counter.yml` and stamps `verdict:confirm-line`: the confirm path's own client
against the live object, a follower refused after a full verdict, handed the lead
after a not full one, freed behind an unacknowledged lead, and nothing left held. It
cannot prove two isolates share one object; only the load run can. Exit codes and
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
