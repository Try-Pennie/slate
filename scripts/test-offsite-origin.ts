// A real booking from a host page that is not the production site (#2715). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-offsite-origin.ts
//
// What this file pins:
//  - a real bucket booking from localhost pages, naming the advisor, the bucket,
//    the start time, the origin and the booking link;
//  - trypennie.com (either spelling) does not page, and neither does a path on it;
//  - a booking on a test bucket (the partner test path) does not page from anywhere;
//  - a booking with no origin recorded does not page but IS counted;
//  - a failed bookings read reports itself as unreadable, never as zero off site;
//  - the same booking pages once: a key already stamped is skipped, and the
//    cooldown handed to the dispatcher outlasts the lookback so a failed
//    already-paged read cannot page it again either;
//  - an unreadable origin pages without echoing the raw value into Slack;
//  - `isTestSourceBooking` (#2737), the one answer to "was this booking made from a
//    known test source", says yes to exactly the bookings this check pages about,
//    so the two can never disagree about which host is a test host (L261).
import {
  OFFSITE_ORIGIN_COOLDOWN_MS,
  OFFSITE_ORIGIN_KEY,
  OFFSITE_ORIGIN_LOOKBACK_MS,
  PRODUCTION_ORIGINS,
  classifyOrigin,
  isTestSourceBooking,
  judgeBookingOrigin,
  offsiteOriginKey,
  runOffsiteOriginCheck,
  type OffsiteOriginDeps,
  type OriginBucket,
  type RecentBooking,
} from "@/lib/monitor/offsite-origin";
import { assert, eq, finish } from "./lib/harness.ts";

const REAL: OriginBucket = { id: "b-100", code: "100", name: "Low | None | No Legal Param", is_test: false };
const TEST_BUCKET: OriginBucket = { id: "b-test", code: "TESTCODE", name: "Partner test", is_test: true };
const BUCKETS = [REAL, TEST_BUCKET];

function booking(over: Partial<RecentBooking> = {}): RecentBooking {
  return {
    id: "bk-1",
    bucket_id: REAL.id,
    starts_at: "2026-09-25T13:00:00.000Z",
    agent_name: "Tia Rios",
    agent_email: "trios@trypennie.com",
    prefill: { parentOrigin: "http://localhost:3000", embed: "1" },
    referrer_origin: null,
    ...over,
  };
}

interface Sent {
  key: string;
  cooldownMs: number;
  text: string;
}

function deps(bookings: RecentBooking[] | Error, over: Partial<OffsiteOriginDeps> = {}) {
  const sent: Sent[] = [];
  const d: OffsiteOriginDeps = {
    loadBookings: async () => {
      if (bookings instanceof Error) throw bookings;
      return bookings;
    },
    buckets: BUCKETS,
    alreadyPaged: async () => new Set(),
    notify: async (key, cooldownMs, text) => {
      sent.push({ key, cooldownMs, text });
    },
    bookingUrl: (id) => `https://slate.trypennie.app/admin/bookings/${id}`,
    ...over,
  };
  return { d, sent };
}

// --- classification -------------------------------------------------------------
eq(classifyOrigin("http://localhost:3000"), { kind: "offsite", origin: "http://localhost:3000" }, "localhost is off site");
for (const o of PRODUCTION_ORIGINS) {
  eq(classifyOrigin(o).kind, "production", `${o} is production`);
}
eq(classifyOrigin("https://trypennie.com/get-started?x=1").kind, "production", "a path on the production origin is still production");
eq(classifyOrigin("http://trypennie.com").kind, "offsite", "plain http is not the production origin");
eq(classifyOrigin("https://trypennie.com.evil.example").kind, "offsite", "a lookalike host is off site");
eq(classifyOrigin("not a url").kind, "unreadable", "garbage is unreadable, not absent");
eq(classifyOrigin("file:///tmp/x.html").kind, "unreadable", "a non web scheme is unreadable");
eq(classifyOrigin(undefined).kind, "none", "no origin is none");
eq(classifyOrigin("  ").kind, "none", "a blank origin is none");
eq(classifyOrigin(null).kind, "none", "a null origin is none");
eq(classifyOrigin(42).kind, "none", "a non string is none");

/** The facts a booking carries when only a host's DECLARED origin was recorded. */
function declared(prefill: Record<string, string> | null) {
  return { prefill, referrer_origin: null };
}

