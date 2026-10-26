/**
 * #3105 / #3138: what the tail worker ships to Better Stack, and what it never does.
 *
 * Every redaction is tested in BOTH directions on real shaped input: the thing
 * that must go is gone, and the thing a reader needs (the route, the status, a
 * slot time, a lane's timing) is still there. A redaction checked only for what it
 * removes is satisfied by one that removes everything (L104).
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-log-shipping.ts
 */
import { formatLine } from "../src/lib/log.ts";
import { laneTimingFields } from "../src/lib/monitor/lane-timing.ts";
import { parseSlateLine } from "../src/lib/log-shipping/parse-line.ts";
import { recordsFromTraces, type TraceItemLike } from "../src/lib/log-shipping/records.ts";
import { REDACTED_SEGMENT, redactText, redactTokenPaths, redactUrl } from "../src/lib/log-shipping/redact.ts";
import {
  MAX_REQUESTS,
  POST_TIMEOUT_MS,
  droppedCount,
  packBatches,
  shipRecords,
  type ShipConfig,
} from "../src/lib/log-shipping/ship.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MANAGE_TOKEN = "mt".repeat(12);
const LINK_TOKEN = "9f".repeat(32);

// ------------------------------------------------------------- urls

{
  // The booker's own address: the lead's details ride in the query, percent encoded.
  const url =
    "https://slate.trypennie.app/booking/00QUi00000NCAkkIAH?xbc=100&name=Jane%20Smith&email=jane%40example.com&phone=%28555%29%20123-4567#step2";
  const out = redactUrl(url);
  eq(out, "https://slate.trypennie.app/booking/00QUi00000NCAkkIAH", "the query and fragment are cut whole");
  assert(!/jane|smith|example|555|%40/i.test(out), "no part of the encoded contact data survives");
  assert(out.includes("/booking/00QUi00000NCAkkIAH"), "and the Salesforce id path, safe to keep, is kept");
}

{
  const out = redactUrl(`https://slate.trypennie.app/booking/manage/${MANAGE_TOKEN}?r=1`);
  eq(out, `https://slate.trypennie.app/booking/manage/${REDACTED_SEGMENT}`, "a manage token segment is replaced");
  const rebook = redactUrl(`/booking/manage/${MANAGE_TOKEN}/rebook`);
  eq(rebook, `/booking/manage/${REDACTED_SEGMENT}/rebook`, "and the sub route after it is kept");
}

{
  eq(
    redactUrl(`https://slate.trypennie.app/api/bookings/${MANAGE_TOKEN}/cancel`),
    `https://slate.trypennie.app/api/bookings/${REDACTED_SEGMENT}/cancel`,
    "the manage token on the cancel route the manage page posts to",
  );
  eq(
    redactUrl(`/api/bookings/${MANAGE_TOKEN}/phone`),
    `/api/bookings/${REDACTED_SEGMENT}/phone`,
    "and on the phone route",
  );
  // The static siblings are other routes, not tokens: eating them would hide which
  // endpoint a failing request hit.
  for (const sibling of ["cancel", "bookable", "reassign", "cancel-duplicate"]) {
    eq(redactUrl(`/api/bookings/${sibling}`), `/api/bookings/${sibling}`, `/api/bookings/${sibling} is a route and is kept`);
  }
  eq(redactUrl("/api/bookings"), "/api/bookings", "the collection route is kept");
}

{
  eq(
    redactUrl(`/book/advisor/${LINK_TOKEN}`),
    `/book/advisor/${REDACTED_SEGMENT}`,
    "a legacy advisor link token is replaced",
  );
  eq(redactUrl("/booking/manage"), "/booking/manage", "a bare prefix with no segment is untouched");
  eq(redactUrl("/admin/bookings/3f0c2d1e-1111-4222-8333-944455556666"), "/admin/bookings/3f0c2d1e-1111-4222-8333-944455556666", "an internal booking uuid is kept");
}

