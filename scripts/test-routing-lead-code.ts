// Routing a lead whose link carried no usable code, from Salesforce (#2638).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-routing-lead-code.ts
//
// On trypennie.com the XBC exists only while the offers page is open, so a lead
// who reaches booking another way arrives with none and was sent to the Low pool
// (the catch-all, #1908). An Ultra High lead booked with the Low team that way on
// 2026-09-21. When the link names the lead, Slate now asks Salesforce for the
// lead's `XBC__c` (confirmed on the Lead object by a describe call, 2026-09-25)
// and routes on it. Only when Salesforce holds no routable code does the
// catch-all apply, and a Salesforce read that FAILS refuses rather than falling
// through to it, because that fall through is the misroute this exists to stop.
import {
  resolveRoutingCode,
  LeadCodeUnavailableError,
  type LeadXbcReader,
} from "../src/lib/routing/lead-code.ts";
import { CATCHALL_CODE } from "../src/lib/routing/catchall.ts";
import { PUBLIC_TEST_BUCKET_CODES } from "../src/lib/embed/public-test-bucket.ts";
import { createBooking } from "../src/lib/booking/orchestration.ts";
import { assert, finish } from "./lib/harness.ts";
import { makeDeps, input } from "./lib/booking-fakes.ts";

const LEAD = "00Q5e00000AbCdEEAU";

/** A reader answering from a table, recording every id it was asked about. */
function reader(table: Record<string, string | null>): LeadXbcReader & { asked: string[] } {
  const asked: string[] = [];
  const fn = (async (id: string) => {
    asked.push(id);
    return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined;
  }) as LeadXbcReader & { asked: string[] };
  fn.asked = asked;
  return fn;
}

const failing: LeadXbcReader = async () => {
  throw new Error("SF query failed: 503 unavailable");
};

async function main() {
  // --- no code on the link, Salesforce holds 512: route to 512 ---
  {
    const r = reader({ [LEAD]: "512" });
    const res = await resolveRoutingCode("", LEAD, r);
    assert(res.code === "512", "a blank link code with Salesforce holding 512 routes to 512");
    assert(res.source === "salesforce", "and says the code came from Salesforce");
    assert(r.asked.length === 1 && r.asked[0] === LEAD, "Salesforce was asked about exactly that lead");
    assert(
      res.record.source === "salesforce" && res.record.salesforce_xbc === "512" && res.record.requested === "",
      "the record carries what the link sent and what Salesforce held",
    );
  }

  // --- an UNREADABLE link code is rescued the same way ---
  {
    const res = await resolveRoutingCode("null11", LEAD, reader({ [LEAD]: " 312 " }));
    assert(res.code === "312", "an unreadable link code routes on the Salesforce code, trimmed");
    assert(res.record.source === "salesforce" && res.record.requested === "null11", "keeping the raw link value");
  }

  // --- a valid link code is never second guessed, and Salesforce is not asked ---
  {
    const r = reader({ [LEAD]: "512" });
    const res = await resolveRoutingCode("211", LEAD, r);
    assert(res.code === "211" && res.source === "link", "a routable link code is used as sent");
    assert(r.asked.length === 0, "and Salesforce is not asked at all");
  }

  // --- Salesforce holds no code: the catch-all, RECORDED with why ---
  {
    const res = await resolveRoutingCode("", LEAD, reader({ [LEAD]: null }));
    assert(res.code === CATCHALL_CODE && res.source === "catchall", "no code anywhere takes the catch-all");
    assert(
      res.record.source === "catchall" &&
        res.record.reason === "absent" &&
        res.record.salesforce === "absent" &&
        res.record.salesforce_xbc === null,
      "and records that the link had none and Salesforce had none",
    );
  }
  {
    const res = await resolveRoutingCode("", LEAD, reader({ [LEAD]: "012" }));
    assert(res.code === CATCHALL_CODE, "a Salesforce code Slate cannot route (tier 0) takes the catch-all");
    assert(
      res.record.source === "catchall" && res.record.salesforce === "unreadable" && res.record.salesforce_xbc === "012",
      "and records the value Salesforce held, so the cause can be chased",
    );
  }
  {
    const res = await resolveRoutingCode("", LEAD, reader({}));
    assert(
      res.code === CATCHALL_CODE && res.record.source === "catchall" && res.record.salesforce === "not-found",
      "a lead Salesforce did not return takes the catch-all, recorded as not found",
    );
  }
  {
    const r = reader({});
    const res = await resolveRoutingCode("", null, r);
    assert(
      res.code === CATCHALL_CODE && res.record.source === "catchall" && res.record.salesforce === "no-lead-id",
      "a link naming no lead takes the catch-all, recorded as having no lead id",
    );
    assert(r.asked.length === 0, "and Salesforce is not asked");
  }
  {
    const r = reader({});
    const res = await resolveRoutingCode("", "003AB0000012345", r);
    assert(
      res.record.source === "catchall" && res.record.salesforce === "no-lead-id" && r.asked.length === 0,
      "an id that is not a Lead id (a Contact) is never sent to the Lead query",
    );
  }

  // --- Salesforce must never route a lead into a test bucket ---
  {
    const res = await resolveRoutingCode("", LEAD, reader({ [LEAD]: PUBLIC_TEST_BUCKET_CODES[0] }));
    assert(res.code === CATCHALL_CODE, "a Salesforce value naming the public test bucket is not routed on");
  }

  // --- a failed Salesforce read REFUSES, never falls through ---
  {
    let thrown: unknown = null;
    try {
      await resolveRoutingCode("", LEAD, failing);
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof LeadCodeUnavailableError, "a failed Salesforce read throws LeadCodeUnavailableError");
    assert(
      thrown instanceof LeadCodeUnavailableError && /try again/i.test(thrown.message),
      "carrying a retriable sentence for the lead",
    );
    assert(
      thrown instanceof LeadCodeUnavailableError && String((thrown.cause as Error)?.message).includes("503"),
      "with the Salesforce error kept as its cause for the log",
    );
  }
}

