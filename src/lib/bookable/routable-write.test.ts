import { describe, it, expect, vi, beforeEach } from "vitest";

// #2085: the ONE helper that writes `users.bookable` and `users.deactivated_at`,
// and the only place a bookable trait is owed to Regal from. These drive it
// against an in-memory users table that applies the real filters (a compare and
// swap on `deactivated_at` included), so "the write landed" and "the write lost
// its race" are decided by the store rather than by a flag the test sets (L70).

type Row = {
  id: string;
  org_id: string;
  email: string;
  bookable: boolean;
  deactivated_at: string | null;
  is_test: boolean;
  bookable_pending_since: string | null;
};

const store = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  patches: [] as Record<string, unknown>[],
  readError: null as null | { message: string },
  writeError: null as null | { message: string },
}));

function builder() {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  let patch: Record<string, unknown> | null = null;
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.update = (p: Record<string, unknown>) => {
    patch = p;
    return b;
  };
  b.eq = (col: string, val: unknown) => {
    filters.push((r) => r[col] === val);
    return b;
  };
  b.in = (col: string, vals: unknown[]) => {
    filters.push((r) => vals.includes(r[col]));
    return b;
  };
  b.is = (col: string, val: unknown) => {
    filters.push((r) => r[col] === val);
    return b;
  };
  b.not = (col: string, _op: string, val: unknown) => {
    filters.push((r) => r[col] !== val);
    return b;
  };
  const run = () => {
    const matched = [...store.rows.values()].filter((r) => filters.every((f) => f(r)));
    if (patch) {
      if (store.writeError) return { data: null, error: store.writeError };
      store.patches.push(patch);
      for (const r of matched) Object.assign(r, patch);
      return { data: matched.map((r) => ({ ...r })), error: null };
    }
    if (store.readError) return { data: null, error: store.readError };
    return { data: matched.map((r) => ({ ...r })), error: null };
  };
  b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(run()).then(onF, onR);
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({ from: () => builder() }),
}));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logged }));
const emitWebhook = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/webhooks/emit", () => ({ emitWebhook }));
vi.mock("@/lib/after-response", () => ({ afterResponse: vi.fn() }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: vi.fn(async () => {}) }));

import {
  writeRoutableState,
  writeBookable,
  defaultRoutableWriteDeps,
  BOOKABLE_TRAIT_UNRECORDED_COOLDOWN_MS,
  type RoutableWriteDeps,
} from "./routable-write";
import { bookableTraitUnrecordedAlert } from "@/lib/notify/misc-alert-copy";
import type { TraitEmission } from "./routable-trait";

const LEFT = "2026-09-20T12:00:00.000Z";

function seed(...rows: Partial<Row>[]) {
  store.rows.clear();
  for (const [i, r] of rows.entries()) {
    const full: Row = {
      id: `u-${i + 1}`,
      org_id: "org-1",
      email: `agent${i + 1}@trypennie.com`,
      bookable: false,
      deactivated_at: null,
      is_test: false,
      bookable_pending_since: null,
      ...r,
    };
    store.rows.set(full.id, full);
  }
}

function deps() {
  const emitted: TraitEmission[] = [];
  const notified: string[] = [];
  const d: RoutableWriteDeps = {
    emit: async (e) => {
      emitted.push(e);
    },
    notify: async (key) => {
      notified.push(key);
    },
  };
  return { d, emitted, notified };
}

beforeEach(() => {
  store.patches = [];
  store.readError = null;
  store.writeError = null;
  vi.clearAllMocks();
});

