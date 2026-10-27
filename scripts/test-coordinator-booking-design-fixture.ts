// The coordinator booking design's fixture (docs/design/fixtures/coordinator-booking.json), held
// to the settled design and to the page (#4205).
//
// The settled file (docs/design/coordinator-booking.html) carries its fixture and its frames in
// its captured template, and the page's `?frame=` preview reads the committed fixture through
// `coordinatorBookingFrame`, which reaches each frame by the reducer's own events and the real
// start time predicate. So the design match score compares like with like only while the two are
// the same data. This holds the fixture to the design, the words the design draws to the copy the
// page ships, the frames to the moments the design draws, and the design's checks to its map.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coordinator-booking-design-fixture.ts
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { assert, eq, finish } from "./lib/harness.ts";
import { COORDINATOR_PAGE_COPY as COPY } from "../src/lib/coordinator/booking-page-copy.ts";
import { pageView, zoneNames } from "../src/lib/coordinator/booking-page.ts";
import { coordinatorBookingFrame, designZone, type CoordinatorBookingDesignFixture } from "../src/lib/coordinator/booking-page-fixture.ts";
import { RESCHEDULE_REASONS } from "../src/lib/booking/core.ts";
import { refusalSentence } from "../src/lib/coordinator/coordinator-copy.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const fixture = JSON.parse(read("docs/design/fixtures/coordinator-booking.json")) as CoordinatorBookingDesignFixture;
const design = read("docs/design/coordinator-booking.html");

// --- the design's own data, read out of the settled file ---------------------------------------
const templateStart = design.indexOf("var DR_TEMPLATE = ");
const templateEnd = design.indexOf('";\nvar DR_VARIANTS');
assert(templateStart > 0 && templateEnd > templateStart, "the settled file carries its captured template");
const template = JSON.parse(design.slice(templateStart + "var DR_TEMPLATE = ".length, templateEnd + 1)) as string;
const fixtureMatch = /window\.DESIGN_FIXTURE = (\{.*?\});<\/script>/.exec(template);
assert(fixtureMatch !== null, "the template carries the fixture it draws from");
const designFixture = JSON.parse(fixtureMatch![1]!) as CoordinatorBookingDesignFixture["design"];
const variantsMatch = /var DR_VARIANTS = (\{.*?\});\n/.exec(design);
assert(variantsMatch !== null, "the settled file names its frames' variants");
const designVariants = Object.fromEntries(
  Object.entries(JSON.parse(variantsMatch![1]!) as Record<string, string>).map(([id, v]) => [id, JSON.parse(v)]),
);

// --- the committed fixture is the design's ------------------------------------------------------
eq(fixture.design, designFixture, "the committed fixture is the one the design draws, word for word");
eq(fixture.frames, designVariants, "the committed fixture's frames are the design's variants");

// --- the design draws the sentences the page ships ----------------------------------------------
{
  const d = fixture.design;
  eq(d.page, COPY.page, "title");
  eq(d.lead, COPY.lead, "the Lead field, its button, its working state and its refusals");
  eq(refusalSentence("not-a-lead-id"), d.lead.notALeadId, "the server refuses a reference that is not a Lead in the design's words (D31)");
  eq(refusalSentence("no-such-lead"), d.lead.noSuchLead, "and a Lead Salesforce does not hold");
  eq(d.customer, COPY.customer, "the customer's details");
  const { reasons, ...newTime } = d.newTime;
  eq(newTime, COPY.newTime, "the booking card's words");
  eq(reasons, RESCHEDULE_REASONS.map((r) => ({ code: r.code, label: r.label })), "the reasons are the product's reschedule reasons (7.14)");
  eq(d.outcome, COPY.outcome, "the working and done states");
  eq(d.warning, COPY.warning, "the existing call's notice, its checkbox and the locked card's words");
  eq(d.day, COPY.day, "the day chips' words");
  eq(d.dialog, COPY.dialog, "the confirmation dialog");
  for (const c of Object.values(d.customers)) {
    const zone = designZone(c.zone);
    eq(zoneNames(zone), { name: c.zone, spoken: c.zoneSpoken }, `${c.name}'s zone, named and read back as the design writes it`);
  }
  assert(!/\bTick\b/i.test(JSON.stringify(COPY)), "the page says Check, never Tick (D20)");
}