{
  // Path variants a request can arrive with (review finding 3): each is normalised
  // before the token match, or the token ships.
  const variants = [
    `//booking/manage/${MANAGE_TOKEN}`,
    `/booking//manage/${MANAGE_TOKEN}`,
    `/booking%2Fmanage%2F${MANAGE_TOKEN}`,
    `/booking%2fmanage/${MANAGE_TOKEN}`,
    `/Booking/Manage/${MANAGE_TOKEN}`,
    `/BOOKING/MANAGE/${MANAGE_TOKEN}/rebook`,
    `https://slate.trypennie.app//booking/manage/${MANAGE_TOKEN}`,
    `/booking/manage/${MANAGE_TOKEN}/`,
    `//api//bookings/${MANAGE_TOKEN}/cancel`,
    `/API/Bookings/${MANAGE_TOKEN}/phone`,
    `/book/advisor%2F${LINK_TOKEN}`,
  ];
  for (const v of variants) {
    const out = redactUrl(v);
    assert(!out.includes(MANAGE_TOKEN) && !out.includes(LINK_TOKEN), `the token is gone from ${v} (got ${out})`);
    assert(out.includes(REDACTED_SEGMENT), `and replaced by the marker in ${v}`);
    const text = redactText(`failed at ${v} for a lead`);
    assert(!text.includes(MANAGE_TOKEN) && !text.includes(LINK_TOKEN), `and from free text quoting ${v} (got ${text})`);
  }
  // Controls the other way: normalising must not invent a redaction or eat a route.
  eq(redactUrl("//api//bookings/cancel"), "/api/bookings/cancel", "a doubled slash before a static sibling still keeps it");
  eq(redactUrl("/API/Bookings/Cancel"), "/api/bookings/cancel", "and so does a case variant of one");
  eq(redactUrl("/booking/00QUi00000NCAkkIAH"), "/booking/00QUi00000NCAkkIAH", "a Salesforce id keeps its case");
  eq(
    redactUrl("https://slate.trypennie.app/admin/bookings/3f0c2d1e"),
    "https://slate.trypennie.app/admin/bookings/3f0c2d1e",
    "the scheme's own double slash is never collapsed",
  );
  eq(redactText("see /booking/manage"), "see /booking/manage", "a bare prefix in text is untouched");
}

{
  // A token path inside free text, wherever it sits (review of #3160): inside a
  // query value, encoded or not, after a colon or an equals sign, in a JSON string,
  // glued to punctuation, mid sentence.
  const embedded = [
    `redirect to /login?next=/booking/manage/${MANAGE_TOKEN} refused`,
    `redirect to /login?next=%2Fbooking%2Fmanage%2F${MANAGE_TOKEN} refused`,
    `https://slate.trypennie.app/login?next=/booking/manage/${MANAGE_TOKEN}&x=1`,
    `POST /api/bookings/${MANAGE_TOKEN}/cancel returned 500`,
    `path:/api/bookings/${MANAGE_TOKEN}/phone`,
    `{"path":"/booking/manage/${MANAGE_TOKEN}","status":404}`,
    `url=/book/advisor/${LINK_TOKEN},status=200`,
    `see [/booking/manage/${MANAGE_TOKEN}]`,
    `GET\t/booking/manage/${MANAGE_TOKEN}`,
    `at /booking/manage/${MANAGE_TOKEN}:12:4`,
  ];
  for (const text of embedded) {
    const out = redactText(text);
    assert(!out.includes(MANAGE_TOKEN) && !out.includes(LINK_TOKEN), `no token survives in "${text}" (got ${out})`);
  }
  // The other direction: the surrounding text, and paths that are not token routes,
  // are untouched.
  eq(
    redactText(`POST /api/bookings/${MANAGE_TOKEN}/cancel returned 500`),
    `POST /api/bookings/${REDACTED_SEGMENT}/cancel returned 500`,
    "the sentence around a mid sentence token path is kept word for word",
  );
  eq(
    redactText(`{"path":"/booking/manage/${MANAGE_TOKEN}","status":404}`),
    `{"path":"/booking/manage/${REDACTED_SEGMENT}","status":404}`,
    "and a JSON string keeps its quotes",
  );
  eq(redactText("POST /api/bookings/cancel returned 500"), "POST /api/bookings/cancel returned 500", "a static route in text is kept");
  eq(redactText("lane /api/cron/recompute took 5101ms"), "lane /api/cron/recompute took 5101ms", "an unrelated path is kept");
}

// ------------------------------------------------------------- free text