describe("the bookable flip", () => {
  it("making an active agent bookable writes the flip, settles the pending mark, and owes true", async () => {
    seed({ bookable: false, bookable_pending_since: "2026-09-01T00:00:00.000Z" });
    const { d, emitted } = deps();
    await writeRoutableState({ kind: "bookable", userId: "u-1", bookable: true }, d);
    expect(store.patches).toEqual([{ bookable: true, bookable_pending_since: null }]);
    expect(emitted).toEqual([
      { orgId: "org-1", userId: "u-1", email: "agent1@trypennie.com", slateBookable: true, suppressed: false },
    ]);
  });

  it("turning a routable agent off owes false", async () => {
    seed({ bookable: true });
    const { d, emitted } = deps();
    await writeRoutableState({ kind: "bookable", userId: "u-1", bookable: false }, d);
    // Switching OFF settles the pending mark too, so a human hold stops the
    // Salesforce sync retrying a decision already made (#2071).
    expect(store.patches).toEqual([{ bookable: false, bookable_pending_since: null }]);
    expect(store.rows.get("u-1")?.bookable).toBe(false);
    expect(emitted.map((e) => e.slateBookable)).toEqual([false]);
  });

  it("a repeat of a flip that already landed owes nothing", async () => {
    seed({ bookable: true });
    const { d, emitted } = deps();
    await writeRoutableState({ kind: "bookable", userId: "u-1", bookable: true }, d);
    expect(emitted).toEqual([]);
  });

  it("flipping bookable true on a deactivated row owes nothing: the derived value stays false", async () => {
    seed({ bookable: false, deactivated_at: LEFT });
    const { d, emitted } = deps();
    await writeRoutableState({ kind: "bookable", userId: "u-1", bookable: true }, d);
    expect(store.patches).toHaveLength(1);
    expect(emitted).toEqual([]);
  });

  it("an is_test agent's flip is owed as suppressed, so it is recorded and never POSTed", async () => {
    seed({ bookable: false, is_test: true, email: "smoke@trypennie.com" });
    const { d, emitted } = deps();
    await writeRoutableState({ kind: "bookable", userId: "u-1", bookable: true }, d);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].suppressed).toBe(true);
  });

  it("a refused write throws and owes nothing (#2482)", async () => {
    seed({ bookable: false });
    store.writeError = { message: "permission denied for table users" };
    const { d, emitted } = deps();
    await expect(
      writeRoutableState({ kind: "bookable", userId: "u-1", bookable: true }, d),
    ).rejects.toThrow(/permission denied/);
    expect(emitted).toEqual([]);
  });

  it("an unreadable before state refuses before writing anything", async () => {
    seed({ bookable: false });
    store.readError = { message: "connection reset" };
    const { d, emitted } = deps();
    await expect(
      writeRoutableState({ kind: "bookable", userId: "u-1", bookable: true }, d),
    ).rejects.toThrow(/connection reset/);
    expect(store.patches).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("writeBookable keeps its contract: resolves on success and names the user on a refusal", async () => {
    seed({ id: "u-42", bookable: false } as Partial<Row>);
    emitWebhook.mockClear();
    await expect(writeBookable("u-42", true)).resolves.toBeUndefined();
    store.writeError = { message: "nope" };
    await expect(writeBookable("u-42", false)).rejects.toThrow(/u-42/);
  });
});

describe("departure and return", () => {
  it("offboarding a routable agent stamps the departure, clears bookable, and owes false", async () => {
    seed({ bookable: true });
    const { d, emitted } = deps();
    const written = await writeRoutableState({ kind: "depart", userIds: ["u-1"], stampIso: LEFT }, d);
    expect(store.patches).toEqual([{ deactivated_at: LEFT, bookable: false }]);
    expect(written.map((r) => r.id)).toEqual(["u-1"]);
    expect(emitted.map((e) => [e.userId, e.slateBookable])).toEqual([["u-1", false]]);
  });

  it("a departure that lost its compare and swap writes nothing and owes nothing", async () => {
    seed({ bookable: false, deactivated_at: "2026-09-19T00:00:00.000Z" });
    const { d, emitted } = deps();
    const written = await writeRoutableState({ kind: "depart", userIds: ["u-1"], stampIso: LEFT }, d);
    expect(written).toEqual([]);
    expect(emitted).toEqual([]);
    expect(store.rows.get("u-1")?.deactivated_at).toBe("2026-09-19T00:00:00.000Z");
  });

  it("offboarding an agent who was not bookable owes nothing: they were already false", async () => {
    seed({ bookable: false });
    const { d, emitted } = deps();
    await writeRoutableState({ kind: "depart", userIds: ["u-1"], stampIso: LEFT }, d);
    expect(emitted).toEqual([]);
  });

  it("reactivation writes bookable false and owes nothing (#1324)", async () => {
    seed({ bookable: false, deactivated_at: LEFT });
    const { d, emitted } = deps();
    const written = await writeRoutableState({ kind: "return", userId: "u-1" }, d);
    expect(store.patches).toEqual([{ deactivated_at: null, bookable: false }]);
    expect(written.map((r) => r.id)).toEqual(["u-1"]);
    expect(emitted).toEqual([]);
  });

  it("the reap's batch owes one trait per agent who was routable, and none for the rest", async () => {
    seed({ bookable: true }, { bookable: false }, { bookable: true, is_test: true });
    const { d, emitted } = deps();
    await writeRoutableState({ kind: "depart", userIds: ["u-1", "u-2", "u-3"], stampIso: LEFT }, d);
    expect(emitted.map((e) => [e.userId, e.slateBookable, e.suppressed])).toEqual([
      ["u-1", false, false],
      ["u-3", false, true],
    ]);
  });

  it("an empty batch touches nothing", async () => {
    seed({ bookable: true });
    const { d, emitted } = deps();
    expect(await writeRoutableState({ kind: "depart", userIds: [], stampIso: LEFT }, d)).toEqual([]);
    expect(store.patches).toEqual([]);
    expect(emitted).toEqual([]);
  });
});

