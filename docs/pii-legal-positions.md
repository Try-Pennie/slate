# Slate consumer PII: positions for legal review

**Prepared for:** Pennie legal / outside counsel
**Prepared by:** Engineering (Slate), 2026-07-29
**Decided by:** Dan Wright, 2026-07-29, positions 1 to 4
**Proposed by:** Engineering (Slate), 2026-10-03, positions 5 and 6 (#3132), not yet decided by anyone
**Tracking:** #1074, milestone "PII retention, erasure & compliance" (#1029)

## What we need from you

Slate collects consumer contact information on a public web page and stores it.
Four compliance questions had to be answered before the retention and deletion
machinery could be called finished. Engineering could not answer them, so Dan
decided all four on 2026-07-29 and we built to those answers.

**This memo asks you to confirm or revise those four positions**, and two more that
engineering PROPOSED on 2026-10-03 (#3132) and nobody has decided: that the agent's
calendar copy of a booking stays, and what the reply to the person says about every
copy that remains, the Salesforce reference included. They are
Pennie's stated positions, not legal advice, and nothing here was reviewed by
counsel before it shipped. Two of them carry risks we want you to see explicitly
rather than discover later, and both are called out below.

Where a different answer would cost real engineering work, we say so, so you can
weigh the change rather than guess at it.

## Background: what Slate holds

Slate is Pennie's internal appointment booking system. A consumer arrives from a
Pennie landing page, picks a time, and is matched to an agent. Slate is not
consumer facing beyond that booking page.

What a consumer gives us, and where it lives:

| Data | Where it is stored | Notes |
|------|--------------------|-------|
| Name, email address, phone number | The booking record | Typed by the consumer on the public page |
| Any answers prefilled from the landing page | The booking record | Can carry contact details |
| Free text reason for a reschedule or cancellation | The booking history | Written by the consumer or an agent |
| A copy of all of the above | Outbound message records | One copy per message sent to a downstream system |
| Salesforce lead reference | The booking record | An identifier pointing at the consumer's record in Salesforce |

Three further copies exist outside the main database, and they matter to questions
3 and 4:

1. **The agent's work calendar.** The appointment appears as a calendar event on
   the assigned agent's Google Calendar, with the consumer's details on it.
2. **The data warehouse.** Everything is mirrored into Snowflake for reporting.
3. **Downstream systems.** Every booking is sent to Regal and Cadence, including
   the consumer's name, email, and phone.

## Position 1: which regimes apply

**Question.** Does CCPA apply to this data, and does GLBA impose a safeguards or
privacy obligation on it, given that Pennie is a lending marketplace?

**Pennie's position.** Both. We treat the data as subject to CCPA consumer rights
and to a GLBA safeguards posture, and where the two differ we build to the
stricter reading.

**Why.** It is the conservative choice, it avoids relying on the argument that
CCPA's exemption for GLBA regulated data covers this particular booking data, and
it costs little because the machinery was already close to it.

**What the system does.** A verified deletion request is honored on demand rather
than on a schedule, and we hold ourselves to a **45 day response deadline**. The
retention limits in position 2 are enforced automatically by scheduled jobs rather
than by anyone remembering.

**If you disagree.** Concluding that only GLBA applies would relax the response
deadline but change no code. We would keep the machinery and simply restate the
deadline.

## Position 2: how long we keep contact data

**Question.** What is the authoritative retention period for the contact details
on a completed or cancelled booking?

**Pennie's position.** **24 months**, measured from the appointment date, and the
same 24 months applies to the copy in the data warehouse.

**Why.** Long enough to cover show rate analysis and any complaint or dispute
window, short enough to be defensible as a real limit rather than indefinite
retention.

**What the system does.** Two daily jobs, one per copy of the data, because the
warehouse copy does not inherit the live database's cleanup and had to be given its
own. Each finds bookings whose appointment is more than 24 months old and blanks the
name, email, phone, and prefilled answers, keeping the appointment itself for
reporting. Both are keyed on the appointment date, not on a status flag that a
failed background job might leave unset, so a stale record cannot avoid the sweep.

Both jobs report failure rather than silence: anything either one cannot measure
(an unreadable read, an unreadable count, or data still present after the cleanup
ran) raises an alert rather than being recorded as "nothing to clean", and a job
that stops running at all is alerted on separately. That matters for this position
specifically, because a cleanup that quietly stopped and a cleanup with nothing to
do produce the same visible result.

Worth stating plainly, since it was true until 2026-08-31: the warehouse half was
described in this memo before it existed, and only the live database was actually
being cleaned. Both are enforced now.

Worth knowing: **nothing has aged out yet.** Slate's oldest bookings are from June
2026, so no consumer data has reached 24 months and the job currently has nothing
to delete. The limit is real but untested by volume.

**If you disagree.** Any other number is a one line change plus a documentation
update. Shortening it is cheap now precisely because there is no backlog.

## Position 3: what deletion means

**Question.** When a consumer asks us to delete their data, must the record be
physically deleted, or is blanking the personal fields sufficient?

**Pennie's position.** Blanking the personal fields (redaction) is sufficient. The
booking record itself survives with no contact data on it. The Salesforce lead
reference stays.

**Why.** The appointment record is needed for reporting and internal integrity, and
Salesforce, not Slate, is the system of record for the consumer's identity, so
deleting the underlying person is Salesforce's responsibility.

**What the system does.** An operator runs one database command. In a single
transaction it blanks the name, email, phone, and prefilled answers, removes the
free text reschedule and cancellation reasons, blanks the stored copies of every
outbound message, and writes a permanent audit entry recording that the request was
honored. The audit entry stores a one way cryptographic hash of the email address,
never the address itself, so the record of the deletion does not itself retain the
data. Re-running it for the same person does nothing and creates no second entry.

This was tested end to end against the live system on 2026-07-29 using a synthetic
test booking, and it behaved exactly as described.

**Accepted risk we want you to see.** Because the Salesforce reference stays, a
deleted booking still holds an identifier that points at the consumer's record in
another system. Someone with access to both systems could re-identify the person
from the record we said we erased. Pennie's position is that this reference is
Salesforce's obligation rather than Slate's. If you read it instead as personal
information that must go, clearing it is a small change, at the cost of losing the
ability to trace that booking back to its lead.

**If you require physical deletion.** This is the expensive answer. The database is
deliberately built so that booking records cannot be deleted: the appointment
history is append only for tamper evidence reasons, and other records reference the
booking in ways that block deletion outright. Honoring physical deletion would mean
unwinding both of those protections and losing the booking from reporting.

## Position 4: the downstream copies

**Question.** Does sending consumer contact details to Regal and Cadence create a
separate processor obligation, requiring a data processing agreement or requiring
us to pass deletion requests along to them?

**Pennie's position.** No. Regal and Cadence are treated as downstream controllers
with their own relationship to the consumer. Slate's obligation ends at Slate's own
store.

**Why.** Those systems own their own consumer relationships and retention, and
neither offers a deletion endpoint Slate could call today, so any automatic
propagation Slate built would be a signal nothing receives.

**Accepted risk we want you to see, and the one most exposed to challenge.** Slate
sends the consumer's name, email, and phone to Regal and Cadence on every single
booking. When Pennie honors a deletion request, Slate blanks its own copies and
**tells Regal and Cadence nothing**. Their copies remain, and no one is notified.
So a consumer told by Pennie that their data has been deleted still has it held by
two downstream systems.

This sits directly against position 1: we have adopted the stricter reading of the
consumer's rights while limiting the deletion to one system in the chain. If you
read position 1 as binding on the whole data flow rather than on Slate's own
database, this position has to change.

**If you disagree,** there are two levels. The cheap version is a documented manual
step: the operator handling a deletion request also asks Regal and Cadence to
delete, and the audit entry records that it was done. The expensive version is
automatic propagation, which needs those vendors to build an endpoint that accepts
a deletion signal before Slate has anything to call.

## Two residuals the positions above do not cover

Engineering proposed on 2026-10-03 (#3132) that both be told to the person who asked
for deletion, in the reply drafted in `docs/pii-erasure-runbook.md` ("Answering the
requester"), and put them on the sign-off table below as positions 5 and 6 so that
reply rests on something counsel has seen. Neither is a decision until it is signed
off.


1. **Backups.** Deletion is immediate in the live database and the warehouse, but
   both keep backups for their own retention windows, and a restore from before a
   deletion would bring the data back. Our written procedure requires re-running
   every recorded deletion after any restore. The defensible statement is that
   erasure is complete in production immediately and in backups once they roll off.
2. **The agent's calendar.** A past appointment stays on the agent's Google Calendar
   with the consumer's details on it, and neither retention nor deletion removes it,
   on the reasoning that it is the agent's own record of a meeting that happened.
   Only a genuine cancellation removes a calendar event. If that copy needs to be in
   scope, tell us and we will treat it as a separate piece of work.

## Sign-off

| Position | Confirm as written | Needs revision | Notes |
|----------|--------------------|----------------|-------|
| 1. CCPA and GLBA both apply, stricter reading, 45 day deadline | | | |
| 2. 24 month retention, warehouse included | | | |
| 3. Redaction is deletion, Salesforce reference stays | | | |
| 4. No processor obligation for Regal and Cadence | | | |
| 5. The agent's calendar copy of a booking is not erased (residual 2 above) (proposed by engineering, 2026-10-03, not yet decided) | | | |
| 6. The reply to the requester names everything that remains: backups, the agent's calendar, the Regal and Cadence copies, and the Salesforce reference of position 3 (`docs/pii-erasure-runbook.md`, "Answering the requester") (proposed by engineering, 2026-10-03, not yet decided) | | | |

Reviewed by: ____________________  Date: ____________

Engineering detail behind every statement here, including the exact fields touched
and the operator procedure, is in [pii-retention.md](./pii-retention.md) and
[pii-erasure-runbook.md](./pii-erasure-runbook.md).
