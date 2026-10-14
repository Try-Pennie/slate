// #3381: every stored bucket_slots row names the path that wrote it.
//
// On 2026-10-14 a refused confirm found its stored row offering the refused time on a
// row two minutes old. Two writers ran in the second that row was computed, the
// recompute lane and a Google push's refresh, and nothing recorded which. These pin the
// pure half: how a writer is stamped, how a coalesced refresh names every requester,
// and what a stored row is read back as, including a booking's splice since its
// compute (the re-offer of a window a move left is the one splice that ADDS times).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-slot-row-writer.ts
import {
  joinWriters,
  rowProvenance,
  stampWriter,
  WRITTEN_BY_FIELD,
} from "../src/lib/availability/slot-row-writer.ts";
import { splicePayload } from "../src/lib/availability/slot-splice.ts";
import { shapePrecomputedRow } from "../src/lib/availability/precompute-shape.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- stamping ---------------------------------------------------------------------
{
  const payload = { slots: ["2026-10-14T20:30:00.000Z"], orgName: "Pennie" };
  const stamped = stampWriter(payload, "lane");
  eq((stamped as Record<string, unknown>)[WRITTEN_BY_FIELD], "lane", "the writer is stamped into the payload");
  eq(stamped.slots, payload.slots, "and the slots are untouched");
  assert(!(WRITTEN_BY_FIELD in payload), "the caller's object is not mutated");
  eq(stampWriter(stampWriter(payload, "lane"), "push"), { ...payload, [WRITTEN_BY_FIELD]: "push" }, "a rewrite replaces the writer");
  eq(stampWriter(null, "lane"), null, "a payload that is not an object is left alone, never invented");

  // The read path strips the field by name and stays import free (precompute-shape.ts),
  // so this is what keeps the two spellings one: a renamed field would otherwise leak
  // the writer into every served and cached payload.
  const full = stampWriter({ bucket: { code: "112" }, eventType: {}, orgName: "Pennie", slots: [] }, "lane");
  const shaped = shapePrecomputedRow({ payload: full });
  assert(shaped !== null && !(WRITTEN_BY_FIELD in shaped), "the served payload never carries the writer field, by the constant's own name");
}

// --- a coalesced refresh names everybody it ran for -------------------------------
{
  eq(joinWriters(["refusal", "booking", "refusal"]), "booking+refusal", "sorted, deduplicated, joined");
  eq(joinWriters(["push"]), "push", "one requester is just its name");
  eq(joinWriters(["sweep:reconcile", "lane"]), "lane+sweep:reconcile", "a sweep keeps its label");
}

// --- reading a row back -----------------------------------------------------------
{
  eq(rowProvenance({ slots: [] }), { writtenBy: null, spliced: null }, "a row from before this shipped says not recorded, never a writer");
  eq(rowProvenance(null), { writtenBy: null, spliced: null }, "no payload, nothing recorded");
  eq(rowProvenance({ slots: [], writtenBy: 42 }), { writtenBy: null, spliced: null }, "an unreadable writer is not recorded, not a guess");
  eq(rowProvenance({ slots: [], writtenBy: "push" }).writtenBy, "push", "a stamped row names its writer");
}

// --- a splice since the compute is named, and a re-offer is told apart ------------
{
  const computedAtMs = Date.parse("2026-10-14T08:44:39.000Z");
  const fenceAtMs = Date.parse("2026-10-14T08:45:10.000Z");
  const row = stampWriter({ slots: ["2026-10-14T20:10:00.000Z", "2026-10-14T20:30:00.000Z"] }, "lane");
  const w = { fromMs: Date.parse("2026-10-14T20:00:00.000Z"), lastStartMs: Date.parse("2026-10-14T20:40:00.000Z") };

  const taken = splicePayload(row, [{ w, judge: { slots: ["2026-10-14T20:10:00.000Z"] } }], fenceAtMs, computedAtMs);
  eq(
    rowProvenance(taken),
    { writtenBy: "lane", spliced: "2026-10-14T08:45:10.000Z" },
    "a booking's splice keeps the compute's writer and names when it was spliced",
  );

  const moved = splicePayload(
    row,
    [{ w, judge: { slots: ["2026-10-14T20:10:00.000Z", "2026-10-14T20:30:00.000Z"] }, reoffer: true }],
    fenceAtMs,
    computedAtMs,
  );
  eq(
    rowProvenance(moved),
    { writtenBy: "lane", spliced: "2026-10-14T08:45:10.000Z+reoffer" },
    "a move's re-offer, the one splice that can add a time, is marked as one",
  );
}

finish();
