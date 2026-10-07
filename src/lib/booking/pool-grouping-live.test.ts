import { describe, it, expect, vi, beforeEach } from "vitest";

// #3460: publishing the pool grouping to the directory, wired to the deployment's
// `CONFIRM_LINE` binding. The binding here serves the REAL object (named by the
// client's own naming, its role read from the path), so a put that would not survive
// the real envelope, or land on the wrong instance, fails here.

const env = vi.hoisted(() => ({ value: {} as Record<string, unknown>, throws: false }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    if (env.throws) throw new Error("not in a request");
    return { env: env.value };
  },
}));
const logged = vi.hoisted(() => ({ warn: [] as Record<string, unknown>[], info: [] as Record<string, unknown>[] }));
vi.mock("@/lib/log", () => ({
  log: {
    info: (_tag: string, fields: Record<string, unknown>) => void logged.info.push(fields),
    warn: (_tag: string, fields: Record<string, unknown>) => void logged.warn.push(fields),
    error: vi.fn(),
  },
}));
const after = vi.hoisted(() => ({ labels: [] as string[], work: [] as (() => Promise<unknown>)[] }));
vi.mock("@/lib/after-response", () => ({
  afterResponse: (label: string, work: () => Promise<unknown>) => {
    after.labels.push(label);
    after.work.push(work);
  },
}));

import { publishPoolGrouping, publishPoolGroupingAfterResponse, groupingDirectoryLive } from "@/lib/booking/pool-grouping-live";
import { makeConfirmLineObject, objectRoleOf } from "@/lib/booking/confirm-line-object";
import { confirmLineObjectName } from "@/lib/booking/shared-confirm-line";
import { POOL_GROUPING_DIRECTORY, groupingGetMessage, type GroupingEntry } from "@/lib/booking/pool-grouping";

function bound(fault?: "throws") {
  const objects = new Map<string, ReturnType<typeof makeConfirmLineObject>>();
  const names: string[] = [];
  const objectFor = (name: string) => {
    let o = objects.get(name);
    if (!o) {
      o = makeConfirmLineObject({ now: () => Date.now(), timer: () => () => {}, leaseTimer: () => () => {}, newId: () => "id" });
      objects.set(name, o);
    }
    return o;
  };
  return {
    names,
    get: async () => JSON.parse(await objectFor(confirmLineObjectName(POOL_GROUPING_DIRECTORY)).handle("directory", groupingGetMessage())) as Record<string, unknown>,
    binding: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init: { body?: string }) => {
          if (fault === "throws") throw new Error("object unreachable");
          names.push(id.name);
          const role = objectRoleOf(new URL(url).pathname, id.name);
          return new Response(await objectFor(id.name).handle("role" in role ? role.role : role, JSON.parse(init.body ?? "null")));
        },
      }),
    },
  };
}

const ENTRIES: GroupingEntry[] = [
  ["510", "pool-high"],
  ["511", "pool-high"],
];

describe("publishing the pool grouping (#3460)", () => {
  beforeEach(() => {
    env.value = {};
    env.throws = false;
    logged.warn.length = 0;
    logged.info.length = 0;
    after.labels.length = 0;
    after.work.length = 0;
  });

  it("puts it on the directory's own instance, and a get hands it back", async () => {
    const b = bound();
    env.value = { CONFIRM_LINE: b.binding };
    const out = await publishPoolGrouping(ENTRIES, 1_000);
    expect(out).toEqual({ ok: true, kind: "stored" });
    expect(b.names).toEqual([confirmLineObjectName(POOL_GROUPING_DIRECTORY)]);
    const got = await b.get();
    expect((got.snapshot as { entries: unknown }).entries).toEqual(ENTRIES);
    expect((got.snapshot as { readAtMs: number }).readAtMs).toBe(1_000);
  });

  it("counts a put the directory kept a NEWER one over as published, since the directory is fresh", async () => {
    const b = bound();
    env.value = { CONFIRM_LINE: b.binding };
    await publishPoolGrouping(ENTRIES, 2_000);
    expect(await publishPoolGrouping(ENTRIES, 1_000)).toEqual({ ok: true, kind: "kept" });
  });

  it("refuses an EMPTY grouping before asking anything, so a failed bucket read cannot publish gaps", async () => {
    const b = bound();
    env.value = { CONFIRM_LINE: b.binding };
    const out = await publishPoolGrouping([], 1_000);
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("empty");
    expect(b.names).toEqual([]);
    expect(logged.warn.length).toBe(1);
  });

  it("names each way a publish can fail, and says so in the log", async () => {
    expect((await publishPoolGrouping(ENTRIES, 1_000)).kind).toBe("unbound");
    env.throws = true;
    expect((await publishPoolGrouping(ENTRIES, 1_000)).kind).toBe("unbound");
    env.throws = false;
    env.value = { CONFIRM_LINE: bound("throws").binding };
    expect(await publishPoolGrouping(ENTRIES, 1_000)).toMatchObject({ ok: false, kind: "unreachable" });
    // A directory that refuses the put (here, a pool longer than the object's string cap).
    env.value = { CONFIRM_LINE: bound().binding };
    const refused = await publishPoolGrouping([["510", "x".repeat(300)]], 1_000);
    expect(refused).toMatchObject({ ok: false, kind: "refused" });
    expect(logged.warn.length).toBe(4);
  });

  it("finds the directory only through the binding, and nowhere off the runtime", () => {
    expect(groupingDirectoryLive()).toBeNull();
    env.throws = true;
    expect(groupingDirectoryLive()).toBeNull();
  });

  it("defers a server's own publish past the response", async () => {
    const b = bound();
    env.value = { CONFIRM_LINE: b.binding };
    publishPoolGroupingAfterResponse(ENTRIES, 3_000);
    expect(after.labels).toEqual(["pool-grouping-publish"]);
    expect(b.names).toEqual([]);
    await after.work[0]!();
    expect(((await b.get()).snapshot as { readAtMs: number }).readAtMs).toBe(3_000);
  });
});
