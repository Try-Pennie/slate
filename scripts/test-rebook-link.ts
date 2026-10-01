// "Book a new time" carries the lead's identity back into /book (#2982).
//
// The manage page's rebook link used to be a bare `/book?xbc=<bucket>`, so a lead
// who cancelled and booked again arrived as a stranger: no Lead id (no Salesforce
// link, no Regal journey, no dedupe against their record), no source, and every
// detail retyped. The link now names the booking by its manage token, and `/book`
// resolves that SERVER SIDE into the booking's identity. No contact data ever
// rides on the URL, where request logs, browser history and Referer headers to
// third party scripts would carry it.
//
// The link is parsed back with the SAME reader `/book` uses (`readBookEntryQuery`),
// so a parameter name the page does not read cannot pass here (L58).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-rebook-link.ts
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  REBOOK_PARAM,
  loadRebookRow,
  readBookEntryQuery,
  rebookHref,
  withRebookIdentity,
  type RebookRow,
} from "../src/lib/booking/book-link.ts";
import { readBookingSource } from "../src/lib/booking/booking-source.ts";

/** What Next hands `/book` as `searchParams`, from an href. */
function searchParamsOf(href: string): Record<string, string | string[] | undefined> {
  const url = new URL(href, "https://slate.example");
  eq(url.pathname, "/book", `the link opens /book: ${href}`);
  const sp: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of url.searchParams) sp[k] = v;
  return sp;
}

const TOKEN = "tok_rebook_fixture_0001";
const ROW: RebookRow = {
  status: "cancelled",
  salesforce_id: "00QUi00000ABCdeMAH",
  attendee_name: "Dana O'Neil",
  attendee_email: "dana+test@example.com",
  attendee_phone: "+12155550100",
  source: "my-offers-result",
};

async function main() {
  // --- the link carries the bucket and the token, and NO contact data --------
  {
    const href = rebookHref({ bucketCode: "100", manageToken: TOKEN });
    const sp = searchParamsOf(href);
    eq(Object.keys(sp).sort().join(","), `${REBOOK_PARAM},xbc`, "only xbc and the token ride on the link");
    const read = readBookEntryQuery(sp);
    eq(read.requestedCode, "100", "the bucket rides as xbc");
    eq(read.rebookToken, TOKEN, "the token reads back through /book's reader");
    eq(read.externalId, null, "no Lead id on the URL");
    eq(JSON.stringify(read.link), JSON.stringify({ name: "", email: "", phone: "" }), "no details on the URL");
    assert(!(REBOOK_PARAM in read.prefill), "the token is kept out of prefill, which reaches webhooks");
  }

  // --- a malformed token is refused before any read ---------------------------
  for (const bad of ["", "short", "has space in it here ok", "x".repeat(65), "drop'table--aaaaaaaaaaa"]) {
    eq(readBookEntryQuery({ [REBOOK_PARAM]: bad }).rebookToken, null, `malformed token ${JSON.stringify(bad)} is ignored`);
  }

  // --- the identity fills the form, the Lead id and the source ---------------
  {
    const entry = withRebookIdentity(readBookEntryQuery(searchParamsOf(rebookHref({ bucketCode: "100", manageToken: TOKEN }))), ROW);
    eq(entry.externalId, "00QUi00000ABCdeMAH", "the Lead id /book routes and recognises on");
    eq(entry.link.name, "Dana O'Neil", "name");
    eq(entry.link.email, "dana+test@example.com", "email");
    eq(entry.link.phone, "+12155550100", "phone");
    eq(readBookingSource(entry.prefill).source, "my-offers-result", "the original page's source is recorded again");
  }

  // --- a host page's own values win over the stored ones ----------------------
  {
    const entry = withRebookIdentity(
      readBookEntryQuery({ xbc: "100", external_id: "00QHOST", email: "host@example.com", source: "booking", [REBOOK_PARAM]: TOKEN }),
      ROW,
    );
    eq(entry.externalId, "00QHOST", "the link's Lead id wins");
    eq(entry.link.email, "host@example.com", "the link's email wins");
    eq(entry.link.name, "Dana O'Neil", "a field the link left blank is filled");
    eq(entry.prefill.source, "booking", "the link's source wins");
  }

  // --- no Lead id: the details still fill, nothing is invented ----------------
  {
    const entry = withRebookIdentity(readBookEntryQuery({ xbc: "100" }), { ...ROW, salesforce_id: null, attendee_phone: null });
    eq(entry.externalId, null, "no Lead id: none invented");
    eq(entry.link.email, "dana+test@example.com", "the email still fills");
    eq(entry.link.phone, "", "no phone: none invented");
  }

  // --- only a PAGE source is carried ------------------------------------------
  for (const source of ["not-given", "unrecognised", "api-regal", "api-canary", null]) {
    const entry = withRebookIdentity(readBookEntryQuery({ xbc: "100" }), { ...ROW, source });
    assert(!("source" in entry.prefill), `a stored ${source} is not recorded as the page`);
  }

  // --- no row leaves the query untouched --------------------------------------
  {
    const entry = readBookEntryQuery({ xbc: "100", [REBOOK_PARAM]: TOKEN });
    eq(withRebookIdentity(entry, null), entry, "a token that resolved to nothing changes nothing");
  }

  // --- the lookup: one read, and every way it can fail is a quiet null --------
  {
    const asked: string[] = [];
    const warned: string[] = [];
    const deps = (answer: () => Promise<{ data: RebookRow | null; error: unknown }>) => ({
      readByToken: (t: string) => {
        asked.push(t);
        return answer();
      },
      warn: (msg: string, err: unknown) => warned.push(`${msg} ${String(err)}`),
    });

    eq(await loadRebookRow(null, deps(async () => ({ data: ROW, error: null }))), null, "no token: null");
    eq(asked.length, 0, "no token: no read at all");

    eq(await loadRebookRow(TOKEN, deps(async () => ({ data: ROW, error: null }))), ROW, "a cancelled booking resolves");
    eq(asked.at(-1), TOKEN, "read by exactly the token");
    eq((await loadRebookRow(TOKEN, deps(async () => ({ data: { ...ROW, status: "completed" }, error: null }))))?.status, "completed", "a completed call resolves too (its page offers the rebook)");

    eq(await loadRebookRow(TOKEN, deps(async () => ({ data: null, error: null }))), null, "unknown token: null");
    for (const status of ["confirmed", "rescheduled", "no_show"]) {
      eq(await loadRebookRow(TOKEN, deps(async () => ({ data: { ...ROW, status }, error: null }))), null, `a ${status} booking is not a rebook`);
    }
    eq(warned.length, 0, "an unknown or other state token is silent");

    eq(await loadRebookRow(TOKEN, deps(async () => ({ data: null, error: new Error("boom") }))), null, "a failed read: null");
    eq(await loadRebookRow(TOKEN, deps(async () => { throw new Error("network"); })), null, "a thrown read: null");
    eq(warned.length, 2, "both failures are logged");
    assert(warned.every((w) => !w.includes(TOKEN)), "the token is never logged");
    assert(warned.every((w) => !w.includes("dana")), "nothing about the lead is logged");
  }

  // --- /book and the manage page really use these ------------------------------
  {
    const book = readFileSync("src/app/book/page.tsx", "utf8");
    assert(book.includes("readBookEntryQuery("), "/book reads its query through readBookEntryQuery");
    assert(book.includes("withRebookIdentity("), "/book applies the rebook identity");
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
