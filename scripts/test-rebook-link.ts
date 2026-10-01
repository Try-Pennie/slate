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
  loadRebookRow,
  parseRebookRow,
  readBookEntryQuery,
  rebookEntry,
  rebookHref,
  type RebookDeps,
} from "../src/lib/booking/book-link.ts";
import { readBookingSource } from "../src/lib/booking/booking-source.ts";

const TOKEN = "tok_rebook_fixture_0001";
const DATA = {
  status: "cancelled",
  salesforce_id: "00QUi00000ABCdeMAH",
  attendee_name: "Dana O'Neil",
  attendee_email: "dana+test@example.com",
  attendee_phone: "+12155550100",
  source: "my-offers-result",
  bucket: { code: "100" },
};

async function main() {
  // --- the link: under the manage path, the bucket and nothing about the lead -
  {
    const href = rebookHref({ bucketCode: "100", manageToken: TOKEN });
    const url = new URL(href, "https://slate.example");
    eq(url.pathname, `/booking/manage/${TOKEN}/rebook`, "served under the manage path the lead is on");
    eq([...url.searchParams.keys()].join(","), "xbc", "only the bucket rides on the query");
    eq(url.searchParams.get("xbc"), "100", "the bucket, for a lookup that fails");
    assert(!href.startsWith("/book?") && !href.startsWith("/book/"), "the token never reaches the public /book page");
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
    let release: () => void = () => {};
    const deps = (answer: () => Promise<{ data: unknown; error: unknown }>, deadline?: () => Promise<void>): RebookDeps => ({
      readByToken: (t) => {
        asked.push(t);
        return answer();
      },
      // Never fires unless a test hands it a deadline of its own.
      deadline: deadline ?? (() => new Promise<void>((r) => { release = r; })),
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

    eq((await loadRebookRow(TOKEN, deps(async () => ({ data: null, error: { code: "57014", message: `manage_token=eq.${TOKEN}` } })))).kind, "failed", "a failed read: failed");
    eq((await loadRebookRow(TOKEN, deps(async () => { throw new Error("network"); }))).kind, "failed", "a thrown read: failed");
    eq((await loadRebookRow(TOKEN, deps(async () => ({ data: { ...DATA, bucket: null }, error: null })))).kind, "failed", "an unreadable row: failed, never a half filled identity");
    // A read that never answers is bounded by the deadline.
    const hung = loadRebookRow(TOKEN, deps(() => new Promise(() => {}), async () => {}));
    eq((await hung).kind, "failed", "a read that never answers: failed at the deadline");
    eq(warned.length, 4, "every failure is logged");
    release();
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

  finish();
}

void main();
