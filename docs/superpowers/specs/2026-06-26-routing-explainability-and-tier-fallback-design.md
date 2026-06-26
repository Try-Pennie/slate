# Routing Explainability & Tier-Drop Fallback — Design

**Date:** 2026-06-26
**Status:** Draft (brainstorm complete, pre-plan)
**Scope:** Slate routing — auditability, a misroute self-alert, and a cascading
tier-drop fallback. Slate is not yet live; this is greenfield behavior added to
the existing routing path.

## Problem

Today an external Slack alert (driven by Regal) fires "Non-Ultra High Team
Booking Detected" when a lead Regal knows is Ultra High (XBC starting with `5`)
gets booked with an agent not on the Ultra High team. Two limitations motivated
this design:

1. **We cannot fully replicate that alert inside Slate, and shouldn't try.** It
   catches a class of error Slate is structurally blind to (see Failure Classes).
2. **There is no record of *why* a booking went to the agent it did.** When a
   routing outcome looks wrong, there is nothing to inspect.

The user's reframe: the real want is an **explainable routing decision log**.
Once that exists, a misroute "bug" alert and a tier-drop fallback both become
thin consumers of it.

## Failure Classes (why some alerting stays in Regal)

| Class | Description | Who can detect it |
|-------|-------------|-------------------|
| **Input-truth mismatch** | The XBC that reached Slate was wrong/stale/missing, so Slate routed correctly *for the input it got* but the input lied. Slate never sees the true tier. | **Only the holder of the true XBC → stays in Regal.** Slate is structurally blind. |
| **Internal invariant violation** | Slate received the right XBC but a bug/misconfig/stale roster put the booking on a non-qualifying agent. | **Slate can self-detect** at book time. |
| **Post-booking drift** | A reschedule/reassignment later breaks the invariant. | **Slate can self-detect** on write. |

