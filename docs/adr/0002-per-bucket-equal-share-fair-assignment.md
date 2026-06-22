# Per-bucket equal-share fair assignment

Round-robin assignment within a Pool is **per-bucket equal-share by booking count**:
among the agents free for the slot, the one with the **fewest bookings in that
Bucket during the current period** wins, ties broken by least-recently-booked then
agent id. Each Bucket is counted **independently** — an agent's bookings in other
Buckets never affect their standing here. This replaces the prior recency-only,
globally-scoped rotation.

## Why

The goal is that each agent gets a **fair share of bookings** (commission
opportunity), not merely "a turn." Recency rotation does not equalize counts when
availability differs, and its global scope was wrong across tiers (a booking in one
tier pushed an agent back in unrelated tiers' queues).

**Per-bucket, not global.** Pools are largely disjoint by eligibility — a medium
lead can only go to medium-eligible agents — so routing cannot equalize across
tiers, and shouldn't try. An agent with 10 High + 0 Ultra-High bookings should beat
one with 1 High + 2 Ultra-High for an incoming Ultra-High lead, because only
Ultra-High counts in the Ultra-High pool. Cross-tier volume differences (ultra-high
buckets get far fewer leads) are a **comp-plan and staffing-ratio** matter, not a
routing one — commission scaling with debt size offsets fewer-but-bigger meetings.

**Count, not dollars.** Slate does not know the debt amount at routing time (the XBC
code encodes a tier band, not a figure), so dollar-balancing is infeasible; count is
the only reliable, explainable unit.

**Period reset on the 15th and 25th.** Fairness is "equal share this pay period,"
resetting on the two semi-monthly pay boundaries (no payroll lag) so routing share
matches what agents feel in their paychecks. All-time counting was rejected (starves
veterans, floods new hires for months).

**Cold-start: prorate to time present.** An agent who joins a Bucket's pool mid-period
(new hire, newly-added, or reactivated) is seeded proportional to how much of the
period they have been active — neither flooded (starting at 0) nor starved. Mirrors
PET's existing new-rep goal proration.

## Consequences

- Still pointer-free / concurrency-safe: the count is a per-request query, not a
  mutable shared rotation pointer.
- Perfect equality is impossible when availability is unequal (the free-for-this-slot
  filter still constrains who can be picked); the model *targets* equal share.
- Multi-tier agents (common here) get a fair share in each pool they serve, so their
  total may exceed a single-tier agent's — accepted by design.
- Implementation tracked in issue #305.