// --- the shared test source predicate (#2737) -------------------------------------
// The prefills below are the shape of the four real bucket bookings made on
// 2026-09-25 (XBC 100 and 112), read off production: two from a partner's
// localhost page and two from the dev site. Each one must be recognised.
for (const origin of ["http://localhost:3000", "https://dev.trypennie.com"]) {
  eq(isTestSourceBooking(declared({ parentOrigin: origin, embed: "1", xbc: "100" })), true, `${origin} is a known test source`);
}
eq(isTestSourceBooking(declared({ parentOrigin: "not a url" })), true, "an origin the real widget cannot produce is a test source too");
// The control the other way: what a real lead's booking carries is never one.
for (const o of PRODUCTION_ORIGINS) {
  eq(isTestSourceBooking(declared({ parentOrigin: o, embed: "1", xbc: "100" })), false, `${o} is a real lead's host, not a test source`);
}
eq(isTestSourceBooking(declared({ parentOrigin: "https://www.trypennie.com/get-started" })), false, "a path on production is still production");
eq(isTestSourceBooking(declared({ name: "Pat" })), false, "no origin recorded is not evidence of a test");
eq(isTestSourceBooking(declared(null)), false, "a null prefill is not evidence of a test");
eq(isTestSourceBooking(declared({ parentOrigin: "" })), false, "a blank origin is not evidence of a test");

// --- the framing page's origin (#2728), both directions ----------------------------
// The browser's own statement of who framed the booker, stored beside the declared
// origin. EITHER one off site makes the booking off site: a host that declared none,
// or declared the production site while being framed elsewhere, is still a test.
const framed = (prefill: Record<string, string> | null, referrer_origin: string | null) => ({ prefill, referrer_origin });
eq(
  judgeBookingOrigin(framed({ embed: "1" }, "http://localhost:3000")).kind,
  "offsite",
  "no origin declared and framed by localhost is off site (the issue's case)",
);
eq(
  judgeBookingOrigin(framed({ parentOrigin: "https://trypennie.com" }, "https://dev.trypennie.com")).kind,
  "offsite",
  "declared production while framed by the dev site is off site",
);
eq(
  judgeBookingOrigin(framed({ parentOrigin: "http://localhost:3000" }, "https://www.trypennie.com")).kind,
  "offsite",
  "framed by production while declaring localhost is still off site",
);
eq(
  judgeBookingOrigin(framed({ parentOrigin: "https://trypennie.com" }, "https://www.trypennie.com")).kind,
  "production",
  "both production, in either spelling, is production",
);
eq(judgeBookingOrigin(framed({ embed: "1" }, "https://trypennie.com")).kind, "production", "framed by production with nothing declared is production");
eq(judgeBookingOrigin(framed({ parentOrigin: "https://trypennie.com" }, null)).kind, "production", "declared production with no framing page recorded is production");
eq(judgeBookingOrigin(framed({ embed: "1" }, null)).kind, "none", "neither recorded is none");
eq(judgeBookingOrigin(framed(null, "not a url")).kind, "offsite", "an unreadable stored framing origin is judged like an unreadable declared one");
eq(isTestSourceBooking(framed({ embed: "1" }, "http://localhost:3000")), true, "the shared predicate reads the framing page too");
eq(isTestSourceBooking(framed({ embed: "1" }, "https://www.trypennie.com")), false, "and a production framing page is not a test source");

// --- the lookback and the cooldown -----------------------------------------------
assert(
  OFFSITE_ORIGIN_COOLDOWN_MS > OFFSITE_ORIGIN_LOOKBACK_MS,
  "the per key cooldown must outlast the lookback, or a booking still in the read pages again",
);

// --- a real bucket booking from localhost pages -----------------------------------
{
  const { d, sent } = deps([booking()]);
  const r = await runOffsiteOriginCheck(d);
  eq(r.status, "checked", "localhost: checked");
  eq(sent.length, 1, "localhost on a real bucket pages once");
  const s = sent[0];
  eq(s.key, `${OFFSITE_ORIGIN_KEY}:bk-1`, "keyed per booking");
  eq(s.cooldownMs, OFFSITE_ORIGIN_COOLDOWN_MS, "sent with the long cooldown");
  assert(s.text.includes("http://localhost:3000"), "names the origin");
  assert(s.text.includes("Tia Rios"), "names the advisor");
  assert(s.text.includes("100") && s.text.includes("Low | None | No Legal Param"), "names the bucket");
  assert(s.text.includes("9:00") && s.text.includes("ET"), `names the start time in ET: ${s.text}`);
  assert(s.text.includes("https://slate.trypennie.app/admin/bookings/bk-1"), "carries the booking link");
  assert(!/[\u2014\u2013]/.test(s.text), "no dashes in the copy");
  if (r.status === "checked") {
    eq(r.offsite, 1, "counts one off site");
    eq(r.paged, 1, "counts one paged");
  }
}

