// #3530: an advisor the confirm's ladder read leaves out is paged, not just logged.
//
// The reader drops an advisor whose rows it cannot read rather than failing every
// ladder (`ladderInputsFrom`), and that keeps them from being double booked. It also
// makes them unbookable with nothing on any screen saying so: the bucket still offers
// times through everybody else, so nothing reads as broken. That is a staffing fault
// somebody has to repair, so the monitor lane asks the confirm's own reader each pass and
// pages `ladder_advisor_unreadable` while anybody is left out.
//
// The rules held here: a page names who and in plain words what could not be read; the
// all clear hangs ONLY off a read that answered and dropped nobody; a read that fails
// sends neither, and fails the step, so the step failure page (`monitor_step_failing`)
// says the check has stopped rather than the alert going quiet (#1134, #1152, L98).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-ladder-dropped-advisors.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  LADDER_DROPPED_KEY,
  formatLadderDroppedAlert,
  formatLadderDroppedRecovery,
  runLadderDroppedCheck,
} from "../src/lib/monitor/ladder-dropped-advisors.ts";
import type { DroppedAdvisor } from "../src/lib/availability/ladder-inputs.ts";

const ROBIN: DroppedAdvisor = { id: "u1", name: "Robin Example", why: ["agents: no readable org, attributes or email"] };
const GHOST: DroppedAdvisor = { id: "u2", name: null, why: ["busy: no readable bounds or source", "holds: no readable booking or window"] };

function fakes(read: () => Promise<readonly DroppedAdvisor[]>) {
  const sent: { key: string; text: string }[] = [];
  const resolved: { key: string; text: string }[] = [];
  return {
    sent,
    resolved,
    deps: {
      read,
      cooldownMs: 1_000,
      notify: async (key: string, _ms: number, text: string) => {
        sent.push({ key, text });
        return true;
      },
      resolve: async (key: string, text: string) => {
        resolved.push({ key, text });
        return true;
      },
    },
  };
}

async function main() {
  eq(LADDER_DROPPED_KEY, "ladder_advisor_unreadable", "the key");

  // Somebody dropped: one page, naming them, never an all clear.
  {
    const f = fakes(async () => [ROBIN, GHOST]);
    const r = await runLadderDroppedCheck(f.deps);
    eq(r.status, "dropped", "dropped: the result says so");
    eq(f.sent.length, 1, "dropped: one page");
    eq(f.sent[0]?.key, LADDER_DROPPED_KEY, "dropped: on the key");
    eq(f.resolved.length, 0, "dropped: no all clear");
    const text = f.sent[0]?.text ?? "";
    assert(text.includes("Robin Example") && text.includes("u2"), `dropped: names each advisor, by id when there is no name (got ${text})`);
    assert(/2 advisors/.test(text), `dropped: counts them (got ${text})`);
    assert(/profile/.test(text) && /calendar/.test(text) && /reroute hold/.test(text), `dropped: says in plain words what could not be read (got ${text})`);
    assert(!/no readable/.test(text), `dropped: never the raw reason text (got ${text})`);
  }

  // Nobody dropped, measured: the all clear, and no page.
  {
    const f = fakes(async () => []);
    const r = await runLadderDroppedCheck(f.deps);
    eq(r.status, "clear", "clear: the result says so");
    eq(f.sent.length, 0, "clear: no page");
    eq(f.resolved.length, 1, "clear: the all clear, off a read that answered");
    eq(f.resolved[0]?.key, LADDER_DROPPED_KEY, "clear: on the key");
  }

  // The read fails: nothing sent either way, and the failure goes up so the step fails.
  {
    const f = fakes(async () => {
      throw new Error("ladder candidate inputs: connection reset");
    });
    let thrown: unknown = null;
    try {
      await runLadderDroppedCheck(f.deps);
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof Error && /connection reset/.test(thrown.message), `unreadable: the failure goes up, so the step fails (got ${String(thrown)})`);
    eq(f.sent.length, 0, "unreadable: no page claiming who was dropped");
    eq(f.resolved.length, 0, "unreadable: no all clear off a read that measured nothing");
  }

  // A page or all clear that fails to send never fails the tick.
  {
    const f = fakes(async () => [ROBIN]);
    f.deps.notify = async () => {
      throw new Error("slack down");
    };
    const r = await runLadderDroppedCheck(f.deps);
    eq(r.status, "dropped", "a failed send still reports what was measured");
  }

  // The copy, singular and past the name cap.
  assert(/^1 advisor /.test(formatLadderDroppedAlert([ROBIN])), `copy: one advisor reads singular (got ${formatLadderDroppedAlert([ROBIN])})`);
  const many = formatLadderDroppedAlert(Array.from({ length: 11 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}`, why: ["schedules: no readable rule"] })));
  assert(/and 3 more/.test(many) && !many.includes("Person 10"), `copy: past eight names it counts the rest (got ${many})`);
  assert(formatLadderDroppedRecovery().length > 0, "copy: the all clear says something");
}

main().then(finish);
