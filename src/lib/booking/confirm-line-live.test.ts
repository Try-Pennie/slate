import { describe, it, expect, vi, beforeEach } from "vitest";

// The runtime pieces the wiring composes, replaced so the test decides each one.
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown>, throws: false }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    if (env.throws) throw new Error("not in a request");
    return { env: env.value };
  },
}));
const switchReading = vi.hoisted(() => ({ value: { on: false, source: "read" as const } as { on: boolean; source: "read" | "last-known" | "default" } }));
vi.mock("@/lib/booking/shared-line-switch", () => ({ readSharedConfirmLine: async () => switchReading.value }));
const sent = vi.hoisted(() => ({ alerts: [] as string[] }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: async (key: string) => void sent.alerts.push(key) }));
vi.mock("@/lib/platform/runtime", () => ({ isWorkersRuntime: () => true }));

const pools = vi.hoisted(() => ({ known: new Map<string, string | null>(), warms: 0, after: [] as string[] }));
vi.mock("@/lib/availability/slot-cache", () => ({
  peekPoolKey: (code: string) => (pools.known.has(code) ? pools.known.get(code) : undefined),
  warmPoolKeys: async () => void pools.warms++,
}));
vi.mock("@/lib/after-response", () => ({
  afterResponse: (label: string, work: () => Promise<unknown>) => {
    pools.after.push(label);
    void work();
  },
}));

import { confirmLineFor, lineGroupOfLive } from "@/lib/booking/confirm-line-live";
import { isolateLine, makeConfirmQueue } from "@/lib/booking/confirm-queue";
import type { LineServed } from "@/lib/booking/shared-confirm-line";

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

  it("names a code's ladder from what the isolate holds, and warms it after the response when it does not know", async () => {
    pools.known = new Map();
    pools.warms = 0;
    pools.after = [];
    expect(lineGroupOfLive("510")).toBeNull();
    await Promise.resolve();
    expect(pools.after).toEqual(["pool-keys-warm"]);
    expect(pools.warms).toBe(1);
    for (const code of ["510", "410", "310", "210", "511", "411", "311", "211"]) pools.known.set(code, `pool-${code[0]}`);
    const g = lineGroupOfLive("510");
    expect(g).toMatch(/^ladder:/);
    expect(lineGroupOfLive("511")).toBe(g);
    expect(pools.after).toEqual(["pool-keys-warm"]);
  });
});
