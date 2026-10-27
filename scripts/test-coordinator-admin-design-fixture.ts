// The Coordinator booking design's fixture (docs/design/fixtures/coordinator-admin.json), held to
// the settled design and to the page (#4264).
//
// The settled file (docs/design/coordinator-admin.html) carries its fixture and its frames inside
// the captured template, and the page's `?frame=` preview reads the committed fixture, so the design
// match score compares like with like only while the two are the same data. This holds the fixture
// to the design, the copy the fixture draws to the copy the page ships, the frames to the variants
// the design draws, and the design's checks to its decision map.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-coordinator-admin-design-fixture.ts
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { assert, eq, finish } from "./lib/harness.ts";
import { COORDINATOR_BOOKING_COPY, COORDINATOR_BOOKING_HREF } from "../src/lib/admin/coordinator-booking-copy.ts";
import { coordinatorFrame, type CoordinatorDesignFixture } from "../src/lib/admin/coordinator-admin-fixture.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const fixture = JSON.parse(read("docs/design/fixtures/coordinator-admin.json")) as CoordinatorDesignFixture;
const design = read("docs/design/coordinator-admin.html");

// --- the design's own data, read out of the settled file ---------------------------------------
const templateStart = design.indexOf("var DR_TEMPLATE = ");
const templateEnd = design.indexOf('";\nvar DR_VARIANTS');
assert(templateStart > 0 && templateEnd > templateStart, "the settled file carries its captured template");
const template = JSON.parse(design.slice(templateStart + "var DR_TEMPLATE = ".length, templateEnd + 1)) as string;
const fixtureMatch = /window\.DESIGN_FIXTURE = (\{.*?\});<\/script>/.exec(template);
assert(fixtureMatch !== null, "the template carries the fixture it draws from");
const designFixture = JSON.parse(fixtureMatch![1]!) as { adminSwitch: CoordinatorDesignFixture["adminSwitch"] };
const variantsMatch = /var DR_VARIANTS = (\{.*?\});\n/.exec(design);
assert(variantsMatch !== null, "the settled file names its frames' variants");
const designVariants = Object.fromEntries(
  Object.entries(JSON.parse(variantsMatch![1]!) as Record<string, string>).map(([id, v]) => [id, JSON.parse(v)]),
);

// --- the committed fixture is the design's ------------------------------------------------------
eq(fixture.adminSwitch, designFixture.adminSwitch, "the committed fixture is the one the design draws, word for word");
eq(fixture.frames, designVariants, "the committed fixture's frames are the design's variants");

// --- the design draws the sentences the page ships ----------------------------------------------
{
  const a = fixture.adminSwitch;
  eq(a.page.title, COORDINATOR_BOOKING_COPY.page.title, "title");
  eq(a.page.intro, COORDINATOR_BOOKING_COPY.page.intro, "intro");
  eq(a.page.href, COORDINATOR_BOOKING_HREF, "route");
  eq(a.section, COORDINATOR_BOOKING_COPY.section, "section heading");
  eq(a.switch, COORDINATOR_BOOKING_COPY.switch, "the switch's sentences and buttons");
  eq(a.list, COORDINATOR_BOOKING_COPY.list, "the list's headers, empty, failed and question");
}

// --- every frame resolves, and one the fixture does not name refuses -----------------------------
{
  const ids = Object.keys(fixture.frames);
  eq(ids.length, 7, "seven frames");
  for (const id of ids) {
    const f = coordinatorFrame(fixture, id);
    assert(f.theme === "light" || f.theme === "dark", `${id} has a theme`);
  }
  const remove = coordinatorFrame(fixture, "f-remove");
  eq(remove.removing, "design-0", "the remove frame opens the question on the first coordinator");
  eq(coordinatorFrame(fixture, "f-confirm-on").switchState, "confirm-on", "the confirm frame opens the switch's question");
  eq(coordinatorFrame(fixture, "f-on").switchState, "on", "the on frame");
  const failed = coordinatorFrame(fixture, "f-failed");
  eq(failed.read.ok, false, "the failed frame draws the read failure, never an empty list");
  const empty = coordinatorFrame(fixture, "f-empty");
  eq(empty.read.ok && empty.read.rows.length, 0, "the empty frame draws nobody");
  const off = coordinatorFrame(fixture, "f-off");
  eq(off.read.ok && off.read.rows.map((r) => r.name), fixture.adminSwitch.coordinators.map((c) => c.name), "rows from the fixture");
  eq(coordinatorFrame(fixture, "d-off").theme, "dark", "the dark frame");
  let threw = "";
  try {
    coordinatorFrame(fixture, "f-nope");
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(threw.includes("f-nope"), `an unknown frame refuses by name (${threw})`);
}

// --- the design's checks are the decision map's ------------------------------------------------
{
  const sandbox: { window: { DESIGN_CHECKS?: { id: string; frames: string[] }[] } } = { window: {} };
  runInNewContext(read("docs/design/coordinator-admin.checks.js"), sandbox);
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