// #3700: Google refuses an advisor's calendar for a sustained period, so the sync
// lane takes them out of the pool and owes them a return through the activation
// gate. Not a departure: `deactivated_at` is never stamped.
describe("taking a refused advisor out with a return owed", () => {
  it("clears bookable, stamps the pending mark, leaves deactivated_at alone, and owes false", async () => {
    seed({ bookable: true });
    const { d, emitted } = deps();
    const written = await writeRoutableState({ kind: "hold-out", userId: "u-1", stampIso: LEFT }, d);
    expect(store.patches).toEqual([{ bookable: false, bookable_pending_since: LEFT }]);
    expect(written.map((r) => r.id)).toEqual(["u-1"]);
    expect(store.rows.get("u-1")?.deactivated_at).toBeNull();
    expect(emitted.map((e) => [e.userId, e.slateBookable])).toEqual([["u-1", false]]);
  });

  it("a second run against the same advisor matches nothing, so it writes and owes nothing", async () => {
    seed({ bookable: true });
    const first = deps();
    await writeRoutableState({ kind: "hold-out", userId: "u-1", stampIso: LEFT }, first.d);
    const second = deps();
    const written = await writeRoutableState(
      { kind: "hold-out", userId: "u-1", stampIso: "2026-09-20T12:01:00.000Z" },
      second.d,
    );
    expect(written).toEqual([]);
    expect(second.emitted).toEqual([]);
    // The first stamp stands: it is when the wait for the return began.
    expect(store.rows.get("u-1")?.bookable_pending_since).toBe(LEFT);
  });

  it("never touches a departed advisor", async () => {
    seed({ bookable: true, deactivated_at: "2026-09-19T00:00:00.000Z" });
    const { d, emitted } = deps();
    const written = await writeRoutableState({ kind: "hold-out", userId: "u-1", stampIso: LEFT }, d);
    expect(written).toEqual([]);
    expect(emitted).toEqual([]);
    expect(store.rows.get("u-1")?.bookable_pending_since).toBeNull();
  });
});

describe("a trait that could not be recorded", () => {
  it("does not fail the write that already committed, and pages per agent instead", async () => {
    seed({ bookable: true }, { bookable: true });
    const { d, notified } = deps();
    const cooldowns: number[] = [];
    const texts: string[] = [];
    d.notify = async (key, cooldownMs, text) => {
      notified.push(key);
      cooldowns.push(cooldownMs);
      texts.push(text);
    };
    let calls = 0;
    d.emit = async (e) => {
      calls++;
      if (e.userId === "u-1") throw new Error("webhook endpoints read failed: timeout");
    };
    const written = await writeRoutableState(
      { kind: "depart", userIds: ["u-1", "u-2"], stampIso: LEFT },
      d,
    );
    expect(written).toHaveLength(2);
    expect(calls).toBe(2);
    expect(notified).toEqual(["bookable_trait_unrecorded:u-1"]);
    // Once a day per agent at most, and the text is the real copy builder's.
    expect(cooldowns).toEqual([BOOKABLE_TRAIT_UNRECORDED_COOLDOWN_MS]);
    expect(BOOKABLE_TRAIT_UNRECORDED_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
    expect(texts[0]).toBe(bookableTraitUnrecordedAlert("agent1@trypennie.com", false));
    expect(logged.error).toHaveBeenCalledWith(
      "bookable-trait",
      expect.objectContaining({ user_id: "u-1", slate_bookable: false }),
      expect.any(Error),
    );
  });
});

describe("the default wiring", () => {
  it("records the trait through the webhook delivery path, suppressed for a test agent", async () => {
    await defaultRoutableWriteDeps.emit({
      orgId: "org-1",
      userId: "u-1",
      email: "smoke@trypennie.com",
      slateBookable: true,
      suppressed: true,
    });
    expect(emitWebhook).toHaveBeenCalledWith(
      "org-1",
      "agent.bookable_changed",
      { user_id: "u-1", email: "smoke@trypennie.com", slate_bookable: true },
      null,
      true,
      expect.any(Function),
    );
  });
});
