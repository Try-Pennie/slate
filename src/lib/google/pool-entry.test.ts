import { describe, it, expect, vi, beforeEach } from "vitest";

// #2302: the mirror of cleanupOnPoolExit. An agent flipped bookable used to be
// live in the routing pool while three separate lanes caught up with them: the
// watch lane discovered their calendars (every five minutes), the sync rotation
// did the first sync (every minute), and the hydration rotation bootstrapped the
// busy window (every fifteen minutes, batch of two). Measured 2026-09-14 that was
// thirty minutes of being offered with an empty cache, so the booker showed their
// whole seeded week as free.
//
// What is under test is the SEQUENCE and its failure containment, not Google:
// the collaborators are injected, because the contract worth pinning is that
// watches are established before anything looks for calendars, that one bad
// calendar does not abandon the rest, and that nothing claims the agent was
// processed when nothing succeeded.

const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logSpy }));

import { onboardIntoPool, type PoolEntryDeps } from "./pool-entry";

type Cal = { id: string; user_id: string; calendar_id: string };

/** Records the order every collaborator was called in, which is the contract. */
function deps(
  over: Partial<PoolEntryDeps> & { calendars?: Cal[]; hydrateFails?: string[] } = {},
): PoolEntryDeps & { order: string[]; synced: string[][] } {
  const order: string[] = [];
  const synced: string[][] = [];
  const calendars = over.calendars ?? [{ id: "c1", user_id: "u1", calendar_id: "primary" }];
  const hydrateFails = new Set(over.hydrateFails ?? []);
  return {
    order,
    synced,
    ensureWatches: over.ensureWatches ?? vi.fn(async () => {
      order.push("ensureWatches");
      return { status: "renewed" as const };
    }),
    loadAgentCalendars: over.loadAgentCalendars ?? (vi.fn(async () => {
      order.push("loadAgentCalendars");
      return calendars;
    }) as unknown as PoolEntryDeps["loadAgentCalendars"]),
    hydrateCalendar: over.hydrateCalendar ?? (vi.fn(async (cal: { id: string }) => {
      order.push(`hydrate:${cal.id}`);
      if (hydrateFails.has(cal.id)) throw new Error(`boom ${cal.id}`);
      return { ok: true, events: 3 };
    }) as unknown as PoolEntryDeps["hydrateCalendar"]),
    markAgentsSynced: over.markAgentsSynced ?? vi.fn(async (ids: string[]) => {
      order.push("markAgentsSynced");
      synced.push(ids);
    }),
  };
}

describe("onboardIntoPool (#2302)", () => {
  beforeEach(() => {
    logSpy.info.mockClear();
    logSpy.warn.mockClear();
    logSpy.error.mockClear();
  });

  it("establishes the watches BEFORE looking for calendars to hydrate", async () => {
    // Order is the whole point: a brand new agent has no agent_calendars rows at
    // all until ensureWatches discovers them, so hydrating first would find
    // nothing and report a clean run over an agent with no cache.
    const d = deps();
    await onboardIntoPool("u1", d);
    expect(d.order.indexOf("ensureWatches")).toBeLessThan(d.order.indexOf("loadAgentCalendars"));
    expect(d.order).toContain("hydrate:c1");
  });

  it("hydrates every calendar the agent holds, not just the first", async () => {
    const d = deps({
      calendars: [
        { id: "c1", user_id: "u1", calendar_id: "primary" },
        { id: "c2", user_id: "u1", calendar_id: "team@trypennie.com" },
      ],
    });
    const res = await onboardIntoPool("u1", d);
    expect(res.hydrated).toBe(2);
    expect(res.failed).toBe(0);
  });

  it("one calendar throwing does not abandon the others", async () => {
    // Each calendar is its own failure boundary (L73). A loop that throws on the
    // first leaves every later calendar unhydrated while the caller sees one error.
    const d = deps({
      calendars: [
        { id: "c1", user_id: "u1", calendar_id: "primary" },
        { id: "c2", user_id: "u1", calendar_id: "team@trypennie.com" },
      ],
      hydrateFails: ["c1"],
    });
    const res = await onboardIntoPool("u1", d);
    expect(res.hydrated).toBe(1);
    expect(res.failed).toBe(1);
    expect(d.order).toContain("hydrate:c2");
  });

  it("stamps the agent as synced once something was actually hydrated", async () => {
    const d = deps();
    await onboardIntoPool("u1", d);
    expect(d.synced).toEqual([["u1"]]);
  });

  it("does NOT stamp the agent when nothing hydrated", async () => {
    // The stamp is what the staleness gauge reads. Writing it after a run that
    // achieved nothing would give the agent a fresh age and buy fifteen minutes of
    // silence about an agent whose cache is empty, which is the shape this whole
    // change exists to end (L12: claim only what verifiably happened).
    const d = deps({ hydrateFails: ["c1"] });
    const res = await onboardIntoPool("u1", d);
    expect(res.hydrated).toBe(0);
    expect(d.synced).toEqual([]);
  });

  it("reports a watch failure and still hydrates whatever calendars exist", async () => {
    // ensureWatches never throws, it returns a status. A renewal that failed for an
    // agent who already has calendar rows must not stop the bootstrap: push updates
    // are one path to freshness and the cache is another.
    const d = deps({
      ensureWatches: vi.fn(async () => ({ status: "error" as const, error: "429" })),
    });
    const res = await onboardIntoPool("u1", d);
    expect(res.watch).toBe("error");
    expect(res.hydrated).toBe(1);
  });

  it("says so rather than throwing when the agent has no calendars at all", async () => {
    // Google could not give us a calendar for them. Nothing to hydrate is not a
    // successful onboarding, and reporting it as one is how a check that measured
    // nothing reads as a healthy result (L98).
    const d = deps({ calendars: [] });
    const res = await onboardIntoPool("u1", d);
    expect(res.calendars).toBe(0);
    expect(res.hydrated).toBe(0);
    expect(d.synced).toEqual([]);
  });
});
