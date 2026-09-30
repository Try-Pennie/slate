// Node test for how external double-book clashes are paged (#2905).
//
// The message names one CALL, so the cooldown must be keyed by that call. Keyed
// by the advisor, a second clash on the same advisor inside the cooldown was
// silenced behind a first page that read as the whole picture (L707).
import { assert, eq, finish } from "./lib/harness.ts";
import { pageExternalCollisions, DOUBLE_BOOK_COOLDOWN_MS, COLLISION_WINDOW_MS } from "../src/lib/google/collision-alerts.ts";
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
  assert(r.sent.length === 2 && r.sent[0].key !== r.sent[1].key, "one page, on its own key, per call");
  assert(r.sent[0].key.startsWith("external_double_book:b-1:") && r.sent[1].key.startsWith("external_double_book:b-2:"),
    `each key leads with its booking id, which the retention prune reads: ${r.sent.map((x) => x.key)}`);
  assert(r.sent[0].text.includes(url("b-1")) && !r.sent[0].text.includes(url("b-2")), "the first page names only its call");
  assert(r.sent[1].text.includes(url("b-2")) && !r.sent[1].text.includes(url("b-1")), "the second page names only its call");
  assert(r.sent[1].text.includes("Fri, Oct 2") && r.sent[1].text.includes("10:00am ET"), `second page carries its time: ${r.sent[1].text}`);
  assert(r.sent.every((s) => s.cooldownMs === DOUBLE_BOOK_COOLDOWN_MS), "every page uses the per call cooldown");
}

// 2. Each clash pages ONCE, ever (Dan, 2026-09-29: "Once per clash, ever"). A clash
//    is only seen while its call sits inside the scan window, so a cooldown that
//    outlasts the window can never lapse while the clash is still visible. A new
//    clash on the same call is a new key (case 4), so it still pages.
{
  assert(DOUBLE_BOOK_COOLDOWN_MS > COLLISION_WINDOW_MS,
    `the cooldown (${DOUBLE_BOOK_COOLDOWN_MS}) outlasts the scan window (${COLLISION_WINDOW_MS}), so one clash never re-pages`);
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
      if (key.includes(":b-1:")) throw new Error("slack down");
      sent.push(key);
    },
    bookingUrl: url,
  });
  assert(sent.length === 1 && sent[0].startsWith("external_double_book:b-2:"), "a throw on the first call still pages the second");
}

// 4. The key names the CLASH, not only the call: a second outside event on the same
//    call, or the call moved onto another clash, is a new page rather than one
//    silenced behind the first for a day. The same clash seen again keeps its key.
{
  const keyOf = async (c: ExternalCollision) => {
    const r = recorder();
    await pageExternalCollisions("x@trypennie.com", [c], { notify: r.notify, bookingUrl: url });
    return r.sent[0].key;
  };
  const base = clash("b-1", "2026-10-01T17:00:00Z", "2026-10-01T17:00:00Z", "2026-10-01T17:30:00Z");
  eq(await keyOf(base), await keyOf({ ...base }), "the same clash seen on the next sync keeps its key");
  assert(await keyOf(base) !== await keyOf({ ...base, gcalEventId: "ev-other" }), "another outside event on the call is a new key");
  assert(await keyOf(base) !== await keyOf({ ...base, bookingStartMs: T("2026-10-01T18:00:00Z") }),
    "the call moved onto another clash is a new key");
  assert(await keyOf({ ...base, gcalEventId: null }) !== await keyOf({ ...base, gcalEventId: null, eventStartMs: T("2026-10-01T16:45:00Z") }),
    "an outside event with no id is told apart by its window");
}

// 5. No clashes, no pages.
{
  const r = recorder();
  await pageExternalCollisions("x@trypennie.com", [], { notify: r.notify, bookingUrl: url });
  eq(r.sent.length, 0, "nothing to page");
}

finish();
