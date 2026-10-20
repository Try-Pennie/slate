// The load test echo contract for the shared confirm line (#3325), driven offline.
//
// The deployment says which confirm line served a booking and when it built the
// answer, on headers sent under SLATE_LOADTEST only, and the load run's driver
// reads them back. Both sides import ONE definition from `src/lib/loadtest-echo.ts`
// (L41): the names, the allowed values, a pure builder and a pure parser. These
// cases pin the two halves against each other, in both directions:
//
//   - every value the builder can write, the parser reads back as that value;
//   - a header the deployment did not send reads as ABSENT, and one it sent that
//     the contract does not know reads as UNREADABLE carrying what was there. The
//     two are different facts (a deployment that predates the line, and one
//     speaking a vocabulary this run does not know), and neither may read as a
//     value, least of all as zero (L90, L706).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-echo-contract.ts
import {
  ANSWERED_AT_HEADER,
  CONFIRM_LINE_HEADER,
  CONFIRM_LINE_KEY_HEADER,
  CONFIRM_LINE_MS_HEADER,
  CONFIRM_LINE_REASON_HEADER,
  CONFIRM_LINES,
  CONFIRM_LINE_KEYS,
  CONFIRM_LINE_REASONS,
  answeredAtEchoHeader,
  confirmLineEchoHeaders,
  readLoadtestEcho,
  type LoadtestEcho,
} from "../src/lib/loadtest-echo.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Read what the builder wrote, through a real Headers object, as the driver does. */
function roundTrip(pairs: [string, string][]): LoadtestEcho {
  return readLoadtestEcho(new Headers(pairs));
}

// --- the names and the vocabularies are the ones the core change emits ------------
{
  eq(CONFIRM_LINE_HEADER, "x-loadtest-confirm-line", "the line header's name");
  eq(CONFIRM_LINE_REASON_HEADER, "x-loadtest-confirm-line-reason", "the reason header's name");
  eq(CONFIRM_LINE_KEY_HEADER, "x-loadtest-confirm-line-key", "the key header's name");
  eq(CONFIRM_LINE_MS_HEADER, "x-loadtest-confirm-line-ms", "the time header's name");
  eq(ANSWERED_AT_HEADER, "x-loadtest-answered-at", "the answer stamp's name");
  eq([...CONFIRM_LINES], ["shared", "isolate", "fallback"], "the three lines");
  eq(
    [...CONFIRM_LINE_REASONS],
    ["ok", "unread-default-on", "off", "unread-default", "unbound", "reach-timeout", "enter-error", "gone", "bad-answer", "version", "abandoned"],
    "the eleven reasons",
  );
  eq([...CONFIRM_LINE_KEYS], ["ladder", "code", "link", "none"], "the four key kinds");
}

// --- every value the builder writes reads back as itself ---------------------------
{
  for (const line of CONFIRM_LINES) {
    for (const reason of CONFIRM_LINE_REASONS) {
      for (const key of CONFIRM_LINE_KEYS) {
        const echo = roundTrip(confirmLineEchoHeaders({ line, reason, key, lineMs: 37 }));
        const ok =
          echo.line.state === "read" &&
          echo.line.value === line &&
          echo.reason.state === "read" &&
          echo.reason.value === reason &&
          echo.key.state === "read" &&
          echo.key.value === key &&
          echo.lineMs.state === "read" &&
          echo.lineMs.value === 37;
        if (!ok) assert(false, `${line}/${reason}/${key} did not round trip: ${JSON.stringify(echo)}`);
      }
    }
  }
  assert(true, "every line, reason and key the builder can write reads back as itself");
}

{
  const echo = roundTrip(confirmLineEchoHeaders({ line: "shared", reason: "ok", key: "ladder", lineMs: 0 }));
  eq(echo.lineMs, { state: "read", value: 0 }, "a measured zero is a reading of zero");

  const rounded = roundTrip(confirmLineEchoHeaders({ line: "shared", reason: "ok", key: "ladder", lineMs: 12.6 }));
  eq(rounded.lineMs, { state: "read", value: 13 }, "the time is written in whole milliseconds");
}

