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
//
// #3502: "the lead's score" is the one on the lead's CURRENT submission, which is
// what a link carries when it carries one. `Lead.XBC__c` is a copy that lags it: a
// lead who came back on 2026-10-07 scored 111 while the Lead still held 211 from
// July, so a codeless link would have sent a Low lead to the Medium team.
import {
  resolveRoutingCode,
  LeadCodeUnavailableError,
  type LeadXbcReader,
  type SubmissionLeadReader,
} from "../src/lib/routing/lead-code.ts";
import { CATCHALL_CODE } from "../src/lib/routing/catchall.ts";
import { readSubmissionLeadId, isSubmissionId, readOneLeadXbc, type LeadFieldRecord } from "../src/lib/salesforce/lead-xbc.ts";
import { PUBLIC_TEST_BUCKET_CODES } from "../src/lib/embed/public-test-bucket.ts";
import { createBooking } from "../src/lib/booking/orchestration.ts";
import { assert, finish } from "./lib/harness.ts";
import { makeDeps, makeBooking, input } from "./lib/booking-fakes.ts";

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

// #3246: a trypennie booker that arrived with no code and no lead id still
// carries the submission id. The submission names its Lead, so the lead's own
// XBC is two reads away. Every case below names the lookup explicitly.
const SUB = "a04Ui00000NNZ7uIAH";

/** A submission reader answering from a table, recording every id asked about. */
function subReader(table: Record<string, string | null>): SubmissionLeadReader & { asked: string[] } {
  const asked: string[] = [];
  const fn = (async (id: string) => {
    asked.push(id);
    return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined;
  }) as SubmissionLeadReader & { asked: string[] };
  fn.asked = asked;
  return fn;
}

/** The lookup for a link that carried no submission id. */
const NO_SUB = { id: null, readLeadId: subReader({}) };