// --- the production site does not page ----------------------------------------------
{
  const { d, sent } = deps([
    booking({ id: "bk-a", prefill: { parentOrigin: "https://trypennie.com" } }),
    booking({ id: "bk-b", prefill: { parentOrigin: "https://www.trypennie.com" } }),
  ]);
  const r = await runOffsiteOriginCheck(d);
  eq(sent.length, 0, "trypennie.com does not page");
  if (r.status === "checked") eq(r.production, 2, "counted as production");
}

// --- a partner test bucket booking from anywhere does not page -------------------
{
  const { d, sent } = deps([
    booking({ id: "bk-p1", bucket_id: TEST_BUCKET.id }),
    booking({ id: "bk-p2", bucket_id: TEST_BUCKET.id, prefill: { parentOrigin: "https://partner.example" } }),
  ]);
  const r = await runOffsiteOriginCheck(d);
  eq(sent.length, 0, "a test bucket booking never pages");
  if (r.status === "checked") {
    eq(r.testBucket, 2, "counted as test bucket");
    eq(r.checked, 0, "not counted as a checked real booking");
  }
}

// --- no origin does not page, and is counted --------------------------------------
{
  const { d, sent } = deps([booking({ id: "bk-n", prefill: { name: "Pat" } }), booking({ id: "bk-null", prefill: null })]);
  const r = await runOffsiteOriginCheck(d);
  eq(sent.length, 0, "no origin does not page");
  eq(r.status, "checked", "no origin: still a measured run");
  if (r.status === "checked") {
    eq(r.noOrigin, 2, "no origin is counted");
    eq(r.checked, 2, "and is among the checked");
  }
}

// --- a failed read is unreadable, never "nothing off site" --------------------------
{
  const { d, sent } = deps(new Error("statement timeout"));
  const r = await runOffsiteOriginCheck(d);
  eq(r.status, "unreadable", "a failed read reports unreadable");
  assert(!("offsite" in r), "an unreadable run carries no off site count at all");
  eq(sent.length, 0, "and pages nobody");
}

// --- once per booking ---------------------------------------------------------------
{
  // Tick two: the first tick stamped the key, so it is skipped.
  const { d, sent } = deps([booking()], {
    alreadyPaged: async (keys) => new Set(keys.filter((k) => k === offsiteOriginKey("bk-1"))),
  });
  const r = await runOffsiteOriginCheck(d);
  eq(sent.length, 0, "a booking already stamped is not paged again");
  if (r.status === "checked") eq(r.alreadyPaged, 1, "counted as already paged");
}
{
  // The already-paged read fails: the dispatcher decides, with the long cooldown,
  // so its own per key stamp refuses the repeat.
  const { d, sent } = deps([booking()], {
    alreadyPaged: async () => {
      throw new Error("alert_state unreadable");
    },
  });
  const r = await runOffsiteOriginCheck(d);
  eq(sent.length, 1, "handed to the dispatcher when the dedupe read fails");
  eq(sent[0].cooldownMs, OFFSITE_ORIGIN_COOLDOWN_MS, "with the cooldown that outlasts the lookback");
  if (r.status === "checked") eq(r.dedupeUnread, true, "and says the dedupe read failed");
}
{
  // Not asked at all when nothing is off site: no subrequest on a healthy tick.
  let asked = false;
  const { d } = deps([booking({ prefill: { parentOrigin: "https://trypennie.com" } })], {
    alreadyPaged: async () => {
      asked = true;
      return new Set();
    },
  });
  await runOffsiteOriginCheck(d);
  eq(asked, false, "the already-paged read is skipped when nothing is off site");
}

// --- one failed send does not stop the next ------------------------------------------
{
  const sent: string[] = [];
  const { d } = deps([booking({ id: "bk-x" }), booking({ id: "bk-y" })], {
    notify: async (key) => {
      if (key.endsWith("bk-x")) throw new Error("slack down");
      sent.push(key);
    },
  });
  const r = await runOffsiteOriginCheck(d);
  eq(sent, [offsiteOriginKey("bk-y")], "the second booking still pages");
  if (r.status === "checked") {
    eq(r.sendFailed, 1, "the failed send is counted");
    eq(r.paged, 1, "and only the delivered one is counted as paged");
  }
}

