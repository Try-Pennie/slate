// #2440: the weekly count of owner reassign notices that were never posted because no
// handoff channel was set.
//
// The withholding is recorded on the outbox step (see
// src/lib/booking/owner-notice-withheld.ts); this drives the monitor lane's reading of
// it. It is an INFO whisper, once a week, and never pages: nothing is broken in a way
// a page could fix at 3am, and the channel itself is already paged on when a handoff
// is waiting (#2367). The copy rules (no dashes, no raw values) are held by the alert
// preview coverage guard, which renders this builder.
//
// Run: node --experimental-strip-types scripts/test-owner-notice-withheld-report.ts
import {
  OWNER_NOTICE_WITHHELD_COOLDOWN_MS,
  OWNER_NOTICE_WITHHELD_KEY,
  OWNER_NOTICE_WITHHELD_WINDOW_MS,
  formatOwnerNoticeWithheldReport,
  runOwnerNoticeWithheldReport,
} from "../src/lib/monitor/owner-notice-withheld-report.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 9, 16, 15, 0, 0);
const SETTINGS = "https://slate.example/admin/alerts";
const WEEK = 7 * 24 * 60 * 60_000;

function fakeNotify() {
  const sent: { key: string; cooldownMs: number; text: string }[] = [];
  return {
    sent,
    notify: async (key: string, cooldownMs: number, text: string) => {
      sent.push({ key, cooldownMs, text });
    },
  };
}

async function main() {
  // --- the window and the pace are a week each ---------------------------------
  eq(OWNER_NOTICE_WITHHELD_WINDOW_MS, WEEK, "window: the count covers the last seven days");
  eq(OWNER_NOTICE_WITHHELD_COOLDOWN_MS, WEEK, "pace: said at most once a week");

  // --- some were withheld: one whisper naming the count ------------------------
  {
    const { sent, notify } = fakeNotify();
    let asked: string | null = null;
    const res = await runOwnerNoticeWithheldReport({
      nowMs: NOW,
      countWithheld: async (sinceIso) => {
        asked = sinceIso;
        return 4;
      },
      notify,
      settingsUrl: SETTINGS,
    });
    eq(res.status, "reported", "withheld: reported");
    eq(asked, new Date(NOW - WEEK).toISOString(), "withheld: the count is asked from exactly a week ago");
    eq(sent.length, 1, "withheld: one message");
    eq(sent[0].key, OWNER_NOTICE_WITHHELD_KEY, "withheld: on the report's own key");
    eq(sent[0].cooldownMs, WEEK, "withheld: throttled to once a week");
    assert(sent[0].text.includes("4 owner reassign notices"), "withheld: names the count");
    assert(sent[0].text.includes(SETTINGS), "withheld: names where the channel is set");
  }

  // --- none withheld: silence, which is the ordinary week ----------------------
  {
    const { sent, notify } = fakeNotify();
    const res = await runOwnerNoticeWithheldReport({
      nowMs: NOW,
      countWithheld: async () => 0,
      notify,
      settingsUrl: SETTINGS,
    });
    eq(res.status, "none", "none: nothing to report");
    eq(sent.length, 0, "none: nothing is sent");
  }

  // --- the count could not be read: it THROWS, and nothing is sent ------------
  // An unreadable count is not a week with nothing withheld. Throwing lets the
  // monitor step's own boundary record the failure, and its streak pages if it lasts.
  {
    const { sent, notify } = fakeNotify();
    let threw = false;
    try {
      await runOwnerNoticeWithheldReport({
        nowMs: NOW,
        countWithheld: async () => {
          throw new Error("count failed [owner notices withheld]: timeout");
        },
        notify,
        settingsUrl: SETTINGS,
      });
    } catch {
      threw = true;
    }
    assert(threw, "unreadable: the failure reaches the step boundary");
    eq(sent.length, 0, "unreadable: and nothing is sent");
  }

  // --- the words ---------------------------------------------------------------
  {
    const one = formatOwnerNoticeWithheldReport({ count: 1, windowDays: 7, settingsUrl: SETTINGS });
    assert(one.includes("1 owner reassign notice "), "copy: singular for one");
    assert(!one.startsWith("Slate"), "copy: does not open with Slate, which Slack already shows");
    assert(one.includes("booking history"), "copy: says where each reassign is still recorded");
  }

  finish();
}

void main();