async function main() {
  // --- no code on the link, Salesforce holds 512: route to 512 ---
  {
    const r = reader({ [LEAD]: "512" });
    const res = await resolveRoutingCode("", LEAD, r, NO_SUB);
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
    const res = await resolveRoutingCode("null11", LEAD, reader({ [LEAD]: " 312 " }), NO_SUB);
    assert(res.code === "312", "an unreadable link code routes on the Salesforce code, trimmed");
    assert(res.record.source === "salesforce" && res.record.requested === "null11", "keeping the raw link value");
  }

  // --- a valid link code is never second guessed, and Salesforce is not asked ---
  {
    const r = reader({ [LEAD]: "512" });
    const res = await resolveRoutingCode("211", LEAD, r, NO_SUB);
    assert(res.code === "211" && res.source === "link", "a routable link code is used as sent");
    assert(r.asked.length === 0, "and Salesforce is not asked at all");
  }

  // --- Salesforce holds no code: the catch-all, RECORDED with why ---
  {
    const res = await resolveRoutingCode("", LEAD, reader({ [LEAD]: null }), NO_SUB);
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
    const res = await resolveRoutingCode("", LEAD, reader({ [LEAD]: "012" }), NO_SUB);
    assert(res.code === CATCHALL_CODE, "a Salesforce code Slate cannot route (tier 0) takes the catch-all");
    assert(
      res.record.source === "catchall" && res.record.salesforce === "unreadable" && res.record.salesforce_xbc === "012",
      "and records the value Salesforce held, so the cause can be chased",
    );
  }
  {
    const res = await resolveRoutingCode("", LEAD, reader({}), NO_SUB);
    assert(
      res.code === CATCHALL_CODE && res.record.source === "catchall" && res.record.salesforce === "not-found",
      "a lead Salesforce did not return takes the catch-all, recorded as not found",
    );
  }
  {
    const r = reader({});
    const res = await resolveRoutingCode("", null, r, NO_SUB);
    assert(
      res.code === CATCHALL_CODE && res.record.source === "catchall" && res.record.salesforce === "no-lead-id",
      "a link naming no lead takes the catch-all, recorded as having no lead id",
    );
    assert(r.asked.length === 0, "and Salesforce is not asked");
  }
  {
    const r = reader({});
    const res = await resolveRoutingCode("", "003AB0000012345", r, NO_SUB);
    assert(
      res.record.source === "catchall" && res.record.salesforce === "no-lead-id" && r.asked.length === 0,
      "an id that is not a Lead id (a Contact) is never sent to the Lead query",
    );
  }

  // --- Salesforce must never route a lead into a test bucket ---
  {
    const res = await resolveRoutingCode("", LEAD, reader({ [LEAD]: PUBLIC_TEST_BUCKET_CODES[0] }), NO_SUB);
    assert(res.code === CATCHALL_CODE, "a Salesforce value naming the public test bucket is not routed on");
  }

  // --- a failed Salesforce read REFUSES, never falls through ---
  {
    let thrown: unknown = null;
    try {
      await resolveRoutingCode("", LEAD, failing, NO_SUB);
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

// --- #3246: no code, no lead id, but a submission id ---
async function submissionPath() {
  {
    const subs = subReader({ [SUB]: LEAD });
    const leads = reader({ [LEAD]: "512" });
    const res = await resolveRoutingCode("", null, leads, { id: SUB, readLeadId: subs });
    assert(res.code === "512" && res.source === "salesforce", "sub: a submission naming a lead with 512 routes to 512");
    assert(subs.asked.length === 1 && subs.asked[0] === SUB, "sub: the submission was read once");
    assert(leads.asked.length === 1 && leads.asked[0] === LEAD, "sub: then the lead it names, through the same lead path");
    assert(
      res.record.source === "salesforce" &&
        res.record.via === "submission" &&
        res.record.submission_id === SUB &&
        res.record.salesforce_xbc === "512",
      "sub: the record says the lead was found through the submission, and which one",
    );
  }
  {
    const subs = subReader({ [SUB]: "00Q5e00000ZzZzZEAU" });
    const res = await resolveRoutingCode("", LEAD, reader({ [LEAD]: "312" }), { id: SUB, readLeadId: subs });
    assert(res.code === "312" && subs.asked.length === 0, "sub: a lead id on the link wins and the submission is never read");
    assert(res.record.source === "salesforce" && res.record.via === undefined, "sub: and the record does not claim the submission");
  }
  {
    const subs = subReader({ [SUB]: LEAD });
    const leads = reader({ [LEAD]: "512" });
    const res = await resolveRoutingCode("211", null, leads, { id: SUB, readLeadId: subs });
    assert(res.code === "211" && subs.asked.length === 0 && leads.asked.length === 0, "sub: a routable code means neither is read");
  }
  {
    const subs = subReader({});
    const res = await resolveRoutingCode("", null, reader({}), { id: "003AB0000012345", readLeadId: subs });
    assert(subs.asked.length === 0, "sub: an id that is not a submission id is never sent to the query");
    assert(res.record.source === "catchall" && res.record.salesforce === "no-lead-id", "sub: and records no lead id");
  }
  {
    const res = await resolveRoutingCode("", null, reader({}), { id: SUB, readLeadId: subReader({}) });
    assert(
      res.code === CATCHALL_CODE && res.record.source === "catchall" && res.record.salesforce === "submission-not-found",
      "sub: a submission Salesforce did not return takes the catch-all, recorded as such",
    );
  }
  {
    const leads = reader({});
    const res = await resolveRoutingCode("", null, leads, { id: SUB, readLeadId: subReader({ [SUB]: null }) });
    assert(
      res.record.source === "catchall" && res.record.salesforce === "submission-without-lead" && leads.asked.length === 0,
      "sub: a submission naming no lead takes the catch-all, recorded as such, with no lead read",
    );
  }
  {
    const res = await resolveRoutingCode("", null, reader({}), { id: SUB, readLeadId: subReader({ [SUB]: LEAD }) });
    assert(
      res.record.source === "catchall" && res.record.salesforce === "not-found",
      "sub: a submission naming a lead Salesforce did not return records the lead miss",
    );
  }
  {
    let thrown: unknown = null;
    try {
      await resolveRoutingCode("", null, reader({}), {
        id: SUB,
        readLeadId: async () => {
          throw new Error("SF query failed: 503 unavailable");
        },
      });
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof LeadCodeUnavailableError, "sub: a failed submission read refuses, never falls through");
  }
  // Through the confirm: the booker posts the submission id in prefill and no lead id.
  {
    const { deps, calls } = makeDeps({ submissionLead: { [SUB]: LEAD }, leadXbc: { [LEAD]: "512" } });
    await createBooking(
      { ...input, salesforceId: null, bucketCode: CATCHALL_CODE, requestedCode: "", prefill: { ...input.prefill, submissionId: SUB } },
      deps,
    );
    assert(calls.readSubmissionLead.length === 1 && calls.readSubmissionLead[0] === SUB, "confirm sub: the submission is read");
    assert(calls.resolveBucketByCode[0] === "512", "confirm sub: and the booking routes to 512, not the catch-all");
    const cs = (calls.insertBooking[0]?.routing_trace as { code_source?: Record<string, unknown> } | undefined)?.code_source;
    assert(cs?.source === "salesforce" && cs.via === "submission" && cs.submission_id === SUB, "confirm sub: and records it");
  }
  {
    const { deps, calls } = makeDeps({ submissionLead: { [SUB]: LEAD }, leadXbc: { [LEAD]: "512" } });
    await createBooking({ ...input, salesforceId: null, bucketCode: CATCHALL_CODE, requestedCode: "" }, deps);
    assert(calls.readSubmissionLead.length === 0, "confirm sub: a confirm with no submission id never reads one");
    assert(calls.resolveBucketByCode[0] === CATCHALL_CODE, "confirm sub: and takes the catch-all as before");
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
  // --- a retry of a successful confirm never depends on a second Salesforce call ---
  // The idempotency key is built from what is stable across a retry (the RAW link
  // code and the lead id), and the fast path runs BEFORE Salesforce is asked, so a
  // Salesforce outage or a changed score between the confirm and its retry still
  // returns the booking the first confirm made.
  {
    const first = makeDeps({ leadXbc: { [LEAD]: "512" } });
    await createBooking(booker, first.deps);
    const keyOf = (row: Record<string, unknown> | undefined) => row?.idempotency_key as string;
    const key = keyOf(first.calls.insertBooking[0]);
    const existing = makeBooking({ id: "bk-original", idempotency_key: key });

    const down = makeDeps({ leadXbcThrows: true, existingByKey: existing });
    const findKeys: string[] = [];
    const inner = down.deps.findBookingByIdempotencyKey;
    down.deps.findBookingByIdempotencyKey = async (k) => (findKeys.push(k), inner(k));
    const retried = await createBooking(booker, down.deps);
    assert(retried.booking.id === "bk-original", "retry with Salesforce DOWN returns the existing booking");
    assert(findKeys[0] === key, "retry looks up the same key the first confirm stored");
    assert(down.calls.readLeadXbc.length === 0, "and Salesforce is never asked on that retry");

    const moved = makeDeps({ leadXbc: { [LEAD]: "612" }, existingByKey: existing });
    const movedKeys: string[] = [];
    const inner2 = moved.deps.findBookingByIdempotencyKey;
    moved.deps.findBookingByIdempotencyKey = async (k) => (movedKeys.push(k), inner2(k));
    const again = await createBooking(booker, moved.deps);
    assert(
      again.booking.id === "bk-original" && movedKeys[0] === key,
      "Salesforce answering 612 on the retry after 512 still returns the original booking",
    );
  }
  {
    // A request carrying a routable link code keys EXACTLY as before this change,
    // so a booking already in flight across the deploy still matches its retry.
    const { deps, calls } = makeDeps({});
    await createBooking({ ...booker, bucketCode: "211", requestedCode: "211" }, deps);
    const expected = ["211", new Date(booker.startIso).toISOString(), "k@x.com", "+12035615295", LEAD].join("|");
    assert(calls.insertBooking[0]?.idempotency_key === expected, "a routable link code keys on the bucket code as before");
    const api = makeDeps({});
    await createBooking({ ...input }, api.deps);
    assert(
      (api.calls.insertBooking[0]?.idempotency_key as string).startsWith("411|"),
      "a caller that does not say what the link carried keys as before",
    );
  }
  {
    // First request with Salesforce down, and no booking yet: still refused.
    const { deps, calls } = makeDeps({ leadXbcThrows: true });
    let thrown: unknown = null;
    try {
      await createBooking(booker, deps);
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof LeadCodeUnavailableError && calls.insertBooking.length === 0, "a first confirm with Salesforce down still refuses");
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

// --- the submission reader itself, with the SOQL runner injected ---
async function submissionReader() {
  const asked: string[] = [];
  const run = (rows: Record<string, unknown>[]) => async (soql: string) => (asked.push(soql), rows as { Id: string }[]);
  const lead = await readSubmissionLeadId(SUB, run([{ Id: SUB, Lead__c: LEAD }]));
  assert(lead === LEAD, "reader: a submission naming a lead answers that lead");
  assert(/FROM Submission__c WHERE Id IN \('a04Ui00000NNZ7uIAH'\)/.test(asked[0] ?? ""), "reader: it asks Submission__c by that id");
  assert(/\bLead__c\b/.test(asked[0] ?? ""), "reader: and selects Lead__c");
  assert(
    (await readSubmissionLeadId(SUB.slice(0, 15), run([{ Id: SUB, Lead__c: LEAD }]))) === LEAD,
    "reader: a 15 character id matches Salesforce's 18 character answer",
  );
  assert((await readSubmissionLeadId(SUB, run([{ Id: SUB, Lead__c: null }]))) === null, "reader: no lead answers null");
  assert((await readSubmissionLeadId(SUB, run([]))) === undefined, "reader: no submission answers undefined");
  let thrown: unknown = null;
  try {
    await readSubmissionLeadId(SUB, async () => {
      throw new Error("SF query failed: 503");
    });
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof Error, "reader: a refused query throws rather than answering");
  assert(isSubmissionId(SUB) && isSubmissionId(SUB.slice(0, 15)), "reader: a04 ids of 15 and 18 characters are submission ids");
  assert(!isSubmissionId(LEAD) && !isSubmissionId("a04short"), "reader: a Lead id or a short value is not");
}

/** #3502: the real single lead reader, against Salesforce's recorded answers. */
async function currentSubmissionScore() {
  const RETURNED = "00QUi00000tHtYHMA0";
  const NO_SUB = "00QUi00000noSubAAA";
  const CORRECTED = "00QUi00000zMlRmMAK"; // Lead edited 512 to 412 49s after its submission
  const queries: string[] = [];
  const salesforce = async (soql: string): Promise<LeadFieldRecord[]> => {
    queries.push(soql);
    if (/FROM Lead /.test(soql)) {
      return [
        { Id: RETURNED, XBC__c: "211", Submission_Object_ID__c: "a04Ui00000NXcm1IAD" },
        { Id: NO_SUB, XBC__c: "312", Submission_Object_ID__c: null },
        { Id: CORRECTED, XBC__c: "412", Submission_Object_ID__c: "a04Ui00000MmsSrIAJ" },
      ].filter((r) => soql.includes(`'${r.Id}'`));
    }
    if (/FROM Submission__c /.test(soql)) {
      return [
        { Id: "a04Ui00000NXcm1IAD", XBC_SO__c: "111", CreatedDate: "2026-10-07T18:17:53.000+0000" },
        { Id: "a04Ui00000MmsSrIAJ", XBC_SO__c: "512", CreatedDate: "2026-09-21T13:16:12.000+0000" },
      ].filter((r) => soql.includes(`'${r.Id}'`));
    }
    if (/FROM LeadHistory /.test(soql)) {
      return [
        { Id: "017h1", LeadId: RETURNED, CreatedDate: "2026-07-15T15:38:55.000+0000" },
        { Id: "017h2", LeadId: CORRECTED, CreatedDate: "2026-09-21T13:17:01.000+0000" },
      ].filter((r) => soql.includes(`'${r.LeadId}'`));
    }
    throw new Error(`unexpected query: ${soql}`);
  };
  const live: LeadXbcReader = (id) => readOneLeadXbc(id, salesforce);

  const routed = await resolveRoutingCode("", RETURNED, live, { id: null, readLeadId: async () => undefined });
  assert(routed.code === "111", `a returning lead with no code routes on today's submission, not July's copy (got ${routed.code})`);
  assert(routed.source === "salesforce", "and records Salesforce as the source");
  assert(queries.some((q) => /FROM Submission__c /.test(q)), "it asked for the submission the Lead names");

  assert((await live(NO_SUB)) === "312", "a lead naming no submission still routes on the Lead's own score");
  assert((await live(CORRECTED)) === "412", "a Lead score edited after its submission routes on the edit (newest wins)");
  assert((await live("00QUi00000missingA")) === undefined, "a lead Salesforce did not return is still undefined, never a score");

  let thrown: unknown = null;
  try {
    await readOneLeadXbc(RETURNED, async (q) => {
      if (/FROM Submission__c /.test(q)) throw new Error("SF query failed: 503");
      return salesforce(q);
    });
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof Error, "a refused submission read throws, so the confirm refuses rather than routing on the copy");

  // The third read: the returning lead's two scores disagree, so the edit history is
  // asked. Refused, the confirm must refuse too, never route on either score unjudged.
  let refused: unknown = null;
  try {
    await resolveRoutingCode("", RETURNED, (id) => readOneLeadXbc(id, async (q) => {
      if (/FROM LeadHistory /.test(q)) throw new Error("SF query failed: 503");
      return salesforce(q);
    }), { id: null, readLeadId: async () => undefined });
  } catch (e) {
    refused = e;
  }
  assert(refused instanceof LeadCodeUnavailableError, "a refused edit history read refuses the booking with the retriable error");
}

await main();
await submissionReader();
await submissionPath();
await confirmPath();
await currentSubmissionScore();
finish();