// --- an unreadable origin pages without echoing it -----------------------------------
{
  const { d, sent } = deps([booking({ prefill: { parentOrigin: "<script>alert(1)</script>" } })]);
  await runOffsiteOriginCheck(d);
  eq(sent.length, 1, "an unreadable origin on a real bucket pages");
  assert(!sent[0].text.includes("<script>"), "and never echoes the raw value");
  assert(sent[0].text.includes("cannot read"), "it says the address could not be read");
}

// --- the page and the shared predicate agree, booking by booking (#2737) ----------
{
  const prefills: (Record<string, string> | null)[] = [
    { parentOrigin: "http://localhost:3000" },
    { parentOrigin: "https://dev.trypennie.com" },
    { parentOrigin: "https://trypennie.com" },
    { parentOrigin: "https://www.trypennie.com" },
    { parentOrigin: "http://trypennie.com" },
    { parentOrigin: "not a url" },
    { embed: "1" },
    null,
  ];
  // #2728: every declared origin against every framing origin, so the agreement is
  // held on the pairs where the two facts disagree, not only where one is absent.
  const referrers = [null, "http://localhost:3000", "https://trypennie.com", "not a url"];
  const list = prefills.flatMap((prefill, i) =>
    referrers.map((referrer_origin, j) => booking({ id: `bk-${i}-${j}`, prefill, referrer_origin })),
  );
  const { d, sent } = deps(list);
  await runOffsiteOriginCheck(d);
  const excluded = list.filter((b) => isTestSourceBooking(b));
  assert(excluded.length > 0 && excluded.length < list.length, "the grid holds both verdicts");
  eq(
    sent.map((s) => s.key).sort(),
    excluded.map((b) => offsiteOriginKey(b.id)).sort(),
    "the check pages on exactly the bookings the shared predicate calls a test source",
  );
}

// --- the page names the framing origin (#2728) -----------------------------------------
{
  const { d, sent } = deps([booking({ prefill: { embed: "1" }, referrer_origin: "https://partner.example" })]);
  const r = await runOffsiteOriginCheck(d);
  eq(sent.length, 1, "a booking framed off site with nothing declared pages");
  assert(sent[0].text.includes("https://partner.example"), `the page names the framing origin: ${sent[0].text}`);
  assert(sent[0].text.includes("did not say"), "and says the page declared no origin of its own");
  if (r.status === "checked") eq(r.noOrigin, 0, "it is not counted as having no origin");
}
{
  const { d, sent } = deps([booking({ prefill: { parentOrigin: "https://trypennie.com" }, referrer_origin: "https://dev.trypennie.com" })]);
  await runOffsiteOriginCheck(d);
  eq(sent.length, 1, "declared production while framed off site pages");
  assert(
    sent[0].text.includes("https://dev.trypennie.com") && sent[0].text.includes("https://trypennie.com"),
    `names both what the page said and where it was framed: ${sent[0].text}`,
  );
}
{
  const { d, sent } = deps([booking({ prefill: { parentOrigin: "http://localhost:3000" }, referrer_origin: "http://localhost:3000" })]);
  await runOffsiteOriginCheck(d);
  eq(sent.length, 1, "the same off site origin both ways pages once");
  eq(sent[0].text.split("http://localhost:3000").length - 1, 1, "and names it once, not twice");
}
{
  const { d, sent } = deps([
    booking({ id: "bk-p", prefill: { parentOrigin: "https://www.trypennie.com" }, referrer_origin: "https://www.trypennie.com" }),
    booking({ id: "bk-f", prefill: { embed: "1" }, referrer_origin: "https://trypennie.com" }),
  ]);
  const r = await runOffsiteOriginCheck(d);
  eq(sent.length, 0, "production both ways, or framed by production alone, does not page");
  if (r.status === "checked") eq(r.production, 2, "both counted as production");
}

// --- an unassigned booking still reads as a sentence ----------------------------------
{
  const { d, sent } = deps([booking({ agent_name: null, agent_email: null })]);
  await runOffsiteOriginCheck(d);
  assert(sent[0].text.includes("an unassigned advisor"), "names the absence rather than printing null");
  assert(!sent[0].text.includes("null"), "no leaked null");
}

finish();