// --- every frame resolves to the moment the design draws -----------------------------------------
{
  const ids = Object.keys(fixture.frames);
  eq(ids.length, 18, "eighteen frames");
  const view = (id: string) => {
    const f = coordinatorBookingFrame(fixture, id);
    return pageView(f.state, { nowMs: f.nowMs, reasons: f.reasons });
  };
  for (const id of ids) {
    const f = coordinatorBookingFrame(fixture, id);
    eq(f.theme, fixture.frames[id]!.theme, `${id} has its theme`);
  }
  eq(view("f-locked").booking?.line.text, "Check the box above after you tell Jordan.", "f-locked: Jordan's card locked");
  eq(view("f-pressed").booking?.overlay, COPY.warning.overlay, "f-pressed: the pointer is up");
  eq(view("f-unlocked").booking?.line.text, "On Thursday, November 19, calls can start from 8:00am to 5:30pm.", "f-unlocked: Thursday chosen (D14)");
  eq(view("f-unlocked").booking?.confirm.label, "Move the call to Thursday, November 19 at 2:00pm", "at 2:00pm");
  eq(view("f-other").booking?.confirm.note, COPY.newTime.detailNeeded, "f-other: Other with its box empty");
  eq(view("f-dialog-move").dialog?.when, "Thursday, November 19 at 2:00pm, Arizona time (Phoenix)", "f-dialog-move: the dialog reads the move back");
  eq(view("f-done-move").done?.with, "With Ada Example.", "f-done-move: moved, with the advisor");
  eq(view("f-sam-empty").booking?.line.text, COPY.newTime.pickDay, "f-sam-empty: Sam with nothing chosen");
  eq(view("f-sam-dialog").dialog?.title, "Book this call for Sam Okafor?", "f-sam-dialog");
  eq(view("f-sam-done").done?.when, "Tuesday, November 17 at 10:00am", "f-sam-done: with an advisor");
  eq(view("f-sam-marcia").done?.with, "With Marcia, Pennie's AI agent. No advisor was free at this time, so Marcia will text Sam.", "f-sam-marcia: nobody free (D29)");
  eq(view("f-refusal").lead.refusal, COPY.lead.notALeadId, "f-refusal");
  const late = view("f-today-closed").booking!.days;
  eq([late[0]?.label, late.at(-1)?.label], ["Monday, November 16, Today, Closed", "Friday, November 20"], "f-today-closed: the clock moved to Monday evening (D13)");
  eq(coordinatorBookingFrame(fixture, "d-locked").theme, "dark", "a dark frame");
  let threw = "";
  try {
    coordinatorBookingFrame(fixture, "f-nope");
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(threw.includes("f-nope"), `an unknown frame refuses by name (${threw})`);
}

// --- the design's checks are the decision map's ------------------------------------------------
{
  const sandbox: { window: { DESIGN_CHECKS?: { id: string; frames: string[] }[] } } = { window: {} };
  runInNewContext(read("docs/design/coordinator-booking.checks.js"), sandbox);
  const checks = sandbox.window.DESIGN_CHECKS ?? [];
  const map = JSON.parse(/<script type="application\/json" id="decision-map">([\s\S]*?)<\/script>/.exec(design)![1]!) as {
    decisions: { id: string; frames?: string[]; verify: string }[];
  };
  const checked = map.decisions.filter((d) => d.verify === "check");
  eq(checks.map((c) => c.id).sort(), checked.map((d) => d.id).sort(), "one check per checked decision");
  for (const d of checked) {
    eq(checks.find((c) => c.id === d.id)?.frames, d.frames, `${d.id}'s check runs on the frames the map names`);
  }
}

finish();
