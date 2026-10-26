// The /admin/alerts switch design's fixture (docs/design/fixtures/admin-alerts-help-text.json), held to
// the page. The settled design (docs/design/admin-alerts-help-text.html) draws its frames from that
// file, and the page's fixture preview (`?frame=`) reads the same file, so the design match score
// compares like with like. This holds the copy the design draws to the copy the page ships, and the
// frames to drawing every sentence somewhere.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-alerts-design-fixture.ts
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import { alertSwitchCopy } from "../src/lib/monitor/alert-switch-copy.ts";
import { alertsFixtureFrame, type AlertsDesignFixture } from "../src/lib/admin/alerts-design-fixture.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../docs/design/fixtures/admin-alerts-help-text.json", import.meta.url), "utf8"),
) as AlertsDesignFixture;

// --- the design draws the sentences the page ships -------------------------------------------------
{
  // Before cutover, as the local stack the design was captured on reads (calcom_retired unset).
  const page = alertSwitchCopy(false).map(({ name, label, on, off }) => ({ name, label, on, off }));
  eq(fixture.switches, page, "the fixture's switches are the page's own, in its order and words");
}

// --- every sentence is drawn on some frame ---------------------------------------------------------
{
  const frames = Object.keys(fixture.frames);
  assert(frames.length >= 2, "at least two frames");
  for (const s of fixture.switches) {
    const states = new Set(frames.map((id) => alertsFixtureFrame(fixture, id).armed[s.name]));
    assert(states.has(true) && states.has(false), `${s.name} is drawn both on and off across the frames`);
  }
  for (const id of frames) {
    const states = Object.values(alertsFixtureFrame(fixture, id).armed);
    assert(states.includes(true) && states.includes(false), `frame ${id} mixes on and off`);
  }
}

// --- a frame the fixture cannot answer refuses, never draws a guess --------------------------------
{
  let threw = "";
  try {
    alertsFixtureFrame(fixture, "nope");
  } catch (e) {
    threw = String(e);
  }
  assert(/names no frame "nope"/.test(threw), "an unknown frame refuses by name");

  const short = structuredClone(fixture);
  const first = Object.keys(short.frames)[0];
  delete (short.frames[first].armed as Record<string, boolean>).regal_calls_armed;
  threw = "";
  try {
    alertsFixtureFrame(short, first);
  } catch (e) {
    threw = String(e);
  }
  assert(/regal_calls_armed/.test(threw), "a frame missing a switch's state refuses, naming the switch");
}

finish();
