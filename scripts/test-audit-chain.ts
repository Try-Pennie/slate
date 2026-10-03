// #3090: the audit_log hash chain verifier, offline.
//
// The database half (migration 0160) is proved in a real Postgres by
// `pnpm verify:audit-chain-sql`, which needs Docker. This suite runs on every push
// and holds the Worker half to what that command MEASURED: the pinned vector in
// scripts/lib/audit-chain-vector.ts is a hash Postgres produced, so an encoding that
// drifts here fails the build instead of shipping a monitor that pages on every row.
//
// Then every branch of the walk and of the lane's runner, each through hand built
// chains whose hashes come from the real link function:
//
//   - an intact chain walks to the end in pieces, anchors, and starts again;
//   - each of the four breaks (altered, missing, rewritten, truncated) is named, and
//     a broken tick neither moves the position nor clears anything;
//   - a read or write that throws, and a row this cannot hash, are unmeasured: they
//     page nothing and clear nothing (#1134, #1152);
//   - the all clear hangs only off a COMPLETE walk, never a tick part way through.
import { assert, eq, finish } from "./lib/harness.ts";
import { AUDIT_CHAIN_VECTOR } from "./lib/audit-chain-vector.ts";
import {
  AUDIT_CHAIN_GENESIS,
  AUDIT_CHAIN_KEY,
  AUDIT_CHAIN_ROWS_PER_TICK,
  AUDIT_CHAIN_START,
  chainContent,
  chainField,
  chainLink,
  epochMicros,
  formatAuditChainBrokenAlert,
  formatAuditChainRecovery,
  runAuditChainCheck,
  walkAuditChain,
  type AuditChainPosition,
  type AuditChainRow,
} from "@/lib/monitor/audit-chain";

// --- the encoding, against what Postgres measured --------------------------------
const v = AUDIT_CHAIN_VECTOR;
eq(await chainLink(v.prev, v.row), v.hash, "the Worker reproduces the hash Postgres gave the pinned row");
eq(chainField(null), "~", "a null is a lone tilde");
eq(chainField(""), "0:", "an empty string is a zero length, so it differs from a null");
eq(chainField("café"), "5:café", "a length counts UTF-8 bytes, as octet_length does, not UTF-16 units");
eq(chainField("\u{1F600}"), "4:\u{1F600}", "and a character outside the BMP is four bytes, not two units");
assert(
  chainContent(v.prev, { ...v.row, action: "a", target_id: "b" }) !== chainContent(v.prev, { ...v.row, action: "a1:b", target_id: null }),
  "moving text across a field boundary changes the hashed text",
);

eq(epochMicros("2026-10-03T12:34:56.000123+00:00"), "1791030896000123", "microseconds survive, which Date would drop");
eq(epochMicros("2026-10-03T12:34:56+00:00"), "1791030896000000", "a whole second, which Postgres renders with no fraction");
eq(epochMicros("2026-10-03T05:34:56.5-07:00"), "1791030896500000", "a negative offset is the same instant");
eq(epochMicros("2026-10-03T18:04:56.5+05:30"), "1791030896500000", "and a half hour one");
eq(epochMicros("2026-10-03T12:34:56.5Z"), "1791030896500000", "and Z");
eq(epochMicros("1969-12-31T23:59:59.5+00:00"), "-500000", "before the epoch, as Postgres's extract gives it");
eq(epochMicros("infinity"), null, "anything that is not a timestamp is unreadable");
eq(epochMicros("2026-10-03"), null, "and so is a bare date");

// --- chains to walk ----------------------------------------------------------------
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function chain(n: number): Promise<AuditChainRow[]> {
  const rows: AuditChainRow[] = [];
  let prev = AUDIT_CHAIN_GENESIS;
  for (let i = 1; i <= n; i++) {
    const row: AuditChainRow = {
      id: id(i),
      org_id: id(0),
      actor_id: i % 3 === 0 ? null : id(900),
      action: `action.${i}`,
      target_id: null,
      details: `{"i": ${i}}`,
      created_at: `2026-10-0${1 + (i % 3)}T10:00:0${i % 10}.12345+00:00`,
      chain_seq: i,
      chain_hash: "",
    };
    row.chain_hash = (await chainLink(prev, row)) ?? "";
    prev = row.chain_hash;
    rows.push(row);
  }
  return rows;
}

/** The rows a tick would read: after the position, ascending, at most `limit`. */
const page = (rows: AuditChainRow[], at: AuditChainPosition, limit: number) =>
  rows.filter((r) => r.chain_seq > at.passSeq).slice(0, limit);

async function walkToEnd(rows: AuditChainRow[], at: AuditChainPosition, limit: number) {
  let ticks = 0;
  for (;;) {
    ticks++;
    const walk = await walkAuditChain(at, page(rows, at, limit), limit);
    if (walk.status !== "progressing") return { walk, ticks };
    at = walk.next;
  }
}

const ten = await chain(10);

