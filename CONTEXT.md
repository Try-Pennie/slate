# Slate

Cal.com-style booking router for Pennie: routes landing-page bookings to a
round-robin pool of agents, syncs Google Calendar, and emits webhooks to
downstream systems. This glossary is the project's ubiquitous language — the
canonical term for each concept and the words we deliberately avoid.

## People

**User**:
The single entity for a person in the system (one row in `users`). Everyone — a
bookable rep, an admin, a manager — is a User. There is no separate "Agent"
entity; "Agent" below is a *facet* a User can play, not a type.
_Avoid_: person, account, member (as a synonym for the person)

**Agent**:
A facet of a User: any **bookable, non-deactivated** User who is eligible to
receive bookings, *regardless of role*. Defined by bookability, not by the
`role: "agent"` value — a manager who still takes calls is an Agent for routing
purposes. Routing, availability, and round-robin all key off this facet.
_Avoid_: resource, rep, team member

## Agent lifecycle & availability

Three states gate whether an Agent receives bookings. Off-shift and Deactivated
are orthogonal; deactivation always wins.

**Off-shift** (vs. on-shift):
The reversible, day-to-day availability toggle (`bookable`) a manager flips. The
person still works here; they are simply not taking bookings right now. Use this
for any temporary same-day pull-out (covering, breaks).
_Avoid_: inactive, disabled, enabled/disabled

**Deactivated** (vs. Active):
The offboarding lifecycle state (`deactivated_at`). The person has left or is
suspended; intended as permanent. A soft-delete — history is retained and the
User disappears from the roster, sync loop, manager picker, and pool.
**Reactivation** is a real, supported path: a rehire (e.g., someone who left and
returns a year later) is reactivated, not recreated. Never used for vacation or
known-return absences — those are Time-off.
_Avoid_: deleted, disabled, inactive (collides with off-shift)

**Time-off (OOO)**:
A period an Agent is unavailable with a known return (vacation, PTO, a callout) —
distinct from Off-shift (a same-day toggle) and Deactivated (offboarding). Slate
owns this. An approved Time-off writes Busy Blocks so the Agent isn't booked while
out.
_Avoid_: leave, absence, holiday

## Routing

**Bucket**:
A configured routing rule (one row in `buckets`): a set of matching `criteria`,
manual members, and a fallback agent. Every Bucket corresponds 1:1 to exactly one
XBC code — no buckets exist outside the 60-cell matrix, and no code maps to more
than one Bucket.
_Avoid_: debt bucket, queue

**Bucket Code (XBC)**:
The 3-digit public identifier for a Bucket (`411`, `521`), used in landing-page
URLs and embed params. Decodes to criteria along three axes: debt tier (digit 1),
backend service (digit 2), legal (digit 3). 5 × 4 × 3 = 60 possible codes.
_Avoid_: using "bucket" to mean the code

**Pool**:
The **derived**, point-in-time set of Agents eligible for a Bucket — criteria
matches plus manual members, or the fallback agent when that set is empty. Always
computed at request time from agent attributes; never stored.
_Avoid_: debt bucket, roster (roster = the whole company's agents, not a Bucket's)

**Criteria**:
A Bucket's attribute filter. AND across keys; OR within a key (scalar or array on
either side). A key ending in `!` negates (the Agent must NOT hold those values;
an unset attribute passes the negation).
_Avoid_: filter, rules (rules means working-hours rules elsewhere)

**Fair assignment (round-robin)**:
How a Booking is assigned within a Pool. **Fair = equal share of that Bucket's
leads, counted per bucket.** Among the agents free for the slot, the one with the
**fewest bookings in this Bucket** wins (ties broken by least-recently-booked, then
id; pointer-free for concurrency safety). Each Bucket is **independent** — a
multi-tier Agent's bookings in other Buckets never affect their standing here (e.g.
an Agent with 10 High + 0 Ultra-High bookings outranks one with 1 High + 2
Ultra-High for an incoming Ultra-High lead). Cross-tier differences in lead volume
are *not* a routing concern — they are a comp-plan / staffing matter.
_Avoid_: load-balancing across buckets, global rotation; "fair" meaning equal total
workload (it means equal share within each Bucket)

## Booking

**Booking** (a.k.a. Appointment):
A single appointment with a **stable identity that survives reschedules** — one
row, never split into two. "Appointment" is the customer-facing synonym; Booking
is canonical (matches the table, types, and webhooks). The durable thing the
show-rate metric is measured against.
_Avoid_: meeting, event (event = a Google or webhook event), treating a moved
booking as a new record

**Active** vs. **Terminal**:
The two lifecycle groups. **Active** = `confirmed` ∪ `rescheduled` — a live,
upcoming Booking that occupies the Agent's time and counts in round-robin.
**Terminal** = `cancelled` ∪ `completed`. `rescheduled` ≡ active-and-moved and
behaves identically to `confirmed`; `completed` is set by cron once the end time
passes (it means "time elapsed," NOT "the attendee showed up").
_Avoid_: calling `rescheduled` a distinct lifecycle stage

**Reschedule**:
Moving a Booking to a new time. The Booking keeps its identity; the move is an
**immutable history event** (from-time, to-time, who initiated, why, when, and the
new Agent if it changed) and the original scheduled time is preserved. Fires
`booking.rescheduled` — never cancel + recreate (see ADR 0001). **Agent policy:**
keep the original Agent if free at the new time, else re-route via the Bucket's
round-robin.
_Avoid_: cancel-and-rebook, rebooking

## Time

**Slot**:
A single offered booking **start time** (an instant, e.g. `…T14:00:00Z`) — one of
the pickable times the booker shows. The meeting's length comes from the Event
Type, so the full window is derivable; a Slot is the start, not the window.
(Note for cal.com/Calendly readers: there "slot" often means the whole window —
here it means only the start.)
_Avoid_: using "slot" for the window, or for a `busy_blocks` row

**Busy Block**:
The system's single occupancy primitive — one `[start, end)` interval marking an
Agent unavailable (one row in `busy_blocks`). Tagged by `source`: **slate**
(written directly by Slate — bookings and approved time-off) or **gcal** (synced
from a Google Calendar event, carrying its `gcal_event_id`). Everything that takes
an Agent's time becomes a Busy Block.
_Avoid_: blocked time, event (event = a Google or webhook event)

**Interval**:
A bare `{ start, end }` time range with no further meaning — the generic shape.
Named ranges get their own terms (booking window, working window).
_Avoid_: window (reserve "window" for named ranges)

## Attendance — two different concepts, kept apart

The word "attendance" means different things in Slate vs. PET (the Project
Enrollment Tracker, a separate Pennie tool). Do not blur them.

**Rep Attendance** (a PET concept, *not* Slate's):
Whether the **Agent/rep was present or out** (callout, PTO/OOO) — the input to
PET's Reliability/attendance score. **Slate is the upstream source:** Slate feeds
PET the Agent's Time-off/OOO so PET can compute this. Slate does **not** push
customer show-rate to PET.
_Avoid_: using "attendance" in Slate to mean a customer showing up

**Show / No-show** (customer concept):
Whether the **booked customer attended** their appointment at the scheduled time —
the basis of the show-rate goal. A *different funnel stage* from Rep Attendance and
from enrollment. Slate cannot witness this itself (the call happens elsewhere).
**Where show-rate is computed is UNDECIDED** (warehouse/Salesforce join vs. Slate
ingesting a signal) — open question, not yet modeled.
_Avoid_: "attendance" (collides with the PET rep concept)
