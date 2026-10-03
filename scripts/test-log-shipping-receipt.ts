/**
 * #3182: the receipt that says Slate's logs are really reaching Better Stack.
 *
 * The tail worker counts what it drops, but only in its own Cloudflare logs, and a
 * worker that is never invoked, or whose every POST is refused, writes nothing that
 * anybody is paged from. So detection is by ABSENCE, like the lane heartbeats: the
 * tail worker hands Slate a receipt each time Better Stack accepts an invocation
 * carrying the cron `lane timings` line, Slate stamps `log-shipping`, and the lane
 * watchdog pages when that stamp goes stale.
 *
 * Four pieces, each driven here without a network:
 *   - the DECISION (did this shipment prove delivery), in both directions;
 *   - the tail side of the RPC, which must never throw and must say why it sent nothing;
 *   - the Slate side, which forwards in process to the cron authed route;
 *   - the bound and the copy the watchdog pages with.
 * The wiring (the binding in the tail worker's config, the entrypoint Slate exports)
 * is pinned in scripts/test-log-tail-config.ts, against what wrangler resolves.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-log-shipping-receipt.ts
 */
import { formatLine } from "../src/lib/log.ts";
import { laneTimingFields } from "../src/lib/monitor/lane-timing.ts";
import { recordsFromTraces, type ShippedRecord, type TraceItemLike } from "../src/lib/log-shipping/records.ts";
import type { ShipOutcome } from "../src/lib/log-shipping/ship.ts";
import {
  RECEIPT_TIMEOUT_MS,
  confirmReceipt,
  isLaneTimingsRecord,
  shipmentConfirmsDelivery,
  type ReceiptBinding,
} from "../src/lib/log-shipping/receipt.ts";
import { LOG_SHIPPING_RECEIPT_PATH, forwardReceipt } from "../worker/log-shipping-receipt.ts";
import { CRON_ORIGIN } from "../worker/lane-run.ts";
import { findStaleLanes, LOG_SHIPPING_LANE, LOG_SHIPPING_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import { logShippingAlertText, logShippingRecoveryText } from "../src/lib/monitor/lane-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MIN = 60_000;

function cronItem(lines: string[], scriptName = "slate"): TraceItemLike {
  return {
    event: { cron: "* * * * *", scheduledTime: 1_790_000_000_000 },
    eventTimestamp: 1_790_000_000_000,
    logs: lines.map((message, i) => ({ timestamp: 1_790_000_000_001 + i, level: "info", message: [message] })),
    exceptions: [],
    scriptName,
    scriptVersion: { id: "7a1b2c3d-0000-4000-8000-123456789abc" },
    outcome: "ok",
  };
}

const TIMINGS = formatLine("cron", {
  msg: "lane timings",
  cron: "* * * * *",
  tick: "0f1e2d3c4b5a6978",
  ...laneTimingFields([{ path: "/api/cron/sync", ms: 1200, ok: true }], 1300),
});
const OTHER = formatLine("recompute", { msg: "cycle", refreshed: 3 });

const ALL_SENT = (n: number): ShipOutcome => ({ sent: n, dropped: {} });

// ------------------------------------------------------------- the decision

{
  const records = recordsFromTraces([cronItem([OTHER, TIMINGS])]);
  const timings = records.filter(isLaneTimingsRecord);
  eq(timings.length, 1, "exactly one record in a cron tick is the lane timings line");
  assert(
    shipmentConfirmsDelivery(records, ALL_SENT(records.length)),
    "every record of a tick carrying the lane timings line accepted: that is a receipt",
  );

  // Any drop at all withholds it. A partly shipped tick may have lost the very line
  // the receipt vouches for, and one missed receipt costs nothing against a bound
  // fifteen ticks wide, where a false one hides the fault the alarm exists for.
  for (const dropped of [{ refused: 1 }, { timeout: 2 }, { "no-token": records.length }, { "over-budget": 1 }] as const) {
    const outcome: ShipOutcome = { sent: records.length - 1, dropped };
    assert(!shipmentConfirmsDelivery(records, outcome), `a shipment that dropped ${JSON.stringify(dropped)} is no receipt`);
  }
  assert(
    !shipmentConfirmsDelivery(records, { sent: records.length, dropped: {}, refusedStatuses: [401] }),
    "nor is one that saw a refusal, whatever the counts say",
  );
  assert(!shipmentConfirmsDelivery(records, ALL_SENT(0)), "and nothing sent is never a receipt (L98)");
}

{
  // The receipt's OWN invocation is tailed too. It carries no lane timings line, so
  // shipping it can never ask for another receipt: without this the two Workers would
  // invoke each other for ever.
  const receiptInvocation = recordsFromTraces([
    {
      event: { request: { method: "RPC", url: undefined }, response: undefined },
      eventTimestamp: 1_790_000_000_000,
      logs: [{ timestamp: 1_790_000_000_001, level: "info", message: [OTHER] }],
      exceptions: [],
      scriptName: "slate",
      outcome: "ok",
    } as unknown as TraceItemLike,
  ]);
  assert(
    !shipmentConfirmsDelivery(receiptInvocation, ALL_SENT(receiptInvocation.length)),
    "an invocation with no lane timings line asks for no receipt, so the two Workers cannot loop",
  );
}

{
  // Only Slate's own line counts. Another Worker's text that merely MENTIONS lane
  // timings, or Slate saying it with a different tag, is not the cron dispatcher.
  const elsewhere = recordsFromTraces([cronItem([TIMINGS], "slate-loadtest")]);
  assert(!shipmentConfirmsDelivery(elsewhere, ALL_SENT(elsewhere.length)), "another script's lane timings is no receipt");
  const mention = recordsFromTraces([cronItem([formatLine("monitor", { msg: "lane timings" })])]);
  assert(!shipmentConfirmsDelivery(mention, ALL_SENT(mention.length)), "a lane timings message under another tag is not the dispatcher's line");
  const prose = recordsFromTraces([cronItem(["lane timings were slow today"])]);
  assert(!shipmentConfirmsDelivery(prose, ALL_SENT(prose.length)), "and plain text saying it is not the line either");
  const bare: ShippedRecord = { dt: "x", level: "info", message: "lane timings", kind: "log", script: "slate", version_id: null };
  assert(!isLaneTimingsRecord(bare), "a record with no parsed fields is not the line");
}

// ------------------------------------------------------------- the tail side

{
  eq(await confirmReceipt(undefined), "no-binding", "no SLATE binding (a tail worker deployed before this change) says so");

  let calls = 0;
  const ok: ReceiptBinding = { shipped: async () => (calls++, { stamped: true }) };
  eq(await confirmReceipt(ok), "stamped", "a receipt Slate stamped");
  eq(calls, 1, "one call per receipt");

  eq(await confirmReceipt({ shipped: async () => ({ stamped: false }) }), "refused", "a receipt Slate could not stamp");
  eq(
    await confirmReceipt({ shipped: async () => ({}) as unknown as { stamped: boolean } }),
    "refused",
    "an answer with no stamped flag is not a stamp",
  );
  eq(
    await confirmReceipt({
      shipped: async () => {
        throw new Error("entrypoint not found");
      },
    }),
    "failed",
    "a call that throws is contained and reported, never thrown",
  );
  const hung: ReceiptBinding = { shipped: () => new Promise(() => {}) };
  eq(await confirmReceipt(hung, 5), "timeout", "a call that never answers is abandoned at its deadline (L110)");
  assert(RECEIPT_TIMEOUT_MS > 0 && RECEIPT_TIMEOUT_MS <= 10_000, "the default deadline is bounded");
}

// ------------------------------------------------------------- the Slate side

{
  const seen: Request[] = [];
  const errors: { fields: Record<string, unknown> }[] = [];
  const log = { error: (_t: string, fields: Record<string, unknown>) => void errors.push({ fields }) };

  const ok = await forwardReceipt({
    cronSecret: "s3cret",
    fetch: async (req) => (seen.push(req), new Response("{}", { status: 200 })),
    log,
  });
  eq(ok, { stamped: true }, "a stamp the route accepted");
  eq(seen.length, 1, "one in process request");
  eq(seen[0]!.url, `${CRON_ORIGIN}${LOG_SHIPPING_RECEIPT_PATH}`, "to the receipt route, never off the isolate");
  eq(seen[0]!.method, "POST", "as a POST");
  eq(seen[0]!.headers.get("authorization"), "Bearer s3cret", "carrying the cron bearer the route checks");

  const refused = await forwardReceipt({
    cronSecret: "s3cret",
    fetch: async () => new Response("no", { status: 500 }),
    log,
  });
  eq(refused, { stamped: false }, "a refused stamp is reported as unstamped");
  assert(errors.some((e) => e.fields.status === 500), "and logged with its status");

  const threw = await forwardReceipt({
    cronSecret: "s3cret",
    fetch: async () => {
      throw new Error("boom");
    },
    log,
  });
  eq(threw, { stamped: false }, "a throw is contained");

  let reached = false;
  const noSecret = await forwardReceipt({
    cronSecret: "",
    fetch: async () => ((reached = true), new Response("{}")),
    log,
  });
  eq(noSecret, { stamped: false }, "no cron secret on this deployment stamps nothing");
  assert(!reached, "and does not ask the route a question it must refuse");
}

// ------------------------------------------------------------- the bound and the copy

{
  eq(LOG_SHIPPING_LANE, "log-shipping", "the heartbeat lane the receipt stamps");
  eq(LOG_SHIPPING_STALE_BOUNDS_MS[LOG_SHIPPING_LANE], 15 * MIN, "fifteen minutes, as the issue asks: fifteen missed ticks");
  const now = 1_790_000_000_000;
  eq(findStaleLanes({ [LOG_SHIPPING_LANE]: now - 14 * MIN }, now, LOG_SHIPPING_STALE_BOUNDS_MS, true), [], "inside the bound is quiet");
  eq(
    findStaleLanes({ [LOG_SHIPPING_LANE]: now - 16 * MIN }, now, LOG_SHIPPING_STALE_BOUNDS_MS, true).map((l) => l.lane),
    [LOG_SHIPPING_LANE],
    "past it is stale",
  );
  eq(
    findStaleLanes({}, now, LOG_SHIPPING_STALE_BOUNDS_MS, true).map((l) => l.ageMs),
    [Infinity],
    "and never stamped is stale too, since a tail worker that never sends a receipt is the fault",
  );

  const bound = LOG_SHIPPING_STALE_BOUNDS_MS[LOG_SHIPPING_LANE]!;
  const quiet = logShippingAlertText({ lane: LOG_SHIPPING_LANE, ageMs: 40 * MIN, maxStaleMs: bound, unreadable: false });
  const never = logShippingAlertText({ lane: LOG_SHIPPING_LANE, ageMs: Infinity, maxStaleMs: bound, unreadable: false });
  const unreadable = logShippingAlertText({ lane: LOG_SHIPPING_LANE, ageMs: now, maxStaleMs: bound, unreadable: true });
  for (const [name, text] of [["quiet", quiet], ["never", never], ["unreadable", unreadable]] as const) {
    assert(/Better Stack/.test(text), `${name}: names where the logs are not arriving`);
    assert(/wrangler tail slate-log-tail/.test(text), `${name}: says where the tail worker's own reasons are`);
    assert(!/Infinity|NaN|undefined|\[object/.test(text), `${name}: renders no arithmetic on a sentinel`);
    assert(!/[\u2014\u2013]/.test(text), `${name}: carries no dash`);
  }
  assert(/40 minutes/.test(quiet), "the quiet page says how long");
  assert(/never/i.test(never), "the never page says never");
  assert(/wrangler deploy -c wrangler\.log-tail\.jsonc/.test(never), "and names the redeploy, the usual cause right after this ships");
  assert(/cannot be read/.test(unreadable) && !/\d{4,} minutes/.test(unreadable), "the unreadable page claims no age it never measured (L11)");
  assert(/No action is needed/.test(logShippingRecoveryText(LOG_SHIPPING_LANE)), "the all-clear says nobody has to do anything");
}

finish();