// --- an intact chain --------------------------------------------------------------
const first = await walkAuditChain(AUDIT_CHAIN_START, page(ten, AUDIT_CHAIN_START, 4), 4);
eq(first.status, "progressing", "a full page means the walk is not at the end yet");
eq(first.status === "progressing" ? first.next : null, { ...AUDIT_CHAIN_START, passSeq: 4, passHash: ten[3].chain_hash }, "and moves to the last row it verified");

const whole = await walkToEnd(ten, AUDIT_CHAIN_START, 4);
eq(whole.ticks, 3, "ten rows four at a time is three ticks");
eq(whole.walk.status, "intact", "an untouched chain verifies to the end");
const anchored = whole.walk.status === "intact" ? whole.walk.next : AUDIT_CHAIN_START;
eq(anchored, { passSeq: 0, passHash: AUDIT_CHAIN_GENESIS, anchorSeq: 10, anchorHash: ten[9].chain_hash }, "a complete walk anchors the end and starts the next walk from the beginning");

const exact = await walkToEnd(ten, AUDIT_CHAIN_START, 5);
eq([exact.walk.status, exact.ticks], ["intact", 3], "a chain that ends exactly on a page boundary needs one empty read to know it ended");

const grown = await chain(12);
eq((await walkToEnd(grown, anchored, 4)).walk.status, "intact", "rows added after the anchor are simply walked onto");

const empty = await walkAuditChain(AUDIT_CHAIN_START, [], 4);
eq(empty.status === "intact" ? empty.throughSeq : -1, 0, "an empty trail with nothing anchored is intact through nothing");

// --- the four breaks ----------------------------------------------------------------
const altered = ten.map((r) => (r.chain_seq === 6 ? { ...r, details: '{"i": 600}' } : r));
const a = (await walkToEnd(altered, anchored, 4)).walk;
eq(a.status === "broken" ? a.break : null, { kind: "altered", seq: 6, id: id(6) }, "an edited row is caught at that row");
eq(a.status === "broken" ? a.checked : -1, 1, "after verifying the rows before it on that tick");

const stuck = await walkAuditChain({ ...anchored, passSeq: 4, passHash: ten[3].chain_hash }, page(altered, { ...anchored, passSeq: 4 }, 4), 4);
eq(stuck.status, "broken", "the next tick re-reads the same rows and finds the same break");

const missing = ten.filter((r) => r.chain_seq !== 7);
const m = (await walkToEnd(missing, anchored, 4)).walk;
eq(m.status === "broken" ? m.break : null, { kind: "missing", expectedSeq: 7, foundSeq: 8, id: id(8) }, "a deleted row is caught as a skip in the sequence");

// The careful edit: change row 3 and recompute every hash after it.
const rewritten: AuditChainRow[] = [];
{
  let prev = AUDIT_CHAIN_GENESIS;
  for (const r of ten) {
    const row = r.chain_seq === 3 ? { ...r, action: "innocent" } : { ...r };
    row.chain_hash = (await chainLink(prev, row)) ?? "";
    prev = row.chain_hash;
    rewritten.push(row);
  }
}
const rw = (await walkToEnd(rewritten, anchored, 4)).walk;
eq(rw.status === "broken" ? rw.break : null, { kind: "rewritten", seq: 10, id: id(10) }, "a recomputed chain is caught at the anchor");
eq((await walkToEnd(rewritten, AUDIT_CHAIN_START, 4)).walk.status, "intact", "control: with no anchor the same chain verifies, which is the anchor's whole job");

const cut = ten.slice(0, 7);
const t = (await walkToEnd(cut, anchored, 4)).walk;
eq(t.status === "broken" ? t.break : null, { kind: "truncated", anchorSeq: 10, lastSeq: 7 }, "rows cut off the end are caught against the anchor");
const allGone = await walkAuditChain(anchored, [], 4);
eq(allGone.status === "broken" ? allGone.break.kind : null, "truncated", "and so is a trail that now reads empty");

const badStamp = ten.map((r) => (r.chain_seq === 2 ? { ...r, created_at: "infinity" } : r));
eq((await walkToEnd(badStamp, anchored, 4)).walk.status, "unreadable", "a row with a timestamp this cannot read is unmeasured, never a break");

// --- the copy -----------------------------------------------------------------------
const copies = [
  formatAuditChainBrokenAlert({ kind: "altered", seq: 6, id: id(6) }),
  formatAuditChainBrokenAlert({ kind: "missing", expectedSeq: 7, foundSeq: 8, id: id(8) }),
  formatAuditChainBrokenAlert({ kind: "rewritten", seq: 10, id: id(10) }),
  formatAuditChainBrokenAlert({ kind: "truncated", anchorSeq: 10, lastSeq: 7 }),
];
eq(new Set(copies).size, 4, "each break reads differently");
assert(copies.every((c) => c.includes("Do not repair the row")), "every page says not to destroy the evidence");
assert(copies[0].includes("entry 6") && copies[0].includes(id(6)), "the page names the entry and its row id");
assert(formatAuditChainRecovery(10).includes("entry 10"), "the all clear says how far it verified");
assert(!/[\u2014\u2013]/.test(copies.join(" ") + formatAuditChainRecovery(1)), "no dash in the copy");
assert(AUDIT_CHAIN_ROWS_PER_TICK < 1000, "a tick reads under one PostgREST page");

