// Node test for how external double-book clashes are paged (#2905).
//
// The message names one CALL, so the cooldown must be keyed by that call. Keyed
// by the advisor, a second clash on the same advisor inside the cooldown was
// silenced behind a first page that read as the whole picture (L707).
import { assert, eq, finish } from "./lib/harness.ts";
import { pageExternalCollisions, DOUBLE_BOOK_COOLDOWN_MS } from "../src/lib/google/collision-alerts.ts";
import type { ExternalCollision } from "../src/lib/google/collision.ts";

const T = (iso: string) => Date.parse(iso);
const clash = (bookingId: string, start: string, evStart: string, evEnd: string): ExternalCollision => ({
  bookingId,
  gcalEventId: `ev-${bookingId}`,
  bookingStartMs: T(start),
  eventStartMs: T(evStart),
  eventEndMs: T(evEnd),
});

function recorder() {
  const sent: { key: string; cooldownMs: number; text: string }[] = [];
  return {
    sent,
    notify: async (key: string, cooldownMs: number, text: string) => {
      sent.push({ key, cooldownMs, text });
    },
  };
}
const url = (id: string) => `https://slate.test/admin/bookings/${id}`;

// 1. Two clashes on one advisor are two pages, each on its own call's key, each
//    naming only its own call. A shared key would let the throttle drop one.
{
  const r = recorder();
  await pageExternalCollisions("radeyemo@trypennie.com", [
    clash("b-1", "2026-10-01T17:00:00Z", "2026-10-01T17:00:00Z", "2026-10-01T17:30:00Z"),
    clash("b-2", "2026-10-02T14:00:00Z", "2026-10-02T13:30:00Z", "2026-10-02T14:30:00Z"),
  ], { notify: r.notify, bookingUrl: url });
  eq(r.sent.map((s) => s.key), ["external_double_book:b-1", "external_double_book:b-2"], "one key per call");
  assert(r.sent[0].text.includes(url("b-1")) && !r.sent[0].text.includes(url("b-2")), "the first page names only its call");
  assert(r.sent[1].text.includes(url("b-2")) && !r.sent[1].text.includes(url("b-1")), "the second page names only its call");
  assert(r.sent[1].text.includes("Fri, Oct 2") && r.sent[1].text.includes("10:00am ET"), `second page carries its time: ${r.sent[1].text}`);
  assert(r.sent.every((s) => s.cooldownMs === DOUBLE_BOOK_COOLDOWN_MS), "every page uses the per call cooldown");
}

// 2. The cooldown is long enough that a clash seen on every sync does not re-page
//    on each one, and short enough that an unresolved clash is raised again the
//    next day rather than never.
{
  assert(DOUBLE_BOOK_COOLDOWN_MS >= 60 * 60 * 1000, "a persisting clash is not re-paged hourly or faster");
  assert(DOUBLE_BOOK_COOLDOWN_MS <= 24 * 60 * 60 * 1000, "an unresolved clash is raised again within a day");
}

// 3. One failed send does not stop the rest being paged: each call has its own
//    failure boundary (L73).
{
  const sent: string[] = [];
  await pageExternalCollisions("x@trypennie.com", [
    clash("b-1", "2026-10-01T17:00:00Z", "2026-10-01T17:00:00Z", "2026-10-01T17:30:00Z"),
    clash("b-2", "2026-10-02T14:00:00Z", "2026-10-02T13:30:00Z", "2026-10-02T14:30:00Z"),
  ], {
    notify: async (key) => {
      if (key.endsWith("b-1")) throw new Error("slack down");
      sent.push(key);
    },
    bookingUrl: url,
  });
  eq(sent, ["external_double_book:b-2"], "a throw on the first call still pages the second");
}

// 4. No clashes, no pages.
{
  const r = recorder();
  await pageExternalCollisions("x@trypennie.com", [], { notify: r.notify, bookingUrl: url });
  eq(r.sent.length, 0, "nothing to page");
}

finish();
