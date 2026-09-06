// #1994: what was typed, kept across the reload a stale save forces.
//
// When a deploy lands under an open page the save dies and the only way back is
// a reload, because the page's server actions no longer exist by name. Next's
// own self-hosting guide says a reload loses component state, and #1966 was Dan
// losing a week of hours to exactly that. A reload shipped without this trades a
// crash for silent data loss, which is worse: a crash is at least visible.
//
// Everything here is pure with the storage injected, so every branch is driven
// with no browser.
//
// Run: node --experimental-strip-types scripts/test-form-restore.ts
import {
  clearStash,
  entriesToRestored,
  readStash,
  restoreKey,
  restoredValue,
  stashForm,
  type RestoreStore,
} from "../src/lib/form-restore.ts";
import { assert, eq, finish } from "./lib/harness.ts";

function fakeStore(): RestoreStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** A store that throws on everything, which is a private window, a full quota,
 *  or a browser told to block site data. */
const brokenStore: RestoreStore = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
  removeItem() {
    throw new Error("blocked");
  },
};

// ---------------------------------------------------------------------------
// A round trip, including the multi value fields these forms really post.
// ---------------------------------------------------------------------------
{
  const store = fakeStore();
  const entries: [string, string][] = [
    ["start_1", "08:00"],
    ["end_1", "17:00"],
    ["members", "u1"],
    ["members", "u2"],
    ["timezone", "America/New_York"],
  ];
  const form = entriesToRestored(entries);
  // Several entries under one name is not an edge case here: bucket members and
  // routing criteria both post that way, and keeping only the last would restore
  // a pool with one person in it.
  eq(form.members?.length, 2, "both values under one name are kept");
  eq(form.start_1?.[0], "08:00", "and a single value reads as itself");

  assert(stashForm(store, "/me", "working-hours", form), "the stash is written");
  const back = readStash(store, "/me", "working-hours");
  eq(JSON.stringify(back), JSON.stringify(form), "and comes back unchanged");
  eq(restoredValue(back, "start_1"), "08:00", "a field reads its own value");
  eq(restoredValue(back, "not_a_field"), null, "and a field with nothing stashed gets null");
}

// The PATH is part of the key, so one page's hours cannot be restored onto
// another's. Two pages carry forms with the same field names.
{
  const store = fakeStore();
  stashForm(store, "/me", "working-hours", { start_1: ["08:00"] });
  eq(readStash(store, "/admin/agents/x1", "working-hours"), null, "another page gets nothing");
  eq(readStash(store, "/me", "other-form"), null, "and another form on the same page gets nothing");
  assert(
    restoreKey("/me", "a") !== restoreKey("/me", "b"),
    "two forms on one page have two keys",
  );
}

// Clearing means a second reload does not silently re-apply values the person
// has since changed.
{
  const store = fakeStore();
  stashForm(store, "/me", "working-hours", { start_1: ["08:00"] });
  clearStash(store, "/me", "working-hours");
  eq(readStash(store, "/me", "working-hours"), null, "a cleared stash is gone");
}

// ---------------------------------------------------------------------------
// Everything unreadable is NULL, never a partial restore.
// ---------------------------------------------------------------------------
//
// A half restored form is a form quietly holding some of somebody's values and
// some of the stored ones, and nothing on screen says which field came from
// where. Refusing the whole thing is the honest answer (L11).
{
  const store = fakeStore();
  const key = restoreKey("/me", "f");
  for (const [label, raw] of [
    ["not JSON at all", "{oh dear"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON string", '"hello"'],
    ["null", "null"],
    ["a field holding a number", '{"a":[1]}'],
    ["a field holding a bare string", '{"a":"x"}'],
    ["a field holding an object", '{"a":[{"b":1}]}'],
  ] as [string, string][]) {
    store.map.set(key, raw);
    eq(readStash(store, "/me", "f"), null, `${label} restores nothing`);
  }
  store.map.delete(key);
  eq(readStash(store, "/me", "f"), null, "and an absent stash is nothing");
}

// ---------------------------------------------------------------------------
// A storage that refuses must not add a second failure to the first.
// ---------------------------------------------------------------------------
//
// This runs at the moment a save has ALREADY died. An exception here would
// replace a recoverable message with the crash screen the whole change exists to
// remove, and it would do it in a private window, which is not a rare setup.
{
  eq(stashForm(brokenStore, "/me", "f", { a: ["1"] }), false, "a refused write says so");
  eq(readStash(brokenStore, "/me", "f"), null, "a refused read is nothing, not a throw");
  clearStash(brokenStore, "/me", "f");
  assert(true, "and a refused clear is silent");
}

// A file input has no text form worth keeping. It is skipped by TYPE rather than
// coerced, because "[object File]" restored into a field is a lie about what was
// kept. None of these forms carry one today; the branch exists so adding one
// later cannot silently corrupt a restore.
{
  const form = entriesToRestored([
    ["name", "Dan"],
    ["avatar", new File([], "x.png") as unknown as FormDataEntryValue],
  ]);
  eq(Object.keys(form).join(","), "name", "a file entry is left out entirely");
}

finish();