// --- the runner -----------------------------------------------------------------------
interface Harness {
  stored: AuditChainPosition | null;
  notified: string[];
  resolved: string[];
}

function deps(rows: AuditChainRow[], h: Harness, over: Partial<Parameters<typeof runAuditChainCheck>[0]> = {}) {
  return {
    loadPosition: async () => h.stored,
    loadRows: async (after: number, limit: number) => rows.filter((r) => r.chain_seq > after).slice(0, limit),
    savePosition: async (p: AuditChainPosition) => {
      h.stored = p;
    },
    notify: async (key: string, _ms: number, text: string) => {
      h.notified.push(`${key}: ${text}`);
    },
    resolve: async (key: string, text: string) => {
      h.resolved.push(`${key}: ${text}`);
      return true;
    },
    cooldownMs: 60_000,
    limit: 4,
    ...over,
  };
}

const fresh = (): Harness => ({ stored: null, notified: [], resolved: [] });

{
  const h = fresh();
  const r1 = await runAuditChainCheck(deps(ten, h));
  eq(r1.status, "progressing", "a first tick on a never run verifier starts from the beginning");
  eq(h.stored?.passSeq, 4, "and stores where it got to");
  eq([h.notified.length, h.resolved.length], [0, 0], "part way through a walk it neither pages nor clears");
  await runAuditChainCheck(deps(ten, h));
  const r3 = await runAuditChainCheck(deps(ten, h));
  eq(r3.status === "intact" ? r3.throughSeq : -1, 10, "the third tick completes the walk");
  eq(h.resolved.length, 1, "and only a complete walk sends the all clear");
  assert(h.resolved[0].startsWith(`${AUDIT_CHAIN_KEY}: `), "on the chain's own key");
  eq(h.stored, { passSeq: 0, passHash: AUDIT_CHAIN_GENESIS, anchorSeq: 10, anchorHash: ten[9].chain_hash }, "and stores the new anchor");

  // The next walk's first tick verifies rows 1 to 4; the edited row 6 is met on the second.
  eq((await runAuditChainCheck(deps(altered, h))).status, "progressing", "the next walk starts again from the beginning");
  eq((await runAuditChainCheck(deps(altered, h))).status, "broken", "and meets the edited row");
  eq(h.notified.length, 1, "and pages once on it");
  assert(h.notified[0].startsWith(`${AUDIT_CHAIN_KEY}: `), "on the chain's own key");
  const held = h.stored;
  await runAuditChainCheck(deps(altered, h));
  eq(h.stored, held, "a broken tick does not move the position");
  eq(h.notified.length, 2, "so the next tick pages again, paced by the cooldown");
  eq(h.resolved.length, 1, "and nothing is cleared while it is broken");
}

{
  const h = fresh();
  h.stored = anchored;
  const r = await runAuditChainCheck(deps(ten, h, { loadRows: async () => Promise.reject(new Error("read refused")) }));
  eq(r, { status: "unmeasured", why: "read refused" }, "a failed read is unmeasured");
  eq([h.notified.length, h.resolved.length], [0, 0], "and pages nothing and clears nothing");
  eq(h.stored, anchored, "and moves nothing");
}

{
  const h = fresh();
  const r = await runAuditChainCheck(deps(ten, h, { loadPosition: async () => Promise.reject(new Error("no table")) }));
  eq(r.status, "unmeasured", "a failed position read is unmeasured, never a walk from the start");
  eq(h.resolved.length, 0, "and clears nothing");
}

{
  const h = fresh();
  h.stored = { ...anchored, passSeq: 8, passHash: ten[7].chain_hash };
  const r = await runAuditChainCheck(deps(ten, h, { savePosition: async () => Promise.reject(new Error("write refused")) }));
  eq(r.status, "unmeasured", "a walk that cannot store its result is unmeasured");
  eq(h.resolved.length, 0, "so the all clear it would have sent is not sent");
}

{
  const h = fresh();
  h.stored = anchored;
  const r = await runAuditChainCheck(deps(badStamp, h));
  eq(r.status, "unmeasured", "an unreadable row is unmeasured");
  eq([h.notified.length, h.resolved.length], [0, 0], "and neither pages nor clears");
}

{
  const h = fresh();
  h.stored = anchored;
  const r = await runAuditChainCheck(
    deps(cut, h, { limit: 20, notify: async () => Promise.reject(new Error("slack down")) }),
  );
  eq(r.status, "broken", "a page that fails to send still reports the break");
}

finish();
