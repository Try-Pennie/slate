// "Book a new time" carries the lead's identity into the rebooked call (#2982).
//
// The manage page's rebook link used to be a bare `/book?xbc=<bucket>`, so a lead
// who cancelled and booked again arrived as a stranger: no Lead id (no Salesforce
// link, no Regal journey, no dedupe against their record), no source, and every
// detail retyped. The rebook booker now lives under the manage path the lead is
// already on and resolves the booking by its token SERVER SIDE, so no contact
// data rides on a URL and the token never reaches the public `/book` page, which
// host pages and their third party scripts frame.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-rebook-link.ts
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  REBOOK_COLUMNS,
  loadRebookRow,
  manageHref,
  parseRebookRow,
  readBookEntryQuery,
  prefillFromQuery,
  rebookEntry,
  rebookHref,
  type RebookDeps,
} from "../src/lib/booking/book-link.ts";
import type { ScheduleTimer } from "../src/lib/read-within-deadline.ts";
import { readBookingSource } from "../src/lib/booking/booking-source.ts";

const TOKEN = "tok_rebook_fixture_0001";
const DATA = {
  status: "cancelled",
  salesforce_id: "00QUi00000ABCdeMAH",
  external_id: null,
  attendee_name: "Dana O'Neil",
  attendee_email: "dana+test@example.com",
  attendee_phone: "+12155550100",
  source: "my-offers-result",
  replaced_by_booking_id: null,
  bucket: { code: "100" },
};

