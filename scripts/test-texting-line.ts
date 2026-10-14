// The texting line a lead can message after pressing Call me now (#3718). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-texting-line.ts
//
// Asked of Pennie's automations service at `/get-phone-line`, as trypennie.com asks it
// on its Call me now page. What this file pins, on an injected fetch and timer:
//  - FAIL CLOSED (Dan, 2026-10-14): with no service address configured nothing is
//    asked and the answer is no line, never an error, so the card simply shows no
//    Text us until the address is set;
//  - the request is what trypennie sends: POST, the lead's phone as digits, and the
//    submission id when there is one;
//  - only a valid phone number is ever returned; anything else (a refusal, a body
//    that is not the expected shape, `success: false`, a number that does not parse)
//    is no line, and a failure is reported so the logs say why;
//  - the lead is never kept waiting: past the deadline the answer is no line, on an
//    injected timer rather than a real one (L524).
import { readTextingLine, TEXTING_LINE_DEADLINE_MS } from "../src/lib/automations/texting-line.ts";
import type { ScheduleTimer } from "../src/lib/read-within-deadline.ts";
import { assert, eq, finish } from "./lib/harness.ts";

type Seen = { url: string; method?: string; body?: unknown };
function service(status: number, body: unknown) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { seen, fetchImpl };
}
const never: ScheduleTimer = () => () => {};
const OK = { success: true, date: "2026-10-14", phoneNumber: "+12125550188", usageCount: 3 };
const LEAD = { phone: "(219) 758-8170", submissionId: "a0XUi000001" };

{
  const { seen, fetchImpl } = service(200, OK);
  const errs: unknown[] = [];
  const line = await readTextingLine(LEAD, { baseUrl: "", fetchImpl, timer: never, onUnread: (e) => errs.push(e) });
  eq(line, null, "no service address: no line");
  eq(seen.length, 0, "and nothing is asked");
  eq(errs.length, 0, "and nothing is reported as a failure, since nothing failed");
}
{
  const { seen, fetchImpl } = service(200, OK);
  eq(await readTextingLine(LEAD, { baseUrl: "   ", fetchImpl, timer: never, onUnread: () => {} }), null, "a blank address is no address");
  eq(seen.length, 0, "and nothing is asked");
}
{
  const { seen, fetchImpl } = service(200, OK);
  const line = await readTextingLine(LEAD, { baseUrl: "https://automations.example/api/", fetchImpl, timer: never, onUnread: () => {} });
  eq(line, "+12125550188", "a valid answer is the line, in E.164");
  eq(seen.length, 1, "one request");
  eq(seen[0]?.url, "https://automations.example/api/get-phone-line", "to the service's get-phone-line, the trailing slash not doubled");
  eq(seen[0]?.method, "POST", "as a POST");
  eq(seen[0]?.body, { phone: "2197588170", submission_id: "a0XUi000001" }, "carrying the phone as digits and the submission id, as trypennie sends them");
}
{
  const { seen, fetchImpl } = service(200, OK);
  await readTextingLine({ phone: "2197588170", submissionId: null }, { baseUrl: "https://a.example", fetchImpl, timer: never, onUnread: () => {} });
  eq(seen[0]?.body, { phone: "2197588170" }, "no submission id is sent when there is none");
}
{
  const { seen, fetchImpl } = service(200, OK);
  eq(await readTextingLine({ phone: null, submissionId: null }, { baseUrl: "https://a.example", fetchImpl, timer: never, onUnread: () => {} }), null, "no phone to ask with: no line");
  eq(seen.length, 0, "and nothing is asked");
}
for (const [why, status, body] of [
  ["a refusal", 500, { error: "boom" }],
  ["success false", 200, { ...OK, success: false }],
  ["no number", 200, { success: true }],
  ["a number that does not parse", 200, { ...OK, phoneNumber: "TBD" }],
  ["a body that is not JSON", 200, "<html>"],
] as const) {
  const { fetchImpl } = service(status, body);
  const errs: unknown[] = [];
  eq(await readTextingLine(LEAD, { baseUrl: "https://a.example", fetchImpl, timer: never, onUnread: (e) => errs.push(e) }), null, `${why}: no line`);
  eq(errs.length, 1, `${why}: reported once, so the logs say why`);
}
{
  // The service never answers: the deadline wins, on a timer this test fires itself.
  let fire: () => void = () => {};
  let askedMs = 0;
  const timer: ScheduleTimer = (ms, f) => {
    askedMs = ms;
    fire = f;
    return () => {};
  };
  const fetchImpl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const errs: unknown[] = [];
  const pending = readTextingLine(LEAD, { baseUrl: "https://a.example", fetchImpl, timer, onUnread: (e) => errs.push(e) });
  await Promise.resolve();
  fire();
  eq(await pending, null, "a service that never answers: no line once the deadline passes");
  eq(askedMs, TEXTING_LINE_DEADLINE_MS, "and the deadline is the one this module names");
  assert(TEXTING_LINE_DEADLINE_MS <= 3_000, "short enough that a lead waiting on the confirmation is never held long");
  eq(errs.length, 1, "and the timeout is reported");
}

finish();