{
  // A time the deployment could not measure is left OFF the response rather than
  // written as a zero: a zero is the cheapest possible reading and would pull the
  // percentile down while looking like a measurement (L90).
  const nan = confirmLineEchoHeaders({ line: "shared", reason: "ok", key: "ladder", lineMs: Number.NaN });
  assert(!nan.some(([name]) => name === CONFIRM_LINE_MS_HEADER), "an unmeasurable time is not written at all");
  eq(roundTrip(nan).lineMs, { state: "absent" }, "and so reads as absent, never as zero");
  const negative = confirmLineEchoHeaders({ line: "shared", reason: "ok", key: "ladder", lineMs: -4 });
  eq(roundTrip(negative).lineMs, { state: "absent" }, "and so does a negative one, which cannot be a duration");
}

{
  const at = Date.parse("2026-10-05T18:00:00.123Z");
  eq(roundTrip([answeredAtEchoHeader(at)]).answeredAtMs, { state: "read", value: at }, "the answer stamp round trips");
  eq(
    roundTrip([answeredAtEchoHeader(at + 0.7)]).answeredAtMs,
    { state: "read", value: at },
    "in whole milliseconds",
  );
}

// --- a header nobody sent is ABSENT, never a value ---------------------------------
{
  const none = readLoadtestEcho(new Headers());
  eq(none.line, { state: "absent" }, "no line header reads as absent");
  eq(none.reason, { state: "absent" }, "no reason header reads as absent");
  eq(none.key, { state: "absent" }, "no key header reads as absent");
  eq(none.lineMs, { state: "absent" }, "no time header reads as absent, not zero");
  eq(none.answeredAtMs, { state: "absent" }, "no answer stamp reads as absent");
}

// --- a header sent with a value the contract does not know is UNREADABLE -----------
{
  const bad = readLoadtestEcho(
    new Headers([
      [CONFIRM_LINE_HEADER, "Shared"],
      [CONFIRM_LINE_REASON_HEADER, "timeout"],
      [CONFIRM_LINE_KEY_HEADER, "slot"],
      [CONFIRM_LINE_MS_HEADER, "12.5"],
      [ANSWERED_AT_HEADER, "yesterday"],
    ]),
  );
  eq(bad.line, { state: "unreadable", raw: "Shared" }, "a line the contract does not name is unreadable, with what was sent");
  eq(bad.reason, { state: "unreadable", raw: "timeout" }, "so is an unknown reason");
  eq(bad.key, { state: "unreadable", raw: "slot" }, "and an unknown key kind");
  eq(bad.lineMs, { state: "unreadable", raw: "12.5" }, "a time that is not whole milliseconds is unreadable");
  eq(bad.answeredAtMs, { state: "unreadable", raw: "yesterday" }, "and so is a stamp that is not epoch milliseconds");
}

{
  const empty = readLoadtestEcho(
    new Headers([
      [CONFIRM_LINE_HEADER, " "],
      [CONFIRM_LINE_MS_HEADER, "-3"],
      [ANSWERED_AT_HEADER, "0"],
    ]),
  );
  eq(empty.line, { state: "unreadable", raw: "" }, "a blank line header is unreadable, not absent: something was sent");
  eq(empty.lineMs, { state: "unreadable", raw: "-3" }, "a negative time is unreadable");
  eq(empty.answeredAtMs, { state: "unreadable", raw: "0" }, "a zero stamp is unreadable, never the epoch");
}

{
  // A value is read exactly, and surrounding space alone is forgiven: Headers
  // already trims it, and a reader stricter than the writer would refuse a correct
  // deployment (L198).
  eq(
    readLoadtestEcho(new Headers([[CONFIRM_LINE_HEADER, "  shared  "]])).line,
    { state: "read", value: "shared" },
    "surrounding space is not part of the value",
  );
}

finish();
