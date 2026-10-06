import { describe, it, expect, vi, beforeEach } from "vitest";

// #3340: the one step `pnpm verify:confirm-line` takes into the deployment. The probe's
// rules are pinned by scripts/test-confirm-line-live-control.ts; what only this file can
// see is the ROUTE: the auth contract its /api/smoke siblings share, the two ways of
// finding no object (each its own reason), and that it really reaches the object through
// the production transport, naming the verification group's object and nothing else.

const env = vi.hoisted(() => ({ bookingApiKeyFor: vi.fn((_caller: string, _slot: string) => "") }));
const canaryKey = vi.hoisted(() => ({ value: "real-key" }));
const canaryKeyFor = (caller: string, slot: string) => (caller === "canary" && slot === "primary" ? canaryKey.value : "");
vi.mock("@/lib/env", () => env);

const cf = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));
vi.mock("@opennextjs/cloudflare", () => cf);

const logged = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logged }));

import { POST } from "./route";
import { CONFIRM_LINE_BINDING, makeConfirmLineHost } from "@/lib/booking/confirm-line-object";
import { realTimer } from "@/lib/read-within-deadline";
import { CONFIRM_LINE_CHECKS, CONFIRM_LINE_PROBE_REASON, CONFIRM_LINE_VERIFY_GROUP } from "@/lib/monitor/confirm-line-probe";

function post(authorization = "Bearer real-key") {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return POST(new Request("http://localhost/api/smoke/confirm-line", { method: "POST", headers }) as never);
}

/** A binding whose objects are real hosts, one per name, reached over a JSON fetch as in production. */
function boundToRealHosts() {
  const named: string[] = [];
  const hosts = new Map<string, ReturnType<typeof makeConfirmLineHost>>();
  const ns = {
    idFromName: (name: string) => {
      named.push(name);
      return name;
    },
    get: (id: unknown) => {
      const name = String(id);
      if (!hosts.has(name)) {
        hosts.set(name, makeConfirmLineHost({ now: () => Date.now(), timer: realTimer, leaseTimer: realTimer, newId: () => crypto.randomUUID() }));
      }
      const host = hosts.get(name)!;
      return {
        fetch: async (_url: string, init: { body?: string }) =>
          new Response(await host.handle(JSON.parse(init.body ?? "null")), { headers: { "content-type": "application/json" } }),
      };
    },
  };
  cf.getCloudflareContext.mockReturnValue({ env: { [CONFIRM_LINE_BINDING]: ns } });
  return named;
}

beforeEach(() => {
  vi.clearAllMocks();
  canaryKey.value = "real-key";
  env.bookingApiKeyFor.mockImplementation(canaryKeyFor);
});

describe("POST /api/smoke/confirm-line", () => {
  it("fails CLOSED with 503 when no key is configured, and never touches the object", async () => {
    canaryKey.value = "";
    const named = boundToRealHosts();
    const res = await post();
    expect(res.status).toBe(503);
    expect(named).toEqual([]);
  });

  it("401s a wrong key, and a partner's key, without touching the object", async () => {
    env.bookingApiKeyFor.mockImplementation((c: string, s: string) => (c === "regal" && s === "primary" ? "regal-key" : canaryKeyFor(c, s)));
    const named = boundToRealHosts();
    expect((await post("Bearer not-the-key")).status).toBe(401);
    expect((await post("Bearer regal-key")).status).toBe(401);
    expect((await post("")).status).toBe(401);
    expect(named).toEqual([]);
  });

  it("tells an unreadable context apart from a missing binding: different remedies", async () => {
    cf.getCloudflareContext.mockImplementation(() => {
      throw new Error("no context");
    });
    const unreadable = await post();
    expect(unreadable.status).toBe(503);
    expect((await unreadable.json()).reason).toBe(CONFIRM_LINE_PROBE_REASON.contextUnreadable);

    cf.getCloudflareContext.mockReset();
    cf.getCloudflareContext.mockReturnValue({ env: {} });
    const missing = await post();
    expect(missing.status).toBe(503);
    expect((await missing.json()).reason).toBe(CONFIRM_LINE_PROBE_REASON.bindingMissing);
  });

  it("runs every check against the object through the production transport, and only the verification group's", async () => {
    const named = boundToRealHosts();
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reason).toBe(CONFIRM_LINE_PROBE_REASON.checked);
    expect(body.group).toBe(CONFIRM_LINE_VERIFY_GROUP);
    for (const check of CONFIRM_LINE_CHECKS) expect([check, body.checks[check].outcome]).toEqual([check, "passed"]);
    // Named exactly as the confirm path names a group's object, and never anything else.
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set([`confirm-line:v1:${CONFIRM_LINE_VERIFY_GROUP}`]));
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("reports an object that does not answer on every check, and logs it, rather than failing the request", async () => {
    cf.getCloudflareContext.mockReturnValue({
      env: {
        [CONFIRM_LINE_BINDING]: {
          idFromName: (name: string) => name,
          get: () => ({
            fetch: async () => {
              throw new Error("durable object unreachable");
            },
          }),
        },
      },
    });
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const check of CONFIRM_LINE_CHECKS) expect([check, body.checks[check].outcome]).toEqual([check, "unreachable"]);
    expect(logged.warn).toHaveBeenCalledTimes(1);
  });
});
