# Twilio is the source of truth for routing facts

When Salesforce and Twilio TaskRouter disagree about a fact that decides which pool
an agent is in (debt tiers, backend service, legal eligibility, Redistribute),
Twilio is right. The hourly roster sync reads those facts from each Twilio worker's
`teams` tags and writes them onto `users.attributes`. Salesforce keeps the facts
Twilio does not carry: the profile, and the manager of record.

## Status

Accepted. Decided by Dan on 2026-09-09 (#2148), put into the sync on 2026-09-10
(#2152, commit `25d45d43`). Backfilled as a record in #3130, because the decision
lived in an issue comment, `AGENTS.md` and a memory, and nowhere a reader of the
routing code would look.

## The decision, as it was made

#2148 listed seven people the two systems disagreed about. Dan, 2026-09-09:

> most of those don't matter. Jonathan is the only agent and he was just rehired
> today so it'll be changed. the rest aren't agents so we can leave them as-is. But
> let's use twilio as the source of truth

The comment closing #2148 recorded the standing rule: "when Salesforce and Twilio
disagree about a routing fact, Twilio is right", and recorded that whether Slate
should also take tiers and backend from Twilio was a separate question. #2152 asked
it, because "as long as tiers and backend are still read from Salesforce, that rule
lives in a person's memory rather than in the sync", and shipped the read.

Legal eligibility was settled the same day, by Dan on 2026-09-09: "The default is N.
Y is the only one called out." So `Y` is stored only for a worker carrying the
`Legal Eligible` tag, and `N` for every other state (#2098).

## Why

These are the reasons recorded on the issues and in `AGENTS.md`, not a
reconstruction:

- **cal.com already routed on Twilio.** A Pipedream job reads the same `teams` tags
  and writes them onto cal.com's members, so while Slate read Salesforce booleans the
  two systems took one fact from two places and nothing reconciled them. A
  divergence then looked like a Slate defect while both syncs worked (#2096).
  Reading the same tags through the Pipedream job's own mapping (`TEAM_TO_DEBT_TIER`,
  `TEAM_TO_BACKEND` in `src/lib/twilio/roster.ts`) makes the two agree by
  construction about the facts Twilio owns.
- **Redistribute exists only in Twilio.** The Salesforce User object carries no
  such field, and cal.com will not report per user attribute values, so Twilio is
  the only place Slate can read it.
- **It outlives cal.com.** Twilio stays where managers tag agents after cutover,
  so this is not a parallel run arrangement that retires with cal.com.

## What it costs

- **Two systems feed one row.** Salesforce owns the profile and the manager of
  record (#2099), Twilio owns the routing facts, and `pnpm verify:twilio-parity`
  exists to report the roster membership disagreements a shared source cannot make
  agree: a worker with no Slate row, a row no worker carries, a duplicated worker, a
  tag nobody mapped.
- **Silence is not treated as removal.** A Slate row Twilio holds no worker for
  keeps its stored tiers (its legal eligibility is still written to `N`), because
  emptying every pool an agent belongs to on a partial read is not recoverable the
  way withholding legal work is. The count is reported rather than acted on.
- **A tag that goes takes its value with it.** A merge would leave an agent in a
  pool the source says they are not in.

## What would change it

Twilio stopping being where managers tag agents, or Salesforce gaining the routing
facts as maintained fields. Either would move the source, and the mapping and the
parity command would move with it.

## Where the mechanics live

`src/lib/twilio/sync.ts` (the write), `src/lib/twilio/roster.ts` (the tag
mapping), `AGENTS.md` "Does Slate hold the same facts as cal.com's source?"
(`pnpm verify:twilio-parity`), and
`scripts/test-routing-attribute-vocabulary.ts`, which holds the mapping against the
routing vocabulary in both directions.
