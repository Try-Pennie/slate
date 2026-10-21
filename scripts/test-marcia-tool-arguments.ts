// #4013: every argument a booking tool declares to Marcia changes what the operation
// does, and every argument it does not declare is refused, so none is silently ignored.
//
// Live 2026-10-21: find_times declared `from` and ignored it, so a lead asked for "3pm
// tomorrow" was moved to 3:10 PM the same day. Nothing failed: the schema said the
// argument existed, the operation never read it, and the answer looked like any other.
//
// Three holds:
//   1. The tool registry the MCP Worker lists (`worker/mcp-booking/registry.ts`) declares
//      exactly the arguments `MARCIA_OPERATION_ARGS` names for each operation, which is
//      the list the operations themselves refuse anything outside of.
//   2. Every declared argument has a PROBE here, enumerated from that list, and the
//      probe shows the answer, or the write the operation makes, differs with the
//      argument changed. A new argument with no probe fails this suite, and so does an
//      argument whose probe changes nothing (the `from` defect).
//   3. An argument no tool declares, and a declared one sent where it would mean
//      nothing (a detail on a reason that records none, declined times on a reason that
//      reads none), is refused `args_invalid` naming it, and nothing is written.
//
// What is OBSERVED is the answer plus the arguments of every write (`book`, `cancel`),
// never the reads: the fake slot read ignores `from` as the real cached one used to,
// so a probe that counted the read's arguments would pass on the defect itself.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-marcia-tool-arguments.ts
import { runMarciaOperation, type MarciaAnswer, type MarciaDeps } from "../src/lib/mcp-booking/operations.ts";
import { MARCIA_OPERATIONS, MARCIA_OPERATION_ARGS, type MarciaOperation } from "../src/lib/mcp-booking/operation-names.ts";
import type { MarciaLeadClaims } from "../src/lib/mcp-booking/token-shape.ts";
import { BOOKING_TOOLS } from "../worker/mcp-booking/registry.ts";
import { makeMarciaFake } from "./lib/marcia-fake-service.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z"); // 07:00 CDT
const cdt = (local: string) => new Date(Date.parse(`${local}:00-05:00`)).toISOString();
// Every half hour from 08:00 to 19:30 CDT on 1 and 2 June: two days, so `from` has a
// day to move to, and a whole day, so `near` has a time of day to move to.
const SLOTS: string[] = [];
for (const day of ["2026-06-01", "2026-06-02"]) {
  for (let h = 8; h <= 19; h++) for (const m of ["00", "30"]) SLOTS.push(cdt(`${day}T${String(h).padStart(2, "0")}:${m}`));
}

const claims = (): MarciaLeadClaims => ({
  iss: "marcia",
  aud: "slate-booking",
  iat: Math.floor(NOW / 1000),
  exp: Math.floor(NOW / 1000) + 600,
  nonce: "probe-nonce-000000000001",
  salesforce_id: "00Q000000000000AAA",
  bucket_code: "411",
  name: "Fixture Lead",
  email: "fixture.lead@example.com",
  phone: "+15555550100",
  time_zone: "America/Chicago",
  test: false,
});

type Fake = ReturnType<typeof makeMarciaFake>;
type Args = Record<string, unknown>;

/** A fresh world, with the deps wrapped so every write's arguments are recorded. */
function world(setup: (f: Fake) => void = () => {}) {
  const fake = makeMarciaFake({ nowMs: NOW, slots: SLOTS });
  setup(fake);
  const writes: unknown[] = [];
  const deps: MarciaDeps = {
    ...fake.deps,
    book: async (input) => {
      writes.push(["book", input]);
      return fake.deps.book(input);
    },
    cancel: async (input) => {
      writes.push(["cancel", input]);
      return fake.deps.cancel(input);
    },
  };
  return { fake, deps, writes };
}

/** The slot ids find_times offers in a world, so a write probe can name real ones. */
async function offered(deps: MarciaDeps, args: Args = {}): Promise<string[]> {
  const a = await runMarciaOperation("find_times", args, claims(), deps);
  return a.ok ? (a.data.times as { slot_id: string }[]).map((t) => t.slot_id) : [];
}

const holdsTwo = (f: Fake) => {
  f.seedBooking({ salesforceId: "00Q000000000000AAA", externalId: null, startsAt: cdt("2026-06-02T09:00") });
  f.seedBooking({ salesforceId: "00Q000000000000AAA", externalId: null, startsAt: cdt("2026-06-02T11:00") });
};
const holdsOne = (f: Fake) => f.seedBooking({ salesforceId: "00Q000000000000AAA", externalId: null, startsAt: cdt("2026-06-02T11:00") });

