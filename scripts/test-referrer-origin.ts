// The origin of the page that framed the booker, recorded on the booking (#2728).
//
// The off site page (#2715) judged only `prefill.parentOrigin`, the origin a host
// DECLARES, so a test page that declared none was invisible to it. The booker now
// sends the ORIGIN the browser says framed it, and the server re-reduces that value
// itself before storing it on `bookings.referrer_origin`.
//
// What this file pins:
//  - the client half sends an ORIGIN only, never the referrer's path or query
//    (which on a booking page can carry a lead's details), and only when the booker
//    is actually framed by a page other than Slate's own;
//  - the server half reduces whatever arrives to a bare origin, so a value with a
//    path and a query is stored as its origin, and anything that is not a web
//    origin is dropped rather than stored raw;
//  - the database CHECK in the migration accepts every value the server half can
//    produce and refuses a value carrying a path, so the constraint can never
//    refuse a booking the code would have made (the insert would fail the lead).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-referrer-origin.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  REFERRER_ORIGIN_MAX_CHARS,
  readReferrerOrigin,
  referrerOriginForConfirm,
} from "../src/lib/embed/referrer-origin.ts";

// --- the client half: what the booker puts on the confirm ------------------------
const SLATE = "https://slate.trypennie.app";
eq(
  referrerOriginForConfirm({ referrer: "https://partner.example/landing?email=k%40x.com&phone=555", ownOrigin: SLATE, framed: true }),
  "https://partner.example",
  "a framed booker sends the referrer's origin, never its path or query",
);
eq(
  referrerOriginForConfirm({ referrer: "http://localhost:3000/", ownOrigin: SLATE, framed: true }),
  "http://localhost:3000",
  "a localhost framer keeps its port",
);
eq(
  referrerOriginForConfirm({ referrer: "https://www.google.com/", ownOrigin: SLATE, framed: false }),
  null,
  "a booker that is not framed sends nothing: its referrer is whatever linked to it, not a host page",
);
eq(
  referrerOriginForConfirm({ referrer: `${SLATE}/book/100?embed=1`, ownOrigin: SLATE, framed: true }),
  null,
  "Slate's own origin says nothing about the host, so it is not sent",
);
eq(referrerOriginForConfirm({ referrer: "", ownOrigin: SLATE, framed: true }), null, "a stripped referrer sends nothing");
eq(referrerOriginForConfirm({ referrer: null, ownOrigin: SLATE, framed: true }), null, "no referrer sends nothing");
eq(referrerOriginForConfirm({ referrer: "about:blank", ownOrigin: SLATE, framed: true }), null, "an opaque referrer sends nothing");

// --- the server half: what is stored, whatever the client sent -------------------
eq(
  readReferrerOrigin("https://partner.example/landing?email=k%40x.com#top"),
  "https://partner.example",
  "a value with a path, a query and a fragment is stored as its origin only",
);
eq(readReferrerOrigin("https://trypennie.com"), "https://trypennie.com", "a bare origin is stored as itself");
eq(readReferrerOrigin("  https://www.trypennie.com/  "), "https://www.trypennie.com", "surrounding space is trimmed");
eq(readReferrerOrigin("HTTPS://TryPennie.com"), "https://trypennie.com", "the scheme and host are normalised the way the browser does");
eq(readReferrerOrigin("https://trypennie.com:443"), "https://trypennie.com", "a default port is the same origin");
eq(readReferrerOrigin("http://localhost:3000"), "http://localhost:3000", "a non default port is kept");
eq(readReferrerOrigin("http://[::1]:3000/x"), "http://[::1]:3000", "an IPv6 host reduces to its origin");
eq(readReferrerOrigin("not a url"), null, "a malformed value is dropped, never stored raw");
eq(readReferrerOrigin("<script>alert(1)</script>"), null, "markup is dropped");
eq(readReferrerOrigin("file:///tmp/host.html"), null, "a non web scheme is dropped");
eq(readReferrerOrigin("javascript:alert(1)"), null, "a script scheme is dropped");
eq(readReferrerOrigin("null"), null, "the opaque origin string is dropped");
eq(readReferrerOrigin(""), null, "an empty value is dropped");
eq(readReferrerOrigin("   "), null, "a blank value is dropped");
eq(readReferrerOrigin(undefined), null, "an absent value is null");
eq(readReferrerOrigin(null), null, "a null value is null");
eq(readReferrerOrigin(42), null, "a non string is dropped");
eq(readReferrerOrigin({ origin: "https://trypennie.com" }), null, "an object is dropped");
eq(
  readReferrerOrigin(`https://partner.example/${"a".repeat(REFERRER_ORIGIN_MAX_CHARS)}`),
  null,
  "a value longer than any real referrer is dropped rather than parsed",
);

// --- the database constraint agrees with the server half -------------------------
const dir = join(process.cwd(), "supabase/migrations");
const migrations = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ file, sql: readFileSync(join(dir, file), "utf8") }));
const defining = migrations.filter((m) => /bookings_referrer_origin_check/.test(m.sql));
eq(defining.length, 1, "exactly one migration defines bookings_referrer_origin_check");
const pattern = /referrer_origin\s*~\s*'([^']+)'/.exec(defining[0]?.sql ?? "")?.[1] ?? null;
assert(pattern !== null, `the constraint's pattern is readable (${pattern})`);
if (pattern !== null) {
  // Postgres spells whitespace as a POSIX class; JavaScript as \s.
  const re = new RegExp(pattern.replaceAll("[:space:]", "\\s"));
  const produced = [
    "https://partner.example/landing?email=k%40x.com",
    "https://trypennie.com",
    "http://localhost:3000",
    "http://[::1]:3000/x",
    "https://xn--bcher-kva.example/",
    "http://192.168.1.10:8080/",
  ].map(readReferrerOrigin);
  for (const value of produced) {
    assert(value !== null && re.test(value), `the constraint accepts what the server stores: ${value}`);
  }
  // Controls: the constraint really refuses what must never be stored.
  assert(!re.test("https://partner.example/landing?email=k%40x.com"), "control: the constraint refuses a path and a query");
  assert(!re.test("not a url"), "control: the constraint refuses garbage");
  assert(!re.test("javascript:alert(1)"), "control: the constraint refuses a script scheme");
}
assert(
  /char_length\(referrer_origin\)\s*<=\s*(\d+)/.exec(defining[0]?.sql ?? "")?.[1] === String(REFERRER_ORIGIN_MAX_CHARS),
  "the constraint's length ceiling is the server's own",
);

finish();