This design owns the second and third classes. The first stays in Regal — but
the decision log makes diagnosing a Regal alert trivial (was it "Slate got `5xx`
and still misrouted" = bug, or "Slate got a non-`5` XBC" = input problem).

## Existing mechanisms (do NOT conflate)

The codebase already has the word "fallback", but it is a *different* mechanism:

- **Empty-pool fallback (`bucket.fallback_user_id`)** — `eligibleAgentIds()` in
  `src/lib/availability/service.ts:82`. Fires only when a bucket's matched pool
  is **empty** (nobody in the org matches the criteria at all — a
  misconfiguration). Routes to one designated backup agent. Trigger = *empty
  pool*.
- **Shadow log (#321)** — `rankBucketShare()` in
  `src/lib/availability/service.ts:~410`. Emits a `routing_shadow` JSON line to
  **stdout only** (no DB). On Cloudflare these logs are ephemeral and unreliable
  for `console.error`. Not a durable audit trail.

The fallback this design adds is **tier-drop on exhausted availability** — the
pool is *not* empty, every agent in it is simply booked solid across the whole
window. Orthogonal to empty-pool fallback. Both can exist; precedence defined
below.

## The four pieces

### 1. Decision log (the spine)

A new **persisted** table (working name `routing_decisions`), written on every
real routing decision (not previews). It must answer "why this agent, and why
not the others" indefinitely.

Recorded per decision (final field list deferred to the plan):
- Raw XBC received + resolved bucket code + resolved criteria.
- The candidate pool, each agent with an **include/exclude reason**: not on
  team (criteria miss), not bookable, deactivated, OOO/busy, daily-cap hit, no
  availability in window.
- The equal-share ranking signal used (per-period booking counts / tiebreak).
- The chosen agent.
- Fallback flags: `empty_pool_fallback` and `tier_drop` (with the from→to tiers
  and how many rungs dropped).
- Outcome: booked / no-availability / error.

Also logs **attempts that yield no booking** ("why did this lead get no Ultra
High slots") — not just successful assignments.

This extends the *intent* of the #321 shadow log but persists to a table instead
of stdout. Whether to keep the stdout line in parallel is a plan-level call.

### 2. Tier-drop fallback (cascade)

When a bucket yields **zero bookable slots across the entire booking window**
(all open days, not just the customer's preferred day), drop one rung down the
debt-tier ladder and retry, **cascading** until a tier has an opening:

```
Ultra High (5) → Very High (4) → High (3) → Medium (2) → Low (1)
```

- **Cascade depth:** keep stepping down until availability is found (user
  decision 2026-06-26). No fixed floor. In practice a UH lead would essentially
  never reach Low — that requires tens of agents booked solid across the full
  ~4-business-day window. *Because* a deep cascade is so improbable, treat it as
  a high-signal anomaly, not a routine path: a single-rung drop is a throttled
  notice, but a multi-rung drop (≥2) is a louder/escalated alert — if it ever
  fires, something is badly wrong (capacity crisis, mass OOO, roster-sync
  collapse, bad availability read), and that is exactly what we want surfaced.
- **Criteria preservation (DEFAULT — confirm):** tier-drop relaxes **only the
  debt-tier digit**. Backend-service and legal constraints (XBC digits 2 and 3)
  stay fixed. A "Both / Legal" Ultra High lead drops into the "Both / Legal"
  Very High pool, never to an unrelated agent one tier down.
- **Surface:** this changes **what the embedded booker displays**, not just
  back-end assignment (user decision 2026-06-26). If a bucket has no slots in
  the window, the booker surfaces the next qualifying tier's slots so the
  customer has something to book; the cascade happens at **slot-generation
  time**. The customer experience is seamless (they are not shown tier labels);
  the drop is recorded internally.
- **Loud:** every tier-drop is a distinct, recorded event (log + likely a
  throttled Slack notice), because it should essentially never happen given
  marketing keeps ≤2 days booked ahead against a ~4-day window.
- **Precedence vs. empty-pool fallback:** tier-drop is the outer loop over
  tiers; within each tier the existing matched-pool + `fallback_user_id`
  resolution applies. A tier counts as "exhausted" only when it produces no
  bookable slots in the window.

### 3. Misroute bug alert (alert + allow)

At book time, assert the invariant: **the chosen agent satisfies the booked
bucket's required team**. If violated **and** the decision log shows no
intentional `tier_drop`/`empty_pool_fallback` for this booking → fire a
throttled Slack alert. **The booking still completes** (user decision
2026-06-26: do not block real customers on a live bug; fix forward). Pure
consumer of the log. Reuses `sendThrottledAlert()` /
`src/lib/notify/dispatch.ts`.

### 4. Regal reconciliation — fallback stamp ON the booking event

Because intentional fallbacks are stamped **at decision time**, a legitimate
UH→VH booking is distinguishable from a bug. But the internal `routing_decisions`
table is invisible to Regal — so the stamp must also ride on the **outbound
booking event** Slate emits. **This build (Slate side):** add a routing/fallback
property to `BookingEventPayload` (`src/lib/webhooks/types.ts`), populated in
`webhookPayload()` (`src/lib/booking/orchestration.ts:570`) from the booking's
routing decision. Shape (final names in plan), e.g.:

```
routing: {
  tier_fallback: boolean,        // true only on an availability-driven tier-drop
  requested_tier: "ultra_high",  // from the XBC
  booked_tier: "very_high",      // the tier actually booked
  rungs_dropped: 1,
}
```

So Regal can suppress its "Non-Ultra High Team Booking Detected" alert whenever
`tier_fallback` is true, and only fire on a true team mismatch (an actual
misroute). The field must survive the booking's agent snapshot (read from stored
routing state, not recomputed) so reschedules/replays carry the same truth.

**Regal side (separate, #492):** Regal must read this field and gate its alert
on it. Out of scope here — this build only *emits* the stamp.

## Touch points (from code map)

- `src/lib/availability/service.ts` — `eligibleAgentIds()`,
  `resolveBucketAgentIds()`, `rankBucketShare()` (shadow log).
- `src/lib/availability/roundrobin.ts` — `orderByBucketShare()` (equal-share).
- `src/lib/availability/compute.ts` — `freeMembersForSlot()` (availability
  filters; where "exhausted across window" is determined).
- `src/lib/booking/orchestration.ts` — `assignAgent()` (invariant check site).
- `src/lib/xbc.ts` — `bucketSpecForXbc()` (tier ladder; criteria relaxation).
- `src/app/api/routing/route.ts` — `resolveRouting()` (already returns
  `fallbackApplied`; extend shape).
- `src/lib/webhooks/types.ts` — `BookingEventPayload` (add `routing`/fallback
  field) + `src/lib/booking/orchestration.ts:570` `webhookPayload()` (populate
  it) so Regal can suppress its alert on intentional tier-drops.
- `src/lib/notify/dispatch.ts` + `slack.ts` — throttled alerting.
- New DB table + migration for `routing_decisions`.

## Out of scope (Slate-side)

- Catching input-truth mismatches (stays in Regal).
- Changing the empty-pool `fallback_user_id` mechanism.
- The actual Regal-side change to suppress its alert on stamped fallbacks.

## Open Questions (for spec review)

1. ~~Criteria preservation~~ — **confirmed 2026-06-26:** tier-drop relaxes the
   debt-tier digit only; backend + legal constraints stay fixed.
2. ~~Escalation on deep drops~~ — **resolved 2026-06-26:** single-rung drop =
   throttled notice; multi-rung drop (≥2) = louder escalated alert, because a
   deep cascade is near-impossible under normal load and therefore a strong
   anomaly signal.
3. ~~Regal handoff~~ — **resolved 2026-06-26:** separate Regal-side task,
   tracked in #492. Out of scope for this build (Slate only stamps the signal).
4. ~~`routing_decisions` retention~~ — **resolved 2026-06-26:** time-boxed
   prune, delete whole rows older than **12 months** (scheduled cleanup, e.g.
   the existing cron). Anything older than a year is not worth investigating.