interface Probe {
  /** What the lead already holds before the call. */
  setup?: (f: Fake) => void;
  /** The two argument sets: the same call, with this one argument changed. */
  pair(deps: MarciaDeps): Promise<[Args, Args]>;
}

/**
 * One probe per declared argument. Typed by `MARCIA_OPERATION_ARGS`, so an argument
 * added to an operation without a probe here does not compile, and the loop below
 * checks the same thing at run time for anything `tsc` cannot see.
 */
const PROBES: { [Op in MarciaOperation]: Record<(typeof MARCIA_OPERATION_ARGS)[Op][number], Probe> } = {
  find_times: {
    time_zone: { pair: async () => [{}, { time_zone: "America/New_York" }] },
    from: { pair: async () => [{}, { from: "2026-06-02" }] },
    near: { pair: async () => [{ from: "2026-06-02" }, { from: "2026-06-02", near: "15:00" }] },
  },
  book: {
    slot_id: {
      pair: async (deps) => {
        const ids = await offered(deps);
        return [{ slot_id: ids[0] }, { slot_id: ids[1] }];
      },
    },
    time_zone: {
      pair: async (deps) => {
        const id = (await offered(deps))[0];
        return [{ slot_id: id }, { slot_id: id, time_zone: "America/New_York" }];
      },
    },
  },
  lookup: {
    time_zone: { setup: holdsOne, pair: async () => [{}, { time_zone: "America/New_York" }] },
  },
  move: {
    slot_id: {
      setup: holdsOne,
      pair: async (deps) => {
        const ids = await offered(deps);
        return [{ slot_id: ids[0] }, { slot_id: ids[1] }];
      },
    },
    time_zone: {
      setup: holdsOne,
      pair: async (deps) => {
        const id = (await offered(deps))[0];
        return [{ slot_id: id }, { slot_id: id, time_zone: "America/New_York" }];
      },
    },
  },
  cancel: {
    reason_code: { setup: holdsOne, pair: async () => [{ reason_code: "no_longer_interested" }, { reason_code: "booked_by_mistake" }] },
    reason_detail: {
      setup: holdsOne,
      pair: async () => [
        { reason_code: "other", reason_detail: "moving abroad" },
        { reason_code: "other", reason_detail: "found a lender" },
      ],
    },
    booking_id: { setup: holdsTwo, pair: async () => [{ reason_code: "no_longer_interested", booking_id: "seed1" }, { reason_code: "no_longer_interested", booking_id: "seed2" }] },
    declined_slot_ids: {
      setup: holdsOne,
      pair: async (deps) => [{ reason_code: "schedule_conflict" }, { reason_code: "schedule_conflict", declined_slot_ids: [(await offered(deps))[0]] }],
    },
    time_zone: { setup: holdsOne, pair: async () => [{ reason_code: "no_longer_interested" }, { reason_code: "no_longer_interested", time_zone: "America/New_York" }] },
  },
};

/** Run one call in a fresh world and return what it observably did. */
async function observe(op: MarciaOperation, probe: Probe, pick: 0 | 1): Promise<{ answer: MarciaAnswer; writes: unknown[] }> {
  const w = world(probe.setup);
  const args = (await probe.pair(w.deps))[pick];
  w.writes.length = 0; // the slot ids were found by a read; only this call's writes count
  const answer = await runMarciaOperation(op, args, claims(), w.deps);
  return { answer, writes: w.writes };
}

// --- 1. the registry declares exactly the operations' arguments -------------------------
for (const op of MARCIA_OPERATIONS) {
  const tool = BOOKING_TOOLS.find((t) => t.name === op);
  assert(tool !== undefined, `${op}: the registry lists a tool for it`);
  if (!tool) continue;
  eq(Object.keys(tool.inputSchema.properties).sort(), [...MARCIA_OPERATION_ARGS[op]].sort(), `${op}: the tool declares exactly the arguments the operation takes`);
  for (const r of tool.inputSchema.required ?? []) {
    assert((MARCIA_OPERATION_ARGS[op] as readonly string[]).includes(r), `${op}: required argument ${r} is one it takes`);
  }
  eq(tool.inputSchema.additionalProperties, false, `${op}: the schema itself says nothing else may be sent`);
}

