import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The runtime pieces the wiring composes, replaced so the test decides each one.
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown>, throws: false }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    if (env.throws) throw new Error("not in a request");
    return { env: env.value };
  },
}));
const switchReading = vi.hoisted(() => ({ value: { on: false, source: "read" as const } as { on: boolean; source: "read" | "last-known" | "default" }, reads: 0 }));
vi.mock("@/lib/booking/shared-line-switch", () => ({
  readSharedConfirmLine: async () => {
    switchReading.reads++;
    return switchReading.value;
  },
}));
const sent = vi.hoisted(() => ({ alerts: [] as string[] }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: async (key: string) => void sent.alerts.push(key) }));
vi.mock("@/lib/platform/runtime", () => ({ isWorkersRuntime: () => true }));

// #3460: the server's grouping is the REAL store, so what is installed and when it
// expires is the shipped rule; only the warm up (two table reads) is counted instead.
const pools = vi.hoisted(() => ({ warms: 0, after: [] as string[] }));
vi.mock("@/lib/availability/slot-cache", async () => {
  const { makeGroupingStore, POOL_GROUPING_FRESH_MS } = await import("@/lib/booking/pool-grouping-reader");
  const lineGroupingStore = makeGroupingStore({ now: () => Date.now(), freshMs: POOL_GROUPING_FRESH_MS });
  return {
    lineGroupingStore,
    peekPoolKey: (code: string) => lineGroupingStore.peek(code),
    warmPoolKeys: async () => void pools.warms++,
  };
});
vi.mock("@/lib/after-response", () => ({
  afterResponse: (label: string, work: () => Promise<unknown>) => {
    pools.after.push(label);
    void work();
  },
}));

import { confirmLineFor, lineGroupOfLive, settleLineGrouping, startConfirmPrelude } from "@/lib/booking/confirm-line-live";
import { isolateLine, makeConfirmQueue } from "@/lib/booking/confirm-queue";
import type { LineServed } from "@/lib/booking/shared-confirm-line";
import type { ConfirmLineFacts } from "@/lib/booking/confirm-latency";
import { lineGroupingStore } from "@/lib/availability/slot-cache";
import { makeConfirmLineObject, objectRoleOf } from "@/lib/booking/confirm-line-object";
import { POOL_GROUPING_DIRECTORY, groupingPutMessage, groupingSnapshotOf, type GroupingEntry } from "@/lib/booking/pool-grouping";
import { confirmLineObjectName } from "@/lib/booking/shared-confirm-line";
import { POOL_GROUPING_RETRY_MS } from "@/lib/booking/pool-grouping-reader";

/**
 * A `CONFIRM_LINE` binding whose every instance is the REAL object, named and served
 * exactly as the deployment does (the name from the client's naming, the role from the
 * path), so the directory a confirm fetches from is the shipped one.
 */
function boundObjects() {
  const objects = new Map<string, ReturnType<typeof makeConfirmLineObject>>();
  const calls: string[] = [];
  const objectFor = (name: string) => {
    let o = objects.get(name);
    if (!o) {
      o = makeConfirmLineObject({ now: () => Date.now(), timer: () => () => {}, leaseTimer: () => () => {}, newId: () => "id" });
      objects.set(name, o);
    }
    return o;
  };
  return {
    calls,
    put: async (snapshot: ReturnType<typeof groupingSnapshotOf>) =>
      objectFor(confirmLineObjectName(POOL_GROUPING_DIRECTORY)).handle("directory", groupingPutMessage(snapshot)),
    binding: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init: { body?: string }) => {
          const path = new URL(url).pathname;
          calls.push(`${id.name} ${path}`);
          const role = objectRoleOf(path, id.name);
          return new Response(await objectFor(id.name).handle("role" in role ? role.role : role, JSON.parse(init.body ?? "null")));
        },
      }),
    },
  };
}

/** The 120 and 121 ladders, every rung one pool, as a recompute lane would publish them. */
const ENTRIES: GroupingEntry[] = [
  ["110", "pool-1"],
  ["111", "pool-1"],
  ["120", "pool-1-beyond"],
  ["121", "pool-1-beyond"],
  ["130", "pool-1-achieve"],
  ["131", "pool-1-achieve"],
];

const KEY = { group: "code:521", instant: "1791230400000" };

function line() {
  const served: LineServed[] = [];
  const l = confirmLineFor(isolateLine(makeConfirmQueue<string>()), (s) => served.push({ ...s }), null);
  return { l, served };
}

