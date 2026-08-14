// #1459: an event Slate emits that no active endpoint subscribes is delivered to
// NOBODY, and the delivery path reports success either way.
//
// `emitWebhook` selects endpoints with `.contains("events", [event])`, maps over
// the result, and returns. Zero matches means `Promise.all([])`, which resolves,
// so the outbox step is marked done and the booking event is simply gone. The
// subscription lives in a database column that no code change touches, so adding a
// value to the `WebhookEvent` union ships it inert (L120, and L46 on the reading
// side).
//
// This tests the LIVE half: given the events the code can emit and the endpoint
// rows as they actually are, which events reach nobody. Both directions matter and
// both are asserted, because a check that can only ever answer "all covered" is
// satisfied by a function hard-wired to that answer (L1).
//
// Run: node --experimental-strip-types scripts/test-webhook-subscriber-coverage.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  formatUnsubscribedEventsAlert,
  runWebhookSubscriberCheck,
  subscriberCoverage,
  WEBHOOK_SUBSCRIBERS_KEY,
} from "@/lib/monitor/webhook-subscriber-coverage";

const EVENTS = ["booking.created", "booking.rescheduled", "booking.cancelled"];

// --- the covered case: every event has at least one live subscriber ---
{
  const out = subscriberCoverage({
    events: EVENTS,
    endpoints: [{ url: "https://regal", events: EVENTS }],
    unsubscribedReason: () => null,
  });
  eq(out.unsubscribed.length, 0, "every event with a subscriber reports none unsubscribed");
  eq(out.measured, true, "and it reports that it MEASURED that");
  eq(formatUnsubscribedEventsAlert(out), "", "so there is nothing to say");
}

// --- the #1459 case: a new event nobody subscribes ---
{
  const out = subscriberCoverage({
    events: [...EVENTS, "booking.updated"],
    endpoints: [{ url: "https://regal", events: EVENTS }],
    unsubscribedReason: () => null,
  });
  eq(out.unsubscribed.join(","), "booking.updated", "the event no endpoint subscribes is named");
  const text = formatUnsubscribedEventsAlert(out);
  assert(text.includes("booking.updated"), "the alert names the event");
  assert(
    /nobody|no active endpoint|reaches no/i.test(text),
    `the alert says the event reaches nobody (got: ${text})`,
  );
  // The reader's next action is a database update, and the alert has to say so:
  // naming the problem without the remedy is what leaves someone stuck (L80/L111).
  assert(
    /webhook_endpoints|subscri/i.test(text),
    "the alert points at the subscription that has to change",
  );
}

// --- an INACTIVE endpoint does not count as a subscriber ---
{
  // Endpoints are filtered by the caller (`active = true`), so this asserts the
  // contract rather than re-implementing the filter: an empty endpoint list must
  // read as "nothing subscribes", not as "nothing to check".
  const out = subscriberCoverage({
    events: EVENTS,
    endpoints: [],
    unsubscribedReason: () => null,
  });
  eq(
    out.unsubscribed.length,
    EVENTS.length,
    "with no active endpoints at all, every event reaches nobody",
  );
  eq(out.measured, true, "no endpoints is a MEASURED answer, not an unreadable one");
}

// --- a deliberately unsubscribed event is exempt, and says why ---
{
  const out = subscriberCoverage({
    events: [...EVENTS, "booking.updated"],
    endpoints: [{ url: "https://regal", events: EVENTS }],
    unsubscribedReason: (e) => (e === "booking.updated" ? "#1341 subscribes it" : null),
  });
  eq(out.unsubscribed.length, 0, "a declared event is not reported");
  eq(out.declared.join(","), "booking.updated", "but it IS reported as declared, not hidden");
}

// --- an unreadable endpoint list must NOT read as full coverage ---
{
  // The whole defect class: a failed read yielding an empty list would say every
  // event reaches nobody (a false page), and yielding "no findings" would say
  // everything is subscribed (a silent blindness). Neither is allowed: the check
  // reports that it could not measure (L11, L90).
  const out = subscriberCoverage({
    events: EVENTS,
    endpoints: null,
    unsubscribedReason: () => null,
  });
  eq(out.measured, false, "an unreadable endpoint list reports measured:false");
  eq(out.unsubscribed.length, 0, "and claims no findings, because it found nothing out");
  eq(formatUnsubscribedEventsAlert(out), "", "and says nothing, rather than paging or clearing");
}

// --- the runner: alerts, resolves, and never resolves off a failed read ---
{
  // `alerted` and `resolved` are kept apart deliberately. One combined call log
  // could only prove "nothing was sent at all", and the thing that has to be
  // proved here is narrower: that no ALL-CLEAR went out on a tick that measured
  // nothing.
  const alerted: string[] = [];
  const resolved: string[] = [];
  const reset = () => {
    alerted.length = 0;
    resolved.length = 0;
  };
  const deps = (endpoints: { url: string; events: string[] }[] | null) => ({
    events: [...EVENTS, "booking.updated"],
    loadEndpoints: async () => endpoints,
    unsubscribedReason: () => null,
    notify: async (key: string, _ms: number, text: string) => {
      alerted.push(`${key}:${text.slice(0, 24)}`);
    },
    resolve: async (key: string) => {
      resolved.push(key);
    },
    cooldownMs: 1000,
  });

  reset();
  const bad = await runWebhookSubscriberCheck(deps([{ url: "https://regal", events: EVENTS }]));
  eq(bad.unsubscribed.join(","), "booking.updated", "runner: reports the unsubscribed event");
  assert(
    alerted.some((c) => c.startsWith(WEBHOOK_SUBSCRIBERS_KEY)),
    "runner: pages on the catalog key",
  );
  eq(resolved.length, 0, "runner: a paging tick does NOT also send an all-clear");

  reset();
  const good = await runWebhookSubscriberCheck({
    ...deps([{ url: "https://regal", events: [...EVENTS, "booking.updated"] }]),
  });
  eq(good.unsubscribed.length, 0, "runner: reports full coverage");
  eq(resolved.join(","), WEBHOOK_SUBSCRIBERS_KEY, "runner: clears the condition when measured healthy");
  eq(alerted.length, 0, "runner: a healthy tick pages about nothing");

  // The rule this exists to honour: an all-clear hangs off a MEASURED healthy
  // result, never off "we did not alert this run" (#1134, #1152).
  reset();
  const unread = await runWebhookSubscriberCheck(deps(null));
  eq(unread.measured, false, "runner: an unreadable read is reported as unmeasured");
  eq(resolved.length, 0, "runner: an unreadable read sends NO all-clear");
  eq(alerted.length, 0, "runner: an unreadable read does not page either");

  // A read that THROWS is the same case as one that returns null.
  reset();
  const threw = await runWebhookSubscriberCheck({
    ...deps(null),
    loadEndpoints: async () => {
      throw new Error("PostgREST down");
    },
  });
  eq(threw.measured, false, "runner: a throwing read is reported as unmeasured");
  eq(resolved.length, 0, "runner: a throwing read sends NO all-clear");
  eq(alerted.length, 0, "runner: a throwing read does not page either");
}

finish();
