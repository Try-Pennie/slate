// Whether a lead's saved texting line is still alive, asked of Sendblue (#3718). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-sendblue-line-state.ts
//
// Slate keeps the texting line it gave a lead and offers it again on every press, and
// replaces it only when Sendblue says the line is gone (Dan, 2026-10-15). "Gone" is the
// rule Pennie's own Number Management workflows already apply: offline, does not support
// iMessage, or not found. Every other answer (our key refused, an outage, a body of a
// shape nobody has seen, no answer in time, no key configured) is UNKNOWN, and unknown
// keeps the saved line, because a Sendblue problem is not evidence the line is dead.
// The answer shapes are the ones Sendblue gave on 2026-10-15, read from Dan's Mac.
import { sendblueLineState, SENDBLUE_STATE_DEADLINE_MS } from "../src/lib/automations/sendblue-line-state.ts";
import type { ScheduleTimer } from "../src/lib/read-within-deadline.ts";
import { assert, eq, finish } from "./lib/harness.ts";

type Seen = { url: string; headers: Record<string, string> };
function sendblue(status: number, body: unknown) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { seen, fetchImpl };
}
const never: ScheduleTimer = () => () => {};
const KEYS = { keyId: "id-123", secret: "secret-456" };
const LINE = "+12125550188";

{
  const { seen, fetchImpl } = sendblue(200, { status: "OK", message: "Number is online", phone_number: LINE });
  const errs: unknown[] = [];
  eq(await sendblueLineState(LINE, { ...KEYS, fetchImpl, timer: never, onUnread: (e) => errs.push(e) }), "alive", "OK, online: alive");
  eq(seen.length, 1, "one request");
  eq(seen[0]?.url, "https://api.sendblue.co/status/%2B12125550188", "to Sendblue's status for that one line, the + encoded");
  eq(seen[0]?.headers["sb-api-key-id"], "id-123", "with the key id");
  eq(seen[0]?.headers["sb-api-secret-key"], "secret-456", "and the secret");
  eq(errs.length, 0, "and nothing reported");
}
for (const [why, status, body] of [
  ["not found", 404, { status: "NOT FOUND", message: "Number not found", phone_number: LINE }],
  ["not iMessage", 200, { status: "ERROR", message: "Number does not support iMessage", phone_number: LINE }],
  ["offline", 200, { status: "ERROR", message: "Number is offline", phone_number: LINE }],
] as const) {
  const { fetchImpl } = sendblue(status, body);
  eq(await sendblueLineState(LINE, { ...KEYS, fetchImpl, timer: never, onUnread: () => {} }), "dead", `${why}: dead`);
}
for (const [why, status, body] of [
  ["our key refused", 401, { status: "ERROR", message: "Invalid Credentials" }],
  ["an outage", 503, "upstream unavailable"],
  ["an error nobody has named", 200, { status: "ERROR", message: "Something new" }],
  ["a body that is not JSON", 200, "<html>"],
  ["OK with no message", 200, { status: "OK" }],
] as const) {
  const { fetchImpl } = sendblue(status, body);
  const errs: unknown[] = [];
  eq(await sendblueLineState(LINE, { ...KEYS, fetchImpl, timer: never, onUnread: (e) => errs.push(e) }), "unknown", `${why}: unknown, so the saved line is kept`);
  eq(errs.length, 1, `${why}: reported once, so the logs say why`);
}
{
  // "OK with no message" above is unknown on purpose: alive needs both halves Sendblue
  // sends for a live line, so a half answer never counts as proof the line works.
  const { fetchImpl } = sendblue(200, { status: "ok", message: "number is ONLINE" });
  eq(await sendblueLineState(LINE, { ...KEYS, fetchImpl, timer: never, onUnread: () => {} }), "alive", "case does not matter");
}
{
  const { seen, fetchImpl } = sendblue(200, { status: "OK", message: "Number is online" });
  const errs: unknown[] = [];
  eq(await sendblueLineState(LINE, { keyId: "", secret: "x", fetchImpl, timer: never, onUnread: (e) => errs.push(e) }), "unknown", "no key id: unknown");
  eq(await sendblueLineState(LINE, { keyId: "x", secret: " ", fetchImpl, timer: never, onUnread: (e) => errs.push(e) }), "unknown", "no secret: unknown");
  eq(seen.length, 0, "and Sendblue is never asked without both");
  eq(errs.length, 0, "and nothing failed, so nothing is reported");
}
{
  // Cloudflare's fetch throws "Illegal invocation" when called as a method of another object.
  const strictFetch = function (this: unknown) {
    if (this !== undefined) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(JSON.stringify({ status: "OK", message: "Number is online" }), { status: 200 }));
  } as unknown as typeof fetch;
  eq(await sendblueLineState(LINE, { ...KEYS, fetchImpl: strictFetch, timer: never, onUnread: () => {} }), "alive", "fetch is called bare, as Cloudflare's fetch requires");
}
{
  // Sendblue never answers: the deadline wins, on a timer this test fires itself.
  let fire: () => void = () => {};
  let askedMs = 0;
  const timer: ScheduleTimer = (ms, f) => {
    askedMs = ms;
    fire = f;
    return () => {};
  };
  const fetchImpl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const errs: unknown[] = [];
  const pending = sendblueLineState(LINE, { ...KEYS, fetchImpl, timer, onUnread: (e) => errs.push(e) });
  await Promise.resolve();
  fire();
  eq(await pending, "unknown", "no answer in time: unknown");
  eq(askedMs, SENDBLUE_STATE_DEADLINE_MS, "on the deadline this module names");
  assert(SENDBLUE_STATE_DEADLINE_MS <= 1_000, "short enough to leave the rest of the confirmation's wait for the service");
  eq(errs.length, 1, "and the timeout is reported");
}

finish();