describe("confirmLineFor (#3325)", () => {
  beforeEach(() => {
    env.value = {};
    env.throws = false;
    switchReading.value = { on: false, source: "read" };
  });

  it("uses the isolate's own line when the switch is off, and says so", async () => {
    const { l, served } = line();
    const turn = await l.enter(KEY, 1_000);
    expect(turn.kind).toBe("lead");
    expect(served.at(-1)).toMatchObject({ line: "isolate", reason: "off" });
    if (turn.kind === "lead") await turn.done({ full: false });
  });

  it("falls back as unbound when the switch is on and the deployment has no binding", async () => {
    switchReading.value = { on: true, source: "read" };
    const { l, served } = line();
    const turn = await l.enter(KEY, 1_000);
    expect(turn.kind).toBe("lead");
    expect(served.at(-1)).toMatchObject({ line: "fallback", reason: "unbound" });
    if (turn.kind === "lead") await turn.done({ full: false });
  });

  it("treats a runtime with no request context as unbound, never as a crash", async () => {
    switchReading.value = { on: true, source: "read" };
    env.throws = true;
    const { l, served } = line();
    await l.enter(KEY, 1_000);
    expect(served.at(-1)).toMatchObject({ line: "fallback", reason: "unbound" });
  });

  it("asks the bound object, named from the group, when the switch is on", async () => {
    switchReading.value = { on: true, source: "read" };
    const names: string[] = [];
    env.value = {
      CONFIRM_LINE: {
        idFromName: (name: string) => (names.push(name), { name }),
        get: () => ({
          fetch: async (_url: string, init: { body?: string }) => {
            const m = JSON.parse(init.body ?? "{}") as { op: string };
            const answer = m.op === "enter" ? { kind: "lead", turn: "t1" } : { ok: true };
            return new Response(JSON.stringify(answer));
          },
        }),
      },
    };
    const { l, served } = line();
    const turn = await l.enter(KEY, 1_000);
    expect(turn.kind).toBe("lead");
    expect(names).toContain("confirm-line:v1:code:521");
    expect(served.at(-1)).toMatchObject({ line: "shared", reason: "ok", key: "code" });
    if (turn.kind === "lead") await turn.done({ full: false });
  });

  it("stamps every call to the bound object with the confirm's trace when it has one (#3354)", async () => {
    switchReading.value = { on: true, source: "read" };
    const bodies: Record<string, unknown>[] = [];
    env.value = {
      CONFIRM_LINE: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          fetch: async (_url: string, init: { body?: string }) => {
            const m = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
            bodies.push(m);
            return new Response(JSON.stringify(m.op === "enter" ? { kind: "lead", turn: "t1" } : { ok: true }));
          },
        }),
      },
    };
    const traced = confirmLineFor(isolateLine(makeConfirmQueue<string>()), () => {}, "t-7");
    const turn = await traced.enter(KEY, 1_000);
    if (turn.kind === "lead") await turn.done({ full: false });
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => b.trace === "t-7")).toBe(true);
    bodies.length = 0;
    const plain = line();
    const own = await plain.l.enter({ ...KEY, instant: "2" }, 1_000);
    if (own.kind === "lead") await own.done({ full: false });
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.some((b) => "trace" in b)).toBe(false);
  });

});

