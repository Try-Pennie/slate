// One texting line per lead (#3718). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-lead-texting-line.ts
//
// Pennie's automations service hands out a different line on every ask (measured
// 2026-10-15: six asks for one lead, six lines), so Slate remembers the line it gave a
// lead. Dan's rule: the same lead gets the same line every time, unless that line no
// longer exists. What this file pins, on an in memory store with the real store's
// semantics and an injected clock:
//  - the first press asks the service and saves what it gave; later presses reuse it;
//  - a saved line Sendblue calls dead is replaced, and one it cannot judge is kept;
//  - two presses at once end on ONE line: the first save wins and the second is told
//    what won, and a replacement only lands over the line it was replacing;
//  - every failure on the way (the store, the service) is no line rather than a line
//    the lead may not see again, and is reported;
//  - a 15 and an 18 character id for the same lead are the same lead.
import { leadTextingKey, textingLineForLead, type TextingLineStore } from "../src/lib/automations/lead-texting-line.ts";
import type { LineState } from "../src/lib/automations/sendblue-line-state.ts";
import { TEXTING_LINE_DEADLINE_MS } from "../src/lib/automations/texting-line.ts";
import type { ScheduleTimer } from "../src/lib/read-within-deadline.ts";
import { eq, finish } from "./lib/harness.ts";

const LEAD = "00QUl00000JtyVGMAZ";
const KEY = "00QUl00000JtyVG";

function memoryStore(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  const calls: string[] = [];
  const store: TextingLineStore = {
    async read(key) {
      calls.push(`read ${key}`);
      return rows.get(key) ?? null;
    },
    async claim(key, line) {
      calls.push(`claim ${key} ${line}`);
      if (!rows.has(key)) rows.set(key, line);
      return rows.get(key) as string;
    },
    async swap(key, from, to) {
      calls.push(`swap ${key} ${from} ${to}`);
      if (rows.get(key) === from) rows.set(key, to);
      return rows.get(key) as string;
    },
  };
  return { rows, calls, store };
}

function deps(store: TextingLineStore, o: { state?: LineState; fresh?: (string | null)[]; timer?: ScheduleTimer } = {}) {
  const fresh = [...(o.fresh ?? ["+12125550101"])];
  const asked = { service: 0, sendblue: [] as string[] };
  const errs: unknown[] = [];
  return {
    asked,
    errs,
    deps: {
      store,
      lineState: async (line: string) => {
        asked.sendblue.push(line);
        return o.state ?? "alive";
      },
      fetchLine: async () => {
        asked.service++;
        return fresh.length ? (fresh.shift() as string | null) : null;
      },
      onUnread: (e: unknown) => errs.push(e),
      timer: o.timer ?? ((() => () => {}) as ScheduleTimer),
    },
  };
}

eq(leadTextingKey(LEAD), KEY, "an 18 character id is keyed on its first 15");
eq(leadTextingKey(KEY), KEY, "and a 15 character id on itself, so both are one lead");

