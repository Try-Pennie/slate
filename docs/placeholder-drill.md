# The placeholder booking drill (#4206)

One live run, before coordinators start, of the path a scheduling coordinator takes when
no advisor is free: the coordinator page books the call on the placeholder advisor
(Marcia), the invite goes out from the placeholder's seat, and the call can be moved onto
a real advisor and cancelled. It runs on production, because Slate has no staging, so
every booking in it is a `PARTNER` booking (`docs/smoke-test-runbook.md`, "A test by hand
books `PARTNER`").

## What it proves, and what it cannot

It proves Slate's side: the coordinator sign in and role gate, the customer lookup, the
fall to the placeholder when nobody is free, the booking's kind (`staff_placed`), the
placeholder's invite and reminder, the move off the placeholder, the cancel, and that no
alert fires for a test booking.

It cannot prove Regal's side. A booking on an `is_test` bucket never reaches Regal: the
delivery is recorded as suppressed and never posted (`SUPPRESSED_RESPONSE` in
`src/lib/webhooks/emit.ts`, #459). So no journey runs for it and the Regal contact never
gets `slateGhostBooking` or `ai_agent_eligible`. Regal's side is proven by the first real
coordinator calls after go live, or before that only by a sample event sent to a test
contact through Regal's Custom Events API, which is an open question on the Regal edits
page (#4204).

## The accounts

| Account | Slate row | Why |
|---|---|---|
| `smoketest3@trypennie.com` | the test placeholder: `is_placeholder`, `is_test`, never bookable | the `PARTNER` world's own placeholder (one per org and `is_test`, migration 0207). Its invite goes out from this seat. |
| `smoketest4@trypennie.com` | a coordinator with `is_test` set | a coordinator whose row is `is_test` always books `PARTNER`, whatever the Lead's score (#4205), so a drill can never land on a real bucket |
| `smoketest@trypennie.com` | the `PARTNER` bucket's only advisor | already exists; the drill blocks one hour of its calendar so nobody is free |

`smoketest@` and `smoketest2@` cannot serve as the placeholder or the coordinator: the
smoke canary and the daily reroute drill book on them, and neither a placeholder nor a
coordinator may be bookable. The seat monitors leave an `is_test` placeholder out
(`src/lib/monitor/placeholder-seat-store.ts`), and the unserved call alert reads only
real buckets (`src/lib/monitor/placeholder-calls.ts`), so nothing pages about the drill.

The customer is the Lead "Dan Slatetest" (`00QUl00000JtyVGMAZ`), whose email and phone
are Dan's. Its Regal owner is a real advisor, which is safe here only because a `PARTNER`
booking sends Regal nothing; never book it on a real bucket.

## Before the drill

1. The coordinator page (#4205) is live, with the `is_test` coordinator rule.
2. The test placeholder row exists for `smoketest3@` (inserted through `/db-apply`, with
   its count reported).
3. `smoketest4@` has coordinator access (Team access), and its row is `is_test`.
4. "Let coordinators book on Marcia" is on, on `/admin/coordinator-booking`. While no
   real coordinator exists this changes nothing for anyone else. If real coordinators
   already exist, turn it on only for the length of the drill.

## The drill

`smoketest@` is shared with the smoke canary and the daily reroute drill, which take a
lease over it while they book (`docs/smoke-test-runbook.md`, "The full pass shares its two
test advisors"). This drill takes no lease, so run it away from them: never between 10:30
and 12:00 UTC, the window the daily reroute drill (scheduled 10:50 UTC, often late) uses,
and start just after a canary tick at :00 or :30. If the canary fails during the run, read
its report before blaming the drill.

1. On `smoketest@`'s Google calendar, add a busy event over one hour in the next day the
   booker offers, inside the customer's calling window.
2. Sign in as `smoketest4@`, open `/coordinator`, and paste the Lead id.
3. Confirm the zone, pick that day and a time inside the busy hour, tick the notice and
   confirm. The page books it on Marcia.
4. Check, on `/admin/bookings`: the booking is on the test placeholder, kind
   `staff_placed`, bucket `PARTNER`. The invite reaches Dan's inbox from `smoketest3@`
   and names no text number. Its webhook deliveries read "suppressed: is_test bucket".
   No alert posts.
5. Move it to a time `smoketest@` is free. It lands on `smoketest@`, kind routed, and the
   placeholder's calendar event is gone.
6. Book a second call on Marcia the same way, then cancel it. The booking reads cancelled
   and both calendars are clear.
7. Delete the busy event, and turn the switch off again unless coordinators start that
   day.

Record the run (date, booking ids, what each step showed) as a comment on #4206.
