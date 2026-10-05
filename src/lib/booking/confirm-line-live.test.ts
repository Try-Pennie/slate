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

import { confirmLineFor } from "@/lib/booking/confirm-line-live";
import { isolateLine, makeConfirmQueue } from "@/lib/booking/confirm-queue";
import type { LineServed } from "@/lib/booking/shared-confirm-line";

const KEY = { group: "code:521", instant: "1791230400000" };

function line() {
  const served: LineServed[] = [];
  const l = confirmLineFor(isolateLine(makeConfirmQueue<string>()), (s) => served.push({ ...s }));
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
});