{
  const text = `manage link sent to jane.smith@example.com: https://slate.trypennie.app/booking/manage/${MANAGE_TOKEN}?utm=x, call (555) 123-4567 at 2026-10-03T14:30:00Z`;
  const out = redactText(text);
  assert(!out.includes(MANAGE_TOKEN), "a token quoted inside a sentence is removed");
  assert(!out.includes("jane.smith@example.com") && out.includes("[email]"), "an email is replaced by the shared scrub");
  assert(!out.includes("123-4567") && out.includes("[phone]"), "a phone number is replaced");
  assert(!out.includes("utm=x"), "a query attached to a URL in text is cut");
  assert(out.includes("2026-10-03T14:30:00Z"), "and a slot time, which is the diagnosis, survives");
  assert(out.startsWith("manage link sent to"), "the sentence itself survives");
}

{
  // The scrub is the shared one, not a copy: a long digit run is caught exactly as
  // the client error beacon catches it.
  assert(redactText("account 123456789012").includes("[number]"), "a long digit run is replaced");
  eq(redactTokenPaths("no paths here"), "no paths here", "text with no path is returned unchanged");
}

// ------------------------------------------------------------- the line parser

{
  const line = formatLine("cron", {
    msg: "lane timings",
    cron: "* * * * *",
    ...laneTimingFields(
      [
        { path: "/api/cron/sync", ms: 1200.4, ok: true },
        { path: "/api/cron/recompute", ms: 5100.6, ok: false },
      ],
      5400.2,
    ),
  });
  const fields = parseSlateLine(line);
  assert(fields !== null, "a slate line parses");
  eq(fields?.tag, "cron", "its tag");
  eq(fields?.msg, "lane timings", "a quoted value with spaces stays one field");
  eq(fields?.cron, "* * * * *", "including one made of spaces and stars");
  eq(fields?.total_ms, 5400, "a timing arrives as a NUMBER, so Better Stack can chart it");
  eq(fields?.recompute_ms, 5101, "each lane has its own field");
  eq(fields?.lanes_ok, 1, "the count of lanes that succeeded");
  eq(fields?.lanes_failed, 1, "and the count that failed (#3138)");
  eq(fields?.failed, "recompute", "and which one");
}

{
  const fields = parseSlateLine(formatLine("booking", { msg: 'said "hi"', ok: true, n: 0 }));
  eq(fields?.msg, 'said "hi"', "an escaped quote inside a value round trips");
  eq(fields?.ok, true, "a boolean arrives as a boolean");
  eq(fields?.n, 0, "a zero arrives as a number, not as missing");
  eq(parseSlateLine("Warning: something from a library"), null, "a line that is not ours is not parsed");
}

{
  // #4237 (L809): a value a stranger wrote round trips as ONE field, whatever it
  // holds, so a forged csp-report cannot plant `paged=true` among the parsed fields.
  const BACKSLASH = "\u005c";
  const nasty = [
    `x${BACKSLASH}" paged=true`,
    `ends in a backslash${BACKSLASH}`,
    `${BACKSLASH}${BACKSLASH}" paged=true`,
    `one\u000aslate tag=forged paged=true\u000d\u000atwo`,
    `tab\u0009nul\u0000esc\u001bdel\u007fsep\u2028end`,
    `${BACKSLASH}n is not a line feed, ${BACKSLASH}u0041 is not an A`,
  ];
  for (const value of nasty) {
    const fields = parseSlateLine(formatLine("csp-report", { blocked: value, paged: false }));
    eq(fields?.blocked, value, `the value round trips exactly: ${JSON.stringify(value)}`);
    eq(fields?.paged, false, `and the real paged field is untouched: ${JSON.stringify(value)}`);
    eq(Object.keys(fields ?? {}).sort().join(","), "blocked,paged,tag", `and no forged key appears: ${JSON.stringify(value)}`);
  }
  // A line written before #4237 held a lone backslash before an ordinary letter;
  // it still reads as the text it was.
  eq(parseSlateLine(String.raw`slate tag=t path="C:\Users\Dan"`)?.path, String.raw`C:\Users\Dan`, "an unknown escape keeps its backslash");
}

// ------------------------------------------------------------- records

const VERSION = "7a1b2c3d-0000-4000-8000-123456789abc";