// --- 2. every declared argument changes the result -------------------------------------
for (const op of MARCIA_OPERATIONS) {
  const probes = PROBES[op] as Record<string, Probe>;
  for (const arg of MARCIA_OPERATION_ARGS[op]) {
    const probe = probes[arg];
    assert(probe !== undefined, `${op}.${arg}: a declared argument has a probe proving it changes the result`);
    if (!probe) continue;
    const a = await observe(op, probe, 0);
    const again = await observe(op, probe, 0);
    const b = await observe(op, probe, 1);
    // The control: the same call twice observes the same, so a difference below is the
    // argument's doing and not noise in the world.
    eq(JSON.stringify(again), JSON.stringify(a), `${op}.${arg}: the probe's own call is repeatable`);
    assert(a.answer.ok || b.answer.ok, `${op}.${arg}: the probe reaches the operation (at least one side succeeds)`);
    assert(JSON.stringify(a) !== JSON.stringify(b), `${op}.${arg}: changing it changes the answer or the write, so it is not silently ignored`);
  }
  for (const arg of Object.keys(probes)) {
    assert((MARCIA_OPERATION_ARGS[op] as readonly string[]).includes(arg), `${op}.${arg}: a probe names an argument the operation declares`);
  }
}

// --- 3. anything not honoured is refused, naming it, and nothing is written ------------
async function refused(op: MarciaOperation, setup: ((f: Fake) => void) | undefined, args: (deps: MarciaDeps) => Promise<Args>, named: string, what: string) {
  const w = world(setup);
  const a = await args(w.deps);
  w.writes.length = 0;
  const answer = await runMarciaOperation(op, a, claims(), w.deps);
  eq(answer.ok ? null : answer.code, "args_invalid", `${what}: refused args_invalid`);
  eq(answer.ok ? null : answer.invalid_argument, named, `${what}: the refusal names ${named}`);
  assert(!answer.ok && typeof answer.argument_problem === "string" && answer.argument_problem.includes(named), `${what}: and says what is wrong with it`);
  eq(w.writes.length, 0, `${what}: nothing is written`);
}

// A valid call per operation, so the only thing wrong with each is the extra argument.
const VALID: Record<MarciaOperation, { setup?: (f: Fake) => void; args: (deps: MarciaDeps) => Promise<Args> }> = {
  find_times: { args: async () => ({}) },
  book: { args: async (deps) => ({ slot_id: (await offered(deps))[0] }) },
  lookup: { setup: holdsOne, args: async () => ({}) },
  move: { setup: holdsOne, args: async (deps) => ({ slot_id: (await offered(deps))[0] }) },
  cancel: { setup: holdsOne, args: async () => ({ reason_code: "no_longer_interested" }) },
};
for (const op of MARCIA_OPERATIONS) {
  const v = VALID[op];
  // The control: the same call without the extra argument is not refused.
  const w = world(v.setup);
  const control = await runMarciaOperation(op, await v.args(w.deps), claims(), w.deps);
  assert(control.ok, `${op}: the valid call the refusals are built from succeeds`);
  await refused(op, v.setup, async (deps) => ({ ...(await v.args(deps)), date: "2026-06-02" }), "date", `${op} with an argument no tool declares`);
}
await refused("find_times", undefined, async () => ({ slot_id: "anything" }), "slot_id", "find_times with another tool's argument");
await refused(
  "cancel",
  holdsOne,
  async () => ({ reason_code: "no_longer_interested", reason_detail: "moving abroad" }),
  "reason_detail",
  "cancel with a detail on a reason that records none",
);
await refused(
  "cancel",
  holdsOne,
  async (deps) => ({ reason_code: "no_longer_interested", declined_slot_ids: [(await offered(deps))[0]] }),
  "declined_slot_ids",
  "cancel with declined times on a reason that reads none",
);

// A declared argument of the wrong type was read as absent; it is refused by name too.
await refused("cancel", holdsOne, async () => ({ reason_code: "other", reason_detail: 5 }), "reason_detail", "cancel with a detail that is not text");
await refused("cancel", holdsTwo, async () => ({ reason_code: "no_longer_interested", booking_id: 2 }), "booking_id", "cancel with a booking id that is not text");
await refused("cancel", holdsOne, async () => ({ reason_code: "schedule_conflict", declined_slot_ids: "one" }), "declined_slot_ids", "cancel with declined times that are not a list");
await refused("find_times", undefined, async () => ({ time_zone: "Not/AZone" }), "time_zone", "find_times with a zone that is not one");
await refused("find_times", undefined, async () => ({ from: "next friday" }), "from", "find_times with a from that is not a date");
await refused("find_times", undefined, async () => ({ near: "3pm" }), "near", "find_times with a near that is not HH:MM");

// An empty value is no value: these are not refused.
{
  const w = world(holdsOne);
  const a = await runMarciaOperation("cancel", { reason_code: "no_longer_interested", reason_detail: "", declined_slot_ids: [] }, claims(), w.deps);
  assert(a.ok, "an empty detail and an empty list on a reason that reads neither are no value, not refused");
}

finish();