{
  const { rows, store } = memoryStore();
  const d = deps(store);
  eq(await textingLineForLead(LEAD, d.deps), "+12125550101", "first press: the service's line");
  eq(rows.get(KEY), "+12125550101", "saved for the lead");
  eq(d.asked.sendblue.length, 0, "a line just handed out is not checked with Sendblue");
}
{
  const { store } = memoryStore({ [KEY]: "+12125550101" });
  const d = deps(store, { state: "alive", fresh: ["+19995550000"] });
  eq(await textingLineForLead(KEY, d.deps), "+12125550101", "a later press, the line alive: the same line");
  eq(d.asked.service, 0, "and the service is not asked for another");
  eq(d.asked.sendblue, ["+12125550101"], "after asking Sendblue about the saved line");
}
{
  const { rows, store } = memoryStore({ [KEY]: "+12125550101" });
  const d = deps(store, { state: "unknown", fresh: ["+19995550000"] });
  eq(await textingLineForLead(LEAD, d.deps), "+12125550101", "Sendblue cannot say: the saved line is kept");
  eq(d.asked.service, 0, "and no new line is asked for");
  eq(rows.get(KEY), "+12125550101", "and nothing is changed");
}
{
  const { rows, store, calls } = memoryStore({ [KEY]: "+12125550101" });
  const d = deps(store, { state: "dead", fresh: ["+13135550102"] });
  eq(await textingLineForLead(LEAD, d.deps), "+13135550102", "the saved line is dead: a new one");
  eq(rows.get(KEY), "+13135550102", "saved in its place");
  eq(calls.includes(`swap ${KEY} +12125550101 +13135550102`), true, "replacing only the dead line");
}
{
  const { rows, store } = memoryStore({ [KEY]: "+12125550101" });
  const d = deps(store, { state: "dead", fresh: [null] });
  eq(await textingLineForLead(LEAD, d.deps), null, "dead line and no new one to give: no line, never the dead one");
  eq(rows.get(KEY), "+12125550101", "and the store is left alone");
}
{
  const { store } = memoryStore();
  const d = deps(store, { fresh: [null] });
  eq(await textingLineForLead(LEAD, d.deps), null, "first press and the service gives nothing: no line");
}
{
  // Two first presses at once: both read nothing, both ask the service and get
  // different lines; the store keeps the first save and both are shown that one.
  const { rows, store } = memoryStore();
  const d = deps(store, { fresh: ["+12125550101", "+13135550102"] });
  const [a, b] = await Promise.all([textingLineForLead(LEAD, d.deps), textingLineForLead(LEAD, d.deps)]);
  eq([a, b], ["+12125550101", "+12125550101"], "two first presses at once: one line for both");
  eq(rows.get(KEY), "+12125550101", "the first save stands");
}
{
  // Two presses replacing the same dead line at once: one replacement lands, the
  // other is told what landed rather than overwriting it.
  const { rows, store } = memoryStore({ [KEY]: "+12125550101" });
  const d = deps(store, { state: "dead", fresh: ["+13135550102", "+14145550103"] });
  const [a, b] = await Promise.all([textingLineForLead(LEAD, d.deps), textingLineForLead(LEAD, d.deps)]);
  eq([a, b], ["+13135550102", "+13135550102"], "two replacements at once: one line for both");
  eq(rows.get(KEY), "+13135550102", "the first replacement stands");
}
for (const which of ["read", "claim", "swap"] as const) {
  const { store } = memoryStore(which === "swap" ? { [KEY]: "+12125550101" } : {});
  const broken: TextingLineStore = {
    ...store,
    [which]: async () => {
      throw new Error(`${which} refused`);
    },
  };
  const d = deps(broken, { state: "dead", fresh: ["+13135550102"] });
  eq(await textingLineForLead(LEAD, d.deps), null, `the store's ${which} fails: no line, since a line not saved may differ next time`);
  eq(d.errs.length, 1, `and the ${which} failure is reported once`);
}
{
  const { store } = memoryStore();
  const d = deps(store);
  d.deps.store = { ...store, read: async () => { throw new Error("read refused"); } };
  await textingLineForLead(LEAD, d.deps);
  eq(d.asked.service, 0, "an unreadable store asks the service for nothing, since it could not be saved anyway");
}
{
  // The whole lookup runs under the confirmation's one deadline.
  let fire: () => void = () => {};
  let askedMs = 0;
  const timer: ScheduleTimer = (ms, f) => {
    askedMs = ms;
    fire = f;
    return () => {};
  };
  const hung: TextingLineStore = { read: () => new Promise(() => {}), claim: async (_k, l) => l, swap: async (_k, _f, t) => t };
  const d = deps(hung, { timer });
  const pending = textingLineForLead(LEAD, d.deps);
  await Promise.resolve();
  fire();
  eq(await pending, null, "past the deadline: no line");
  eq(askedMs, TEXTING_LINE_DEADLINE_MS, "the same deadline the confirmation already waits");
  eq(d.errs.length, 1, "and the timeout is reported");
}

finish();