// #3460 retires #3325's "a confirm never reads before its line". Load run 37566700055
// split a burst across ladder and code lines because most of its servers held no
// grouping; #3355 had already decided a confirm may WAIT, within a short bound, for the
// grouping before its key. These pin the wait and every way it can end.
describe("the line key's grouping (#3460)", () => {
  // The clock every case runs on, only ever moved forward (restoring the real clock
  // between cases would move it back under a fetch an earlier case recorded).
  let clock = 0;
  beforeEach(() => {
    env.value = {};
    env.throws = false;
    lineGroupingStore.reset();
    pools.warms = 0;
    pools.after = [];
    switchReading.reads = 0;
    // The reader is the server's own, one per module, so a fetch an earlier case found
    // nothing in holds the next one back for the retry window. Each case starts past it.
    vi.useFakeTimers({ toFake: ["Date"] });
    clock = Math.max(clock, Date.now()) + 10 * POOL_GROUPING_RETRY_MS;
    vi.setSystemTime(clock);
  });
  afterEach(() => {
    clock = Math.max(clock, Date.now());
    vi.useRealTimers();
  });

  it("keys a ladder from a grouping this server read itself, fetches nothing, and says local", async () => {
    const objects = boundObjects();
    env.value = { CONFIRM_LINE: objects.binding };
    lineGroupingStore.install(ENTRIES, Date.now() - 1_000, "read");
    const facts: ConfirmLineFacts = {};
    await settleLineGrouping(facts);
    expect(facts.grouping?.source).toBe("held");
    const g = lineGroupOfLive("120", facts);
    expect(g).toMatch(/^ladder:/);
    expect(lineGroupOfLive("121", facts)).toBe(g);
    expect(facts.lineGroupSource).toBe("local");
    expect(objects.calls).toEqual([]);
    expect(pools.after).not.toContain("pool-keys-warm");
  });

  it("fetches the directory's snapshot when it holds nothing, installs it, and the confirm keys its ladder from it", async () => {
    const objects = boundObjects();
    env.value = { CONFIRM_LINE: objects.binding };
    await objects.put(groupingSnapshotOf(ENTRIES, Date.now() - 2_000));
    const facts: ConfirmLineFacts = {};
    startConfirmPrelude(facts);
    await settleLineGrouping(facts);
    expect(facts.grouping?.source).toBe("installed");
    expect(objects.calls).toEqual([`${confirmLineObjectName(POOL_GROUPING_DIRECTORY)} /directory`]);
    // Kept alive past the response: a fetch the request started must not be cancelled
    // under a later confirm on this server that joined it.
    expect(pools.after).toContain("pool-grouping-fetch");
    expect(lineGroupOfLive("121", facts)).toMatch(/^ladder:/);
    expect(facts.lineGroupSource).toBe("snapshot");
    expect(pools.after).not.toContain("pool-keys-warm");
  });

  it("keeps the code's own line, says why, and warms after the response when the directory holds nothing", async () => {
    const objects = boundObjects();
    env.value = { CONFIRM_LINE: objects.binding };
    const facts: ConfirmLineFacts = {};
    await settleLineGrouping(facts);
    expect(facts.grouping?.source).toBe("absent");
    expect(lineGroupOfLive("120", facts)).toBeNull();
    expect(facts.lineGroupSource).toBe("absent");
    await Promise.resolve();
    expect(pools.after).toContain("pool-keys-warm");
    expect(pools.warms).toBe(1);
  });

  // Review of #3471: the fetch starts before the ceilings answer, so a caller they refuse
  // starts it too. After a fetch that found nothing, the next is not started for the retry
  // window, so a flood of such requests costs this server one call, never one each.
  it("asks an empty directory once, then says backoff without asking until the retry window has passed", async () => {
    const objects = boundObjects();
    env.value = { CONFIRM_LINE: objects.binding };
    const first: ConfirmLineFacts = {};
    startConfirmPrelude(first);
    await settleLineGrouping(first);
    expect(first.grouping?.source).toBe("absent");
    for (let i = 0; i < 20; i++) {
      const facts: ConfirmLineFacts = {};
      startConfirmPrelude(facts);
      await settleLineGrouping(facts);
      expect(facts.grouping?.source).toBe("backoff");
      expect(lineGroupOfLive("120", facts)).toBeNull();
      expect(facts.lineGroupSource).toBe("backoff");
    }
    expect(objects.calls.length).toBe(1);
    vi.setSystemTime(Date.now() + POOL_GROUPING_RETRY_MS);
    const later: ConfirmLineFacts = {};
    await settleLineGrouping(later);
    expect(later.grouping?.source).toBe("absent");
    expect(objects.calls.length).toBe(2);
  });

  it("keeps the code's own line when a stale snapshot is all the directory has", async () => {
    const objects = boundObjects();
    env.value = { CONFIRM_LINE: objects.binding };
    await objects.put(groupingSnapshotOf(ENTRIES, Date.now() - 61_000));
    const facts: ConfirmLineFacts = {};
    await settleLineGrouping(facts);
    expect(facts.grouping?.source).toBe("stale");
    expect(lineGroupOfLive("120", facts)).toBeNull();
    expect(facts.lineGroupSource).toBe("stale");
  });

  it("keeps the code's own line when the grouping it holds does not list the confirm's own code", async () => {
    lineGroupingStore.install(ENTRIES.filter(([code]) => code !== "120"), Date.now() - 1_000, "snapshot");
    const facts: ConfirmLineFacts = {};
    await settleLineGrouping(facts);
    expect(lineGroupOfLive("120", facts)).toBeNull();
    expect(facts.lineGroupSource).toBe("own-code-missing");
  });

  it("says unbound, never absent, where there is no binding", async () => {
    const facts: ConfirmLineFacts = {};
    await settleLineGrouping(facts);
    expect(facts.grouping?.source).toBe("unbound");
    expect(lineGroupOfLive("120", facts)).toBeNull();
    expect(facts.lineGroupSource).toBe("unbound");
  });

  it("starts the switch read and the fetch together, keeping the read alive past the response (#3355 item 1)", async () => {
    const objects = boundObjects();
    env.value = { CONFIRM_LINE: objects.binding };
    const facts: ConfirmLineFacts = {};
    startConfirmPrelude(facts);
    expect(switchReading.reads).toBe(1);
    expect(pools.after).toContain("shared-line-switch");
    expect(facts.groupingRead).toBeDefined();
    // The confirm awaits the fetch the prelude started, never a second one.
    await settleLineGrouping(facts);
    expect(objects.calls.length).toBe(1);
  });
});