function fetchItem(url: string, logs: TraceItemLike["logs"], exceptions: TraceItemLike["exceptions"] = []): TraceItemLike {
  return {
    event: { request: { method: "GET", url }, response: { status: 200 } },
    eventTimestamp: 1_790_000_000_000,
    logs,
    exceptions,
    scriptName: "slate",
    scriptVersion: { id: VERSION },
    outcome: "ok",
    cpuTime: 4,
    wallTime: 120,
    truncated: false,
  };
}

{
  const records = recordsFromTraces([
    fetchItem(`https://slate.trypennie.app/booking/manage/${MANAGE_TOKEN}?x=jane%40example.com`, [
      {
        timestamp: 1_790_000_000_001,
        level: "error",
        message: [
          formatLine("manage", { msg: "cancel failed", email: "jane@example.com", status: 503 }),
          { name: "Error", message: "row for jane@example.com not found", stack: "Error: x\n    at y (/booking/manage/" + MANAGE_TOKEN + ")" },
        ],
      },
    ]),
  ]);
  eq(records.length, 2, "one invocation record and one log record");
  const [inv, line] = records;
  eq(inv.kind, "invocation", "the first is the invocation");
  eq(inv.url, `https://slate.trypennie.app/booking/manage/${REDACTED_SEGMENT}`, "its url is redacted");
  eq(inv.status, 200, "with the status");
  eq(inv.version_id, VERSION, "every record carries the deployed version (#3138)");
  eq(line.version_id, VERSION, "the log record too");
  eq(line.level, "error", "the console level is kept");
  const all = JSON.stringify(records);
  assert(!all.includes("jane@example.com") && !all.includes("jane%40"), "no email anywhere in what ships");
  assert(!all.includes(MANAGE_TOKEN), "no manage token anywhere in what ships, the Error argument's stack included");
  eq((line.fields as Record<string, unknown>).status, 503, "the parsed fields keep a number as a number");
  eq((line.fields as Record<string, unknown>).email, "[email]", "and a string field is scrubbed");
  assert(String(line.message).includes("cancel failed"), "the message keeps its diagnosis");
  assert(!("headers" in inv) && !("cf" in inv), "request headers and cf are never forwarded");
}

{
  const records = recordsFromTraces([
    {
      event: { cron: "* * * * *", scheduledTime: 1_790_000_000_000 },
      eventTimestamp: 1_790_000_000_000,
      logs: [],
      exceptions: [
        { timestamp: 1_790_000_000_002, name: "TypeError", message: "bad phone 555-123-4567", stack: "TypeError: bad\n at /api/bookings/" + MANAGE_TOKEN + "/phone" },
      ],
      scriptName: "slate",
      scriptVersion: { id: VERSION },
      outcome: "exception",
    },
  ]);
  const [inv, ex] = records;
  eq(inv.event, "scheduled", "a cron tick is a scheduled invocation");
  eq(inv.cron, "* * * * *", "with its expression");
  eq(inv.level, "error", "a non ok outcome is error level");
  eq(ex.kind, "exception", "an uncaught exception is its own record, which is what errors group on");
  eq(ex.error_name, "TypeError", "with its name");
  assert(!String(ex.message).includes("123-4567"), "its message is scrubbed");
  assert(!String(ex.stack).includes(MANAGE_TOKEN), "and its stack");
  assert(String(ex.stack).includes("/phone"), "while the route stays readable");
}

{
  // Review findings 1 and 2: the exception NAME is free text too, and a field that
  // parses as a number is still a phone number when it is ten digits.
  const records = recordsFromTraces([
    fetchItem(
      "/x",
      [{ timestamp: 1, level: "info", message: [formatLine("lead", { msg: "x", phone: 5551234567, attempts: 3 })] }],
      [{ timestamp: 2, name: "Error for jane@example.com", message: "boom" }],
    ),
  ]);
  const line = records.find((r) => r.kind === "log");
  const ex = records.find((r) => r.kind === "exception");
  const fields = line?.fields as Record<string, unknown>;
  assert(!JSON.stringify(fields).includes("5551234567"), "a ten digit numeric field is scrubbed before it becomes a number");
  eq(fields.phone, "[phone]", "and carries the marker");
  eq(fields.attempts, 3, "while a small count stays a number");
  eq(ex?.error_name, "Error for [email]", "the exception name is scrubbed");
}