// --- the booker confirm, through createBooking with the Salesforce reader injected ---
// The pure resolver above is only half: these prove the confirm ROUTES on its
// answer, RECORDS it on the booking, and writes nothing when the read fails.
async function confirmPath() {
  const booker = { ...input, salesforceId: LEAD, bucketCode: CATCHALL_CODE, requestedCode: "" };
  const traceOf = (row: Record<string, unknown> | undefined) =>
    (row?.routing_trace ?? null) as { code_source?: Record<string, unknown> } | null;

  {
    const { deps, calls } = makeDeps({ leadXbc: { [LEAD]: "512" } });
    await createBooking(booker, deps);
    assert(calls.readLeadXbc.length === 1 && calls.readLeadXbc[0] === LEAD, "confirm: Salesforce is asked about the lead");
    assert(calls.resolveBucketByCode[0] === "512", "confirm: SF code 512 routes to bucket 512, not the posted catch-all");
    const cs = traceOf(calls.insertBooking[0])?.code_source;
    assert(
      cs?.source === "salesforce" && cs.salesforce_xbc === "512" && cs.requested === "",
      "confirm: the booking records that the code came from Salesforce",
    );
  }
  {
    const { deps, calls } = makeDeps({ leadXbc: { [LEAD]: null } });
    await createBooking({ ...booker, bucketCode: PUBLIC_TEST_BUCKET_CODES[0] }, deps);
    assert(
      calls.resolveBucketByCode[0] === CATCHALL_CODE,
      "confirm: no code anywhere takes the catch-all, whatever code the client posted",
    );
    const cs = traceOf(calls.insertBooking[0])?.code_source;
    assert(
      cs?.source === "catchall" && cs.reason === "absent" && cs.salesforce === "absent",
      "confirm: and the booking records which code was used and why",
    );
  }
  {
    const { deps, calls } = makeDeps({ leadXbcThrows: true });
    let thrown: unknown = null;
    try {
      await createBooking(booker, deps);
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof LeadCodeUnavailableError, "confirm: a failed Salesforce read refuses");
    assert(calls.resolveBucketByCode.length === 0, "confirm: before any bucket is resolved");
    assert(calls.insertBooking.length === 0 && calls.createEvent.length === 0, "confirm: and nothing is written or invited");
  }
  // --- catchall_applied comes from the resolver's answer, never the raw link alone ---
  // A lead whose Salesforce XBC is genuinely the catch-all's own code was routed by
  // Salesforce, not rescued, so the decision log must agree with code_source.
  const decided = (calls: ReturnType<typeof makeDeps>["calls"]) =>
    calls.recordRoutingDecision.at(-1);
  /** The shared fake answers every code with bucket 411; the catch-all verdict is
   *  judged against the bucket actually booked, so these need a bucket carrying
   *  the code that was asked for. */
  const echoingBuckets = (deps: ReturnType<typeof makeDeps>["deps"]) => {
    const inner = deps.resolveBucketByCode;
    deps.resolveBucketByCode = async (code) => {
      const r = await inner(code);
      return r && { ...r, bucket: { ...r.bucket, code } };
    };
    return deps;
  };
  {
    const { deps, calls } = makeDeps({ leadXbc: { [LEAD]: CATCHALL_CODE } });
    await createBooking(booker, echoingBuckets(deps));
    assert(traceOf(calls.insertBooking[0])?.code_source?.source === "salesforce", "SF 100: code_source is salesforce");
    assert(decided(calls)?.catchallApplied === false, "SF 100: the decision log records catchall_applied false");
  }
  {
    const { deps, calls } = makeDeps({ leadXbc: { [LEAD]: "" } });
    await createBooking(booker, echoingBuckets(deps));
    assert(decided(calls)?.catchallApplied === true, "SF blank: the decision log still records catchall_applied true");
  }
  {
    const { deps, calls } = makeDeps({ leadXbc: { [LEAD]: "012" } });
    await createBooking(booker, echoingBuckets(deps));
    const cs = traceOf(calls.insertBooking[0])?.code_source;
    assert(decided(calls)?.catchallApplied === true, "SF 012: the decision log records catchall_applied true");
    assert(cs?.source === "catchall" && cs.salesforce === "unreadable" && cs.salesforce_xbc === "012", "SF 012: with the reason");
  }
  {
    // A routable link code is left alone, and the direct booking API (which never
    // says what a link carried) never reaches Salesforce at all.
    const { deps, calls } = makeDeps({ leadXbc: { [LEAD]: "512" } });
    await createBooking({ ...booker, bucketCode: "211", requestedCode: "211" }, deps);
    assert(calls.readLeadXbc.length === 0 && calls.resolveBucketByCode[0] === "211", "confirm: a routable link code is routed as sent");
    assert(traceOf(calls.insertBooking[0])?.code_source?.source === "link", "confirm: and recorded as the link's");
  }
  {
    const { deps, calls } = makeDeps({ leadXbc: { [LEAD]: "512" } });
    await createBooking({ ...input, salesforceId: LEAD, bucketCode: "411" }, deps);
    assert(calls.readLeadXbc.length === 0, "api: a caller that does not say what a link carried is never rerouted");
    assert(traceOf(calls.insertBooking[0])?.code_source === undefined, "api: and records no code source");
  }
}

await main();
await confirmPath();
finish();
