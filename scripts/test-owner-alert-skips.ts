// #2436: owner alerts skipped for an unreachable calendar, counted against a SHARE.
//
// One advisor without a Calendar licence is correctly silent; the whole roster
// skipping read exactly the same before this. These drive the judgement, the page,
// the all clear and every way the signal can be unreadable.
//
// Run: node --experimental-strip-types scripts/test-owner-alert-skips.ts
import {
  OWNER_ALERT_SKIPS_KEY,
  OWNER_ALERT_SKIP_THRESHOLDS,
  OWNER_ALERT_READ_LIMIT,
  formatOwnerAlertSkipsAllClear,
  formatOwnerAlertSkipsPage,
  judgeOwnerAlertSkips,
  runOwnerAlertSkipsCheck,
  type RecentOwnerAlert,
} from "../src/lib/monitor/owner-alert-skips.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 9, 16, 15, 0, 0);
const T = OWNER_ALERT_SKIP_THRESHOLDS;

/** `n` alerts, the first `skipped` of which were skipped, spread over `advisors`. */
function alerts(n: number, skipped: number, advisors: number, reason = "not-provisioned"): RecentOwnerAlert[] {
  return Array.from({ length: n }, (_, i) => ({
    userId: i < skipped ? `skip-${i % advisors}` : `ok-${i}`,
    skipReason: i < skipped ? reason : null,
  }));
}

function fakes() {
  const sent: { key: string; ms: number; text: string }[] = [];
  const resolved: { key: string; text: string }[] = [];
  return {
    sent,
    resolved,
    notify: async (key: string, ms: number, text: string) => {
      sent.push({ key, ms, text });
    },
    resolve: async (key: string, text: string) => {
      resolved.push({ key, text });
      return true;
    },
  };
}