{
  // Review of #3160: a field KEY can be built from data too, and a string field
  // value can quote a token path. Both go through the same scrub.
  const records = recordsFromTraces([
    fetchItem("/x", [
      {
        timestamp: 1,
        level: "warn",
        message: [`slate tag=x msg="redirect refused" next="/booking/manage/${MANAGE_TOKEN}" lead_5551234567=1 ok_key=2`],
      },
    ]),
  ]);
  const fields = records.find((r) => r.kind === "log")?.fields as Record<string, unknown>;
  const all = JSON.stringify(records);
  assert(!all.includes(MANAGE_TOKEN), "a token path in a string field value does not ship");
  eq(fields.next, `/booking/manage/${REDACTED_SEGMENT}`, "and the value keeps its route");
  assert(!Object.keys(fields).some((k) => k.includes("5551234567")), "a phone number inside a field key does not ship");
  eq(fields.ok_key, 2, "an ordinary key and its number are untouched");
}

{
  // #4237: the shipped copy. Redaction runs over the line, so a redaction that eats
  // the backslash of an escaped quote (a token path or a query string ending at it)
  // would hand the parser a closed quote and a forged field.
  const records = recordsFromTraces([
    fetchItem("/x", [
      {
        timestamp: 1,
        level: "warn",
        message: [
          formatLine("csp-report", {
            document: `/booking/manage/${MANAGE_TOKEN}" forged_path=1`,
            blocked: `https://slate.trypennie.app/book?email=jane%40example.com" forged_query=1`,
            paged: false,
            not_paged: "report-only",
            phone: 5551234567,
          }),
        ],
      },
    ]),
  ]);
  const fields = records.find((r) => r.kind === "log")?.fields as Record<string, unknown>;
  eq(fields.forged_path, undefined, "a redacted token path cannot forge a field in what ships");
  eq(fields.forged_query, undefined, "nor can a stripped query string");
  eq(fields.paged, false, "and the real fields keep their values");
  eq(Object.keys(fields).sort().join(","), "blocked,document,not_paged,paged,phone,tag", "and no other key appears");
  assert(!JSON.stringify(records).includes(MANAGE_TOKEN), "the token is still redacted");
  assert(!JSON.stringify(records).includes("jane%40"), "and the query string still stripped");
  eq(fields.phone, "[phone]", "and a numeric phone field still carries the marker");
}

// #4237 review: the shipped MESSAGE is the line as text, and the line now writes a
// line break inside a value as backslash n. The contact scrub needs a word boundary
// or a separator between a phone's groups, so scrubbing that escaped text let a
// phone after an escaped control character ship in the clear. Invented values only.
const PHONE_LEAK = /555\D{0,6}123\D{0,6}4567/;
function shippedLog(message: unknown[]): { message: string; fields: Record<string, unknown> } {
  const line = recordsFromTraces([fetchItem("/x", [{ timestamp: 1, level: "error", message }])]).find((r) => r.kind === "log");
  return { message: String(line?.message), fields: (line?.fields ?? {}) as Record<string, unknown> };
}

{
  const values = [
    "Call me on\u000a555-123-4567 please",
    "phone:\u0009555.123.4567",
    "x\u000d\u000a555 123 4567",
    "555\u000a123\u000a4567",
    "555\u000d123\u000d4567",
    "555\u0009123\u00094567",
    "(555)\u000a123-4567",
  ];
  for (const value of values) {
    const { message, fields } = shippedLog([formatLine("probe", { detail: value })]);
    assert(!PHONE_LEAK.test(message), `the message never ships the phone: ${JSON.stringify(value)} (got ${message})`);
    assert(message.includes("[phone]"), `the message carries the marker instead: ${JSON.stringify(value)}`);
    assert(!PHONE_LEAK.test(String(fields.detail)), `nor does the field: ${JSON.stringify(value)}`);
    assert(String(fields.detail).includes("[phone]"), `and the field carries the marker: ${JSON.stringify(value)}`);
  }
}

