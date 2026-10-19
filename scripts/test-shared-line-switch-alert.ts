// The shared confirm line switch's failed reads are COUNTED, not only logged (#3339). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-shared-line-switch-alert.ts
//
// A confirm reads `booking_settings.shared_confirm_line` through a per isolate cache, and a
// failed read answers the last value read or the deployment default. That is the right
// thing to serve, and until #3339 the only trace of it was a log line, so a database that
// refused the read for an hour left every cold server on the default with nothing saying
// so (L77). One failure is a finished event and never a page (#3670, L36); a run of them on
// one server inside a window is what an outage looks like from inside that server.
//
// No clock, no network: every instant is passed in.
import {
  SWITCH_READ_ALERT_KEY,
  SWITCH_READ_PAGE_AFTER,
  SWITCH_READ_PAGE_WINDOW_MS,
  SWITCH_READ_ALERT_COOLDOWN_MS,
  sharedLineSwitchUnreadableAlert,
  makeSwitchReadFailureReporter,
} from "../src/lib/booking/shared-line-switch-alert.ts";
import { SHARED_LINE_SWITCH_RETRY_MS } from "../src/lib/booking/shared-line-switch-core.ts";
import { ALERT_CATALOG } from "../src/lib/notify/alert-catalog.ts";
import { alertFamily } from "../src/lib/notify/alert-runbook.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const PLAIN = /^[\x20-\x7E\n]*$/;

// --- the numbers ------------------------------------------------------------------
assert(SWITCH_READ_PAGE_AFTER >= 2, "one failed read is never a page (#3670)");
assert(
  SWITCH_READ_PAGE_WINDOW_MS > (SWITCH_READ_PAGE_AFTER - 1) * SHARED_LINE_SWITCH_RETRY_MS,
  "the window holds a run of failed reads at the reader's own retry spacing, or a real outage could never cross it",
);

function world(onWorkers = true) {
  let now = 1_800_000_000_000;
  const pages: string[] = [];
  const logs: { fields: Record<string, unknown>; err: unknown }[] = [];
  const report = makeSwitchReadFailureReporter({
    now: () => now,
    onWorkers: () => onWorkers,
    log: (fields, err) => logs.push({ fields, err }),
    page: (text) => pages.push(text),
    deploymentDefault: () => "off",
  });
  return {
    report,
    pages,
    logs,
    advance(ms: number) {
      now += ms;
    },
  };
}

{
  // One failed read: logged, never paged.
  const w = world();
  w.report(new Error("statement timeout"));
  eq(w.pages.length, 0, "a single failed read is logged and never paged");
  eq(w.logs.length, 1, "and it IS logged, with nothing dropped");
  assert(w.logs[0]?.err instanceof Error && String(w.logs[0].err).includes("statement timeout"), "with the error itself in the log, never in Slack");
}
{
  // A run of them inside the window, at the reader's own retry spacing: one page.
  const w = world();
  for (let i = 0; i < SWITCH_READ_PAGE_AFTER; i++) {
    w.report(new Error("statement timeout"));
    w.advance(SHARED_LINE_SWITCH_RETRY_MS);
  }
  eq(w.pages.length, 1, `a run of ${SWITCH_READ_PAGE_AFTER} failed reads inside the window pages once`);
  const text = w.pages[0] ?? "";
  assert(PLAIN.test(text) && text.length > 60, `in plain words (${text})`);
  assert(text.includes(String(SWITCH_READ_PAGE_AFTER)), "saying how many it counted");
  assert(/deployment default/.test(text) && /\boff\b/.test(text), "and what the server answers instead: the last value it read, or the deployment default, named with its value");
  assert(!/statement timeout/.test(text), "and no raw error text (the logs hold it)");
  // More failures straight after: inside the cooldown, still one page.
  for (let i = 0; i < 5; i++) w.report(new Error("statement timeout"));
  eq(w.pages.length, 1, "and the run going on does not page again inside the cooldown");
  w.advance(SWITCH_READ_ALERT_COOLDOWN_MS);
  for (let i = 0; i < SWITCH_READ_PAGE_AFTER; i++) w.report(new Error("statement timeout"));
  eq(w.pages.length, 2, "a later run after the cooldown pages again");
}
{
  // Spread out past the window: never a run.
  const w = world();
  for (let i = 0; i < 5; i++) {
    w.report(new Error("x"));
    w.advance(SWITCH_READ_PAGE_WINDOW_MS);
  }
  eq(w.pages.length, 0, "failures a window apart never make a run");
}
{
  // Off the Workers runtime nothing is about production: logged, never paged.
  const w = world(false);
  for (let i = 0; i < 10; i++) w.report(new Error("x"));
  eq(w.pages.length, 0, "a dev server or a node script never pages, however many reads fail");
  eq(w.logs.length, 10, "and still logs every one");
}
{
  // The default's value is what the copy names, read at the moment of the page.
  eq(/\bon\b/.test(sharedLineSwitchUnreadableAlert({ count: 3, windowMs: 60_000, atLeast: false }, "on")), true, "a default of on is named as on");
  assert(/not set/.test(sharedLineSwitchUnreadableAlert({ count: 3, windowMs: 60_000, atLeast: false }, undefined)), "and an unset default is said as such, which means off");
  assert(/at least 4/i.test(sharedLineSwitchUnreadableAlert({ count: 4, windowMs: 60_000, atLeast: true }, "off")), "a truncated count says at least");
}
{
  // #3339: the consequence follows the default the page names (L180). Production's
  // default is on since #3339, and a server standing on "on" errs the OTHER way from one
  // standing on "off": it shares the line somebody may have switched off, rather than
  // keeping a crowd on its own. A sentence written for one direction is wrong for the other.
  const m = { count: 3, windowMs: 60_000, atLeast: false };
  const onText = sharedLineSwitchUnreadableAlert(m, "on");
  const offText = sharedLineSwitchUnreadableAlert(m, "off");
  const unsetText = sharedLineSwitchUnreadableAlert(m, undefined);
  assert(/deployment default, which is on\b/.test(onText), "a default of on is named as on, in the sentence naming the default");
  assert(/shared line even if somebody switched it off/.test(onText), "a default of on says the server may share a line somebody switched off");
  assert(!/on its own rather than across every server/.test(onText), "and never claims a default of on keeps a crowd on its own server");
  for (const [label, text] of [["off", offText], ["unset", unsetText]] as const) {
    assert(/on its own rather than across every server/.test(text), `a default of ${label} says the server may line a crowd up on its own`);
    assert(!/even if somebody switched it off/.test(text), `and a default of ${label} never claims the server shares a line switched off`);
  }
}

// --- the key -----------------------------------------------------------------------
const entry = ALERT_CATALOG.find((e) => e.key === SWITCH_READ_ALERT_KEY);
eq(entry?.kind, "incident", "a run of failed reads already served is an incident, like confirm_line_unreachable");
assert(alertFamily(SWITCH_READ_ALERT_KEY) !== undefined, "it has a runbook family");

finish();