async function main() {
  // --- the link: under the manage path, the bucket and nothing about the lead -
  {
    const href = rebookHref({ bucketCode: "100", manageToken: TOKEN, theme: "light" });
    const url = new URL(href, "https://slate.example");
    eq(url.pathname, `/booking/manage/${TOKEN}/rebook`, "served under the manage path the lead is on");
    eq([...url.searchParams.keys()].join(","), "xbc", "only the bucket rides on the query");
    eq(url.searchParams.get("xbc"), "100", "the bucket, for a lookup that fails");
    assert(!href.startsWith("/book?") && !href.startsWith("/book/"), "the token never reaches the public /book page");
    // The manage page's theme carries over, so a dark page does not open a light booker.
    const dark = new URL(rebookHref({ bucketCode: "100", manageToken: TOKEN, theme: "dark" }), "https://slate.example");
    eq(dark.searchParams.get("theme"), "dark", "a dark manage page opens a dark booker");
    eq(dark.searchParams.get("xbc"), "100", "and still names the bucket");
  }

  // --- the manage page link a followed token opens (#3672) ---------------------
  {
    eq(manageHref({ manageToken: TOKEN, theme: "light" }), `/booking/manage/${TOKEN}`, "a light page carries nothing");
    eq(manageHref({ manageToken: TOKEN, theme: "dark" }), `/booking/manage/${TOKEN}?theme=dark`, "a dark page stays dark");
    eq(manageHref({ manageToken: "a/b", theme: "light" }), "/booking/manage/a%2Fb", "the token is one path segment");
  }

  // --- the runtime shape check, never a cast ---------------------------------
  {
    const row = parseRebookRow(DATA);
    eq(row?.bucketCode, "100", "the embedded bucket code is read");
    eq(parseRebookRow({ ...DATA, bucket: [{ code: "100" }] })?.bucketCode, "100", "an array embed is read too");
    eq(parseRebookRow({ ...DATA, bucket: null }), null, "no bucket: unreadable");
    eq(parseRebookRow({ ...DATA, status: 3 }), null, "a non string status: unreadable");
    eq(parseRebookRow({ ...DATA, attendee_email: 42 }), null, "a non string contact field: unreadable");
    eq(parseRebookRow(null), null, "nothing: unreadable");
  }

  // --- the identity fills the form, the Lead id and the source ---------------
  {
    const entry = rebookEntry(parseRebookRow(DATA)!);
    eq(entry.requestedCode, "100", "the booking's own bucket");
    eq(entry.externalId, "00QUi00000ABCdeMAH", "the Lead id /book routes and recognises on");
    eq(entry.link.name, "Dana O'Neil", "name");
    eq(entry.link.email, "dana+test@example.com", "email");
    eq(entry.link.phone, "+12155550100", "phone");
    eq(readBookingSource(entry.prefill).source, "my-offers-result", "the original page's source is recorded again");
    eq(Object.keys(entry.prefill).join(","), "source", "prefill holds the source and nothing else");
  }

  // --- an API made booking keeps its Lead id (it may sit in external_id) ------
  {
    const api = parseRebookRow({ ...DATA, salesforce_id: null, external_id: "00QUi00000APIidMAH" });
    eq(rebookEntry(api!).externalId, "00QUi00000APIidMAH", "the Lead id from external_id, by the shared bookingLeadId rule");
    const both = parseRebookRow({ ...DATA, external_id: "00QUi00000APIidMAH" });
    eq(rebookEntry(both!).externalId, "00QUi00000ABCdeMAH", "salesforce_id still comes first");
    assert(REBOOK_COLUMNS.includes("external_id"), "the read selects external_id");
    assert(REBOOK_COLUMNS.includes("replaced_by_booking_id"), "#3672: the read selects the successor");
    eq(parseRebookRow({ ...DATA, external_id: 7 }), null, "a non string external_id: unreadable");
    const { external_id: _omitted, ...withoutExternal } = DATA;
    eq(parseRebookRow(withoutExternal), null, "a row missing external_id: unreadable (the select changed)");
  }

  // --- no Lead id: the details still fill, nothing is invented ----------------
  {
    const entry = rebookEntry(parseRebookRow({ ...DATA, salesforce_id: null, attendee_phone: null })!);
    eq(entry.externalId, null, "no Lead id: none invented");
    eq(entry.link.email, "dana+test@example.com", "the email still fills");
    eq(entry.link.phone, "", "no phone: none invented");
  }

  // --- only a PAGE source is carried ------------------------------------------
  for (const source of ["not-given", "unrecognised", "api-regal", "api-canary", null]) {
    const entry = rebookEntry(parseRebookRow({ ...DATA, source })!);
    assert(!("source" in entry.prefill), `a stored ${source} is not recorded as the page`);
  }

  // --- the lookup: one read by token, and every outcome named ----------------
  {
    const asked: string[] = [];
    const warned: string[] = [];
    // The shared deadline's timer, injected: it never fires unless a test says so,
    // and every timer it starts must be CLEARED however the read ends.
    let started = 0;
    let cleared = 0;
    const neverFires: ScheduleTimer = () => {
      started += 1;
      return () => { cleared += 1; };
    };
    const firesAtOnce: ScheduleTimer = (_ms, fire) => {
      started += 1;
      queueMicrotask(fire);
      return () => { cleared += 1; };
    };
    const deps = (answer: () => Promise<{ data: unknown; error: unknown }>, timer: ScheduleTimer = neverFires): RebookDeps => ({
      readByToken: (t) => {
        asked.push(t);
        return answer();
      },
      timer,
      warn: (msg, err) => warned.push(`${msg} ${String(err)}`),
    });

    const found = await loadRebookRow(TOKEN, deps(async () => ({ data: DATA, error: null })));
    eq(found.kind, "found", "a cancelled booking resolves");
    eq(asked.at(-1), TOKEN, "read by exactly the token");
    eq((await loadRebookRow(TOKEN, deps(async () => ({ data: { ...DATA, status: "completed" }, error: null })))).kind, "found", "a completed call resolves too (its page offers the rebook)");

    eq((await loadRebookRow(TOKEN, deps(async () => ({ data: null, error: null })))).kind, "absent", "unknown token: absent (the not found state)");
    for (const status of ["confirmed", "rescheduled", "no_show"]) {
      eq((await loadRebookRow(TOKEN, deps(async () => ({ data: { ...DATA, status }, error: null })))).kind, "absent", `a ${status} booking is not a rebook`);
    }
    eq(warned.length, 0, "an unknown or other state token is silent");

    // #3672: a booking the API moved to another bucket was cancelled and REPLACED.
    // Rebooking from it would give the lead a second call in the old bucket, so the
    // page is told it was replaced and opens the booking that replaced it instead.
    const replaced = { ...DATA, status: "cancelled", replaced_by_booking_id: "bk-new" };
    eq((await loadRebookRow(TOKEN, deps(async () => ({ data: replaced, error: null })))).kind, "replaced", "a moved booking: replaced");
    eq((await loadRebookRow(TOKEN, deps(async () => ({ data: DATA, error: null })))).kind, "found", "control: a booking cancelled any other way still rebooks");
    eq(
      (await loadRebookRow(TOKEN, deps(async () => ({ data: { ...replaced, status: "confirmed" }, error: null })))).kind,
      "absent",
      "only a CANCELLED row is followed: a live one is not a rebook either way",
    );
    eq(parseRebookRow({ ...DATA, replaced_by_booking_id: 7 }), null, "a non string successor: unreadable");
    const withoutSuccessor: Record<string, unknown> = { ...DATA };
    delete withoutSuccessor.replaced_by_booking_id;
    eq(parseRebookRow(withoutSuccessor), null, "a row missing the successor column: unreadable (the select changed)");
    eq(warned.length, 0, "a replaced booking is not a failure");

    eq((await loadRebookRow(TOKEN, deps(async () => ({ data: null, error: { code: "57014", message: `manage_token=eq.${TOKEN}` } })))).kind, "failed", "a failed read: failed");
    eq((await loadRebookRow(TOKEN, deps(async () => { throw new Error("network"); }))).kind, "failed", "a thrown read: failed");
    eq((await loadRebookRow(TOKEN, deps(async () => ({ data: { ...DATA, bucket: null }, error: null })))).kind, "failed", "an unreadable row: failed, never a half filled identity");
    // A read that never answers is bounded by the deadline.
    const hung = loadRebookRow(TOKEN, deps(() => new Promise(() => {}), firesAtOnce));
    eq((await hung).kind, "failed", "a read that never answers: failed at the deadline");
    eq(warned.length, 4, "every failure is logged, once each");
    assert(started > 0, "every lookup runs under the deadline");
    eq(cleared, started, "every deadline timer is cleared, however the read ended");
  }

  // --- what the real wiring logs: the code only, never the token or the lead --
  {
    const service = readFileSync("src/lib/booking/service.ts", "utf8");
    const at = service.indexOf("export function rebookRowForToken");
    assert(at > 0, "service.ts wires the lookup");
    const body = service.slice(at, at + 1600);
    assert(body.includes("log.warn(\"rebook\", { msg, code, kind })"), "the log line carries the message, the error code and its kind");
    assert(!/log\.warn\([^)]*,\s*err\)/.test(body), "the error itself (which can quote the token) is never handed to the log");
    assert(body.includes("REBOOK_COLUMNS"), "the read selects only the rebook columns");
    assert(!body.includes("setTimeout"), "no bare timer: the deadline is the shared, cleared one");
    assert(body.includes(".maybeSingle()"), "the read is one row");
  }

  // --- /book never takes a rebook token, and the manage page builds the link --
  {
    const book = readFileSync("src/app/book/page.tsx", "utf8");
    assert(book.includes("readBookEntryQuery("), "/book reads its query through readBookEntryQuery");
    assert(!book.includes("rebook"), "/book has no rebook path at all");
    const manage = readFileSync("src/app/booking/manage/[token]/page.tsx", "utf8");
    assert(manage.includes("rebookHref("), "the manage page builds its link through rebookHref");
  }

  // --- the phone aliases /book accepts are still honoured ---------------------
  eq(readBookEntryQuery({ attendeePhoneNumber: "+12155550100" }).link.phone, "+12155550100", "attendeePhoneNumber alias");
  eq(readBookEntryQuery({ smsReminderNumber: "+12155550101" }).link.phone, "+12155550101", "smsReminderNumber alias");
  eq(readBookEntryQuery({ xbc: ["7", "8"] }).requestedCode, "7", "a repeated key reads its first value");

  // --- what a booking stores from its link (#3718) ----------------------------
  // A booking keeps at most 20 link values and refuses one carrying more, and the
  // inline card's link already uses about 13 before a landing page adds its own
  // tracking. The five that only decide how the booker LOOKS are not stored.
  {
    const link = {
      xbc: "411", external_id: "00QUi000010889ZMAQ", email: "a@b.test", phone: "2197588170",
      embed: "1", theme: "dark", brand: "#000000", bg: "#1D212F", callMeNow: "above",
      layout: "inline", parentOrigin: "https://trypennie.com", utm_source: "google",
    };
    const stored = prefillFromQuery(link);
    eq(Object.keys(stored).sort(), ["email", "external_id", "layout", "parentOrigin", "phone", "utm_source", "xbc"], "the display only values are left out, everything else is kept");
    eq(readBookEntryQuery(link).prefill, stored, "and /book stores exactly that");
    eq(prefillFromQuery({ source: ["offerhub", "x"] }), { source: "offerhub" }, "a repeated key keeps its first value");
    for (const page of ["src/app/book/page.tsx", "src/app/booking/[id]/page.tsx", "src/app/book/advisor/[link]/page.tsx"]) {
      const text = readFileSync(page, "utf8");
      assert(text.includes("readBookEntryQuery(") || text.includes("prefillFromQuery("), `${page} builds its stored values through the shared reader`);
      assert(!/prefill\[k\]\s*=/.test(text), `${page} has no copy of its own`);
    }
  }

  finish();
}

void main();