async function main() {
  // --- the shipped numbers --------------------------------------------------------
  eq(T.windowMs, 7 * 24 * 60 * 60_000, "thresholds: a week of owner alerts");
  eq(T.minAlerts, 10, "thresholds: the alert floor (L716)");
  eq(T.minAdvisors, 3, "thresholds: a handful of unlicensed advisors is normal");
  eq(T.sharePct, 20, "thresholds: the share that pages");

  // --- the judgement ----------------------------------------------------------------
  eq(judgeOwnerAlertSkips(alerts(54, 0, 1), T).status, "under", "judge: the measured week (54 alerts, none skipped) is under");
  eq(
    judgeOwnerAlertSkips(alerts(54, 30, 1), T).status,
    "under",
    "judge: ONE advisor's calls all skipping is one fix, and stays silent however many rows",
  );
  eq(
    judgeOwnerAlertSkips(alerts(54, 20, 2), T).status,
    "under",
    "judge: two advisors is still under the advisor floor",
  );
  {
    const v = judgeOwnerAlertSkips(alerts(54, 12, 4), T);
    eq(v.status, "breach", "judge: four advisors and 22% of the week's alerts skipped pages");
    if (v.status === "breach") {
      eq(v.skipped, 12, "judge: counts the skipped rows");
      eq(v.advisors, 4, "judge: counts the advisors behind them");
      eq(v.pct, 22, "judge: the share for the reader");
      eq(v.byReason["not-provisioned"], 12, "judge: by reason");
    }
  }
  eq(
    judgeOwnerAlertSkips(alerts(50, 10, 5), T).status,
    "under",
    "judge: exactly 20% is not OVER the line (compared before rounding)",
  );
  eq(judgeOwnerAlertSkips(alerts(6, 1, 1), T).status, "insufficient", "judge: a quiet week below the floor measured nothing");
  eq(
    judgeOwnerAlertSkips(alerts(6, 4, 3), T).status,
    "breach",
    "judge: below the floor, most alerts skipping across three advisors still pages (L139)",
  );
  eq(judgeOwnerAlertSkips([], T).status, "insufficient", "judge: no alerts at all is not a healthy week");

  // --- one tick: pages on a breach ----------------------------------------------------
  {
    const f = fakes();
    let since: string | null = null;
    const res = await runOwnerAlertSkipsCheck({
      nowMs: NOW,
      loadRecent: async (sinceIso, limit) => {
        since = sinceIso;
        eq(limit, OWNER_ALERT_READ_LIMIT, "tick: the read is bounded");
        return alerts(54, 12, 4, "gone");
      },
      thresholds: T,
      cooldownMs: 1000,
      notify: f.notify,
      resolve: f.resolve,
    });
    eq(res.status, "paged", "tick: a breach pages");
    eq(since, new Date(NOW - T.windowMs).toISOString(), "tick: reads the last week by created_at");
    eq(f.sent.length, 1, "tick: one page");
    eq(f.sent[0].key, OWNER_ALERT_SKIPS_KEY, "tick: on its own key");
    eq(f.resolved.length, 0, "tick: and clears nothing");
    assert(f.sent[0].text.includes("12 of 54"), "page: names the share as counts");
    assert(f.sent[0].text.includes("4 advisors"), "page: names how many advisors");
  }

  // --- one tick: a measured healthy week clears ---------------------------------------
  {
    const f = fakes();
    const res = await runOwnerAlertSkipsCheck({
      nowMs: NOW,
      loadRecent: async () => alerts(54, 0, 1),
      thresholds: T,
      cooldownMs: 1000,
      notify: f.notify,
      resolve: f.resolve,
    });
    eq(res.status, "cleared", "healthy: a judged week under the line clears");
    eq(f.resolved.length, 1, "healthy: one all clear");
    eq(f.resolved[0].key, OWNER_ALERT_SKIPS_KEY, "healthy: on the same key");
    eq(f.sent.length, 0, "healthy: no page");
  }

  // --- the silent paths: nothing measured, nothing sent either way ---------------------
  {
    const f = fakes();
    let threw = false;
    try {
      await runOwnerAlertSkipsCheck({
        nowMs: NOW,
        loadRecent: async () => {
          throw new Error("owner alerts unreadable");
        },
        thresholds: T,
        cooldownMs: 1000,
        notify: f.notify,
        resolve: f.resolve,
      });
    } catch {
      threw = true;
    }
    assert(threw, "unreadable: the failed read reaches the step boundary");
    eq(f.resolved.length, 0, "unreadable: neither a page nor an all clear: no all clear");
    eq(f.sent.length, 0, "unreadable: neither a page nor an all clear: no page");
  }
  {
    const f = fakes();
    const res = await runOwnerAlertSkipsCheck({
      nowMs: NOW,
      loadRecent: async () => alerts(OWNER_ALERT_READ_LIMIT, 0, 1),
      thresholds: T,
      cooldownMs: 1000,
      notify: f.notify,
      resolve: f.resolve,
    });
    eq(res.status, "truncated", "truncated: a read that filled its bound saw only part of the week");
    eq(f.resolved.length, 0, "truncated: and so it pages nothing and clears nothing: no all clear");
    eq(f.sent.length, 0, "truncated: and so it pages nothing and clears nothing: no page");
  }
  {
    const f = fakes();
    const res = await runOwnerAlertSkipsCheck({
      nowMs: NOW,
      loadRecent: async () => alerts(4, 0, 1),
      thresholds: T,
      cooldownMs: 1000,
      notify: f.notify,
      resolve: f.resolve,
    });
    eq(res.status, "insufficient", "quiet: a week below the floor");
    eq(f.resolved.length, 0, "quiet: clears nothing, because it measured nothing (L98): no all clear");
    eq(f.sent.length, 0, "quiet: clears nothing, because it measured nothing (L98): no page");
  }

  // --- the words ------------------------------------------------------------------------
  {
    const page = formatOwnerAlertSkipsPage(
      { skipped: 1, alerts: 1, advisors: 1, pct: 100, byReason: { gone: 1 } },
      7,
    );
    assert(page.includes("1 of 1 owner alert "), "copy: singular");
    assert(!page.startsWith("Slate"), "copy: does not open with Slate");
    const clear = formatOwnerAlertSkipsAllClear({ skipped: 0, alerts: 54 }, 7);
    assert(clear.includes("none of the last 54"), "all clear: names what it measured");
  }

  finish();
}

void main();