{
  // The same class, older than #4237: an object console argument was stringified
  // BEFORE the scrub, and JSON writes a line break as backslash n too.
  const { message } = shippedLog([formatLine("x", { msg: "y" }), { message: "note\u000a555-123-4567", nested: { at: "c\u000ajane.doe@example.com" } }]);
  assert(!PHONE_LEAK.test(message), `an object argument never ships a phone after a line break (got ${message})`);
  assert(!message.includes("jane.doe"), "nor a nested email after one");
  assert(message.includes("[phone]") && message.includes("[email]"), "both carry their markers");
  const plain = shippedLog([formatLine("x", { msg: "y" }), "and 555-123-4567 as a string argument", 5551234567]);
  assert(!PHONE_LEAK.test(plain.message), "a string or numeric extra argument is scrubbed as before");
}

{
  // The message and the fields can never disagree: the message read back as fields
  // IS the shipped fields, so nothing scrubbed out of one survives in the other.
  const BACKSLASH = "\u005c";
  const samples: Record<string, string | number | boolean>[] = [
    { detail: "Call me on\u000a555-123-4567 please" },
    { detail: "(555)\u000a123-4567", n: 5551234567 },
    { ua: `jane.doe@example.com${BACKSLASH}" forged=1` },
    { u: `/booking/manage/${MANAGE_TOKEN}\u000apaged=true` },
    { u: "/book?name=secretname&email=jane.doe%40example.com\u000anext line" },
    { u: `/book?name=secret${BACKSLASH}name&x=1`, ok: true },
    { blocked: `x${BACKSLASH}" paged=true`, paged: false },
    { msg: "lane timings", total_ms: 5400.2, lanes_ok: 3 },
  ];
  for (const sample of samples) {
    const { message, fields } = shippedLog([formatLine("probe", sample)]);
    eq(JSON.stringify(parseSlateLine(message)), JSON.stringify(fields), `the message reads back as the shipped fields: ${JSON.stringify(sample)}`);
    for (const secret of [PHONE_LEAK, /jane\.doe/, /secretname/, new RegExp(MANAGE_TOKEN)]) {
      assert(!secret.test(message) && !secret.test(JSON.stringify(fields)), `${secret} ships in neither: ${JSON.stringify(sample)}`);
    }
  }
  // A line with nothing to scrub ships exactly as it was written.
  const clean = formatLine("cron", { msg: "lane timings", total_ms: 5400.2, ok: true, url: "/api/cron/sync" });
  eq(shippedLog([clean]).message, clean, "an ordinary line's message is the line itself");
}

{
  const [inv] = recordsFromTraces([{ ...fetchItem("/x", []), scriptVersion: undefined }]);
  eq(inv.version_id, null, "no version reads as null, never as a guessed id");
}

// ------------------------------------------------------------- shipping

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const GOOD: ShipConfig = { token: "tok_abc", host: "s123.us-east-9.betterstackdata.com" };
const sample = recordsFromTraces([fetchItem("/x", [{ timestamp: 1, level: "info", message: ["slate tag=a msg=\"b\""] }])]);

await (async () => {
  const { fn, calls } = fakeFetch(() => new Response("", { status: 202 }));
  const out = await shipRecords(sample, GOOD, fn);
  eq(out.sent, sample.length, "every record is sent");
  eq(droppedCount(out), 0, "and nothing is dropped");
  eq(calls.length, 1, "in one request");
  eq(calls[0].url, "https://s123.us-east-9.betterstackdata.com/", "to the configured host over https");
  eq((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok_abc", "with the source token");
  const body = JSON.parse(String(calls[0].init.body)) as unknown[];
  eq(body.length, sample.length, "as one JSON array");
})();

await (async () => {
  // The secret is not set yet: drop and COUNT, never throw, never call out.
  for (const [config, reason] of [
    [{ token: undefined, host: GOOD.host }, "no-token"],
    [{ token: "  ", host: GOOD.host }, "no-token"],
    [{ token: GOOD.token, host: "" }, "no-host"],
    [{ token: GOOD.token, host: "https://s123.betterstackdata.com/" }, "bad-host"],
  ] as const) {
    const { fn, calls } = fakeFetch(() => new Response("", { status: 202 }));
    const out = await shipRecords(sample, config, fn);
    eq(out.dropped[reason], sample.length, `${reason}: every record is counted as dropped`);
    eq(calls.length, 0, `${reason}: and nothing is sent`);
  }
})();

await (async () => {
  const refused = fakeFetch(() => new Response("bad token", { status: 401 }));
  const out = await shipRecords(sample, GOOD, refused.fn);
  eq(out.dropped.refused, sample.length, "a refused POST is counted");
  eq(JSON.stringify(out.refusedStatuses), "[401]", "with its status");
  eq(refused.calls.length, 1, "and not retried");

  const down = fakeFetch(() => {
    throw new Error("network down");
  });
  const out2 = await shipRecords(sample, GOOD, down.fn);
  eq(out2.dropped.unreachable, sample.length, "a thrown fetch is counted, not rethrown");
})();

await (async () => {
  // Review of #3160: a 401 (wrong token, never heals) followed by a 503 (their
  // outage, heals) must not report only the 503. Every distinct status is kept,
  // in the order seen.
  const statuses = [401, 503];
  const many = recordsFromTraces(
    Array.from({ length: 20 }, () => fetchItem("/x", [{ timestamp: 1, level: "info", message: ["x".repeat(500)] }])),
  );
  const mixed = fakeFetch(() => new Response("", { status: statuses.shift() ?? 500 }));
  const out = await shipRecords(many, GOOD, mixed.fn, { maxBatchBytes: 8000 });
  eq(mixed.calls.length, 2, "two requests went");
  eq(JSON.stringify(out.refusedStatuses), "[401,503]", "and both refusals are reported, the 401 included");

  const same = fakeFetch(() => new Response("", { status: 401 }));
  const out2 = await shipRecords(many, GOOD, same.fn, { maxBatchBytes: 8000 });
  eq(JSON.stringify(out2.refusedStatuses), "[401]", "a repeated status is listed once");

  const ok = fakeFetch(() => new Response("", { status: 202 }));
  const out3 = await shipRecords(many, GOOD, ok.fn, { maxBatchBytes: 8000 });
  eq(out3.refusedStatuses, undefined, "and none is reported when nothing was refused");
})();

await (async () => {
  // A log storm: far more than fits. The request count is bounded and the rest is
  // counted rather than queued.
  const many = recordsFromTraces(
    Array.from({ length: 50 }, () => fetchItem("/x", [{ timestamp: 1, level: "info", message: ["x".repeat(500)] }])),
  );
  const { fn, calls } = fakeFetch(() => new Response("", { status: 202 }));
  const out = await shipRecords(many, GOOD, fn, { maxBatchBytes: 4000 });
  eq(calls.length, MAX_REQUESTS, "never more than the per invocation request budget");
  assert((out.dropped["over-budget"] ?? 0) > 0, "the overflow is counted as over budget");
  eq(out.sent + droppedCount(out), many.length, "every record is either sent or counted, none vanishes");
  for (const call of calls) {
    assert(new TextEncoder().encode(String(call.init.body)).length <= 4000, "and no request exceeds the batch size");
  }
})();

await (async () => {
  // Review finding 4: a POST that never answers must not hold the tail invocation.
  // Every request carries an abort signal, and a timeout is its own drop reason.
  let signal: AbortSignal | undefined;
  const hang = fakeFetch(
    (call) =>
      new Promise<Response>((_resolve, reject) => {
        signal = call.init.signal ?? undefined;
        call.init.signal?.addEventListener("abort", () => reject(call.init.signal?.reason));
      }),
  );
  const started = Date.now();
  // Node does not hold the process open for AbortSignal.timeout's own timer, so
  // without this a run with nothing else pending exits before the abort fires.
  const keepAlive = setTimeout(() => {}, 5_000);
  const out = await shipRecords(sample, GOOD, hang.fn, { timeoutMs: 20 });
  clearTimeout(keepAlive);
  assert(signal !== undefined, "the POST carries an abort signal");
  eq(out.dropped.timeout, sample.length, "a timed out POST is counted as a timeout");
  assert(out.dropped.unreachable === undefined, "and not folded into unreachable");
  assert(Date.now() - started < 2000, "and the wait is bounded by the timeout");
  assert(POST_TIMEOUT_MS > 0 && POST_TIMEOUT_MS <= 10_000, "the default timeout sits well inside the tail invocation's limit");
})();

{
  const { batches, oversized } = packBatches(sample, 10);
  eq(batches.length, 0, "a record bigger than the batch limit alone is not sent");
  eq(oversized, sample.length, "and is counted");
}

finish();
