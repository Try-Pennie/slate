// Repo invariant (#216 / audit AUD-076): the booking horizon must have ONE source
// of truth. It used to be a hardcoded `const HORIZON_DAYS = 4` in Booker.tsx that
// "mirrors the server constant", so if the server value changed (exactly what #216
// makes possible), the client would silently render bookable days as unavailable.
//
// The fix makes `horizonDays` a REQUIRED prop resolved server-side, so tsc already
// forces every construction site to pass it. This guard is the belt-and-suspenders
// the acceptance criteria asks for: it fails if Booker.tsx reintroduces a hardcoded
// horizon-day constant, which would recreate the divergence the required prop
// otherwise prevents.
//
// Run: node --experimental-strip-types scripts/test-booker-horizon-source.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const src = readFileSync(join(ROOT, "src/components/Booker.tsx"), "utf8");

// The exact defunct pattern (and near variants): a local constant named for the
// horizon assigned a number literal. `horizonDays` must arrive as a prop, never be
// re-hardcoded here.
const hardcoded = /\b(?:const|let|var)\s+(?:HORIZON_DAYS|horizonDays)\s*=\s*\d/;
assert(
  !hardcoded.test(src),
  "Booker.tsx has no hardcoded horizon-day constant (horizonDays must come from the required prop, AUD-076)",
);

// Positive control: prove the regex still catches the bad shape, so the guard can't
// silently rot into a no-op if the pattern is edited.
assert(
  hardcoded.test("  const HORIZON_DAYS = 4;\n"),
  "positive control: the detector still flags a reintroduced `const HORIZON_DAYS = 4`",
);

// --- #1654: code that MEASURES against the horizon may not guess at it ---------
//
// `loadBookingHorizonDays` degrades to the coded default on a read error, and that
// is right for the booker, the availability routes and the recompute lanes: they
// have to keep SERVING, and the standard window is a correct thing to serve.
//
// It is wrong for anything that measures against the window, because the horizon
// decides both how far ahead the booker offers and the window availability is
// computed over. A guessed one does not make a reading unavailable, it silently
// changes what the reading MEANS, and nothing about the resulting number looks
// wrong. Those callers take `readBookingHorizonDays`, which returns null when the
// read failed, and refuse.
//
// This was not a hypothetical disagreement. The monitor lane's own gate could
// never fire while it called the degrading reader: the step never failed, the gate
// never opened, and the lane measured against a guessed horizon while reading as
// though it refused to (L109).
const MEASURING_DIRS = [
  "src/lib/monitor",
  "src/lib/admin",
  "src/app/api/cron/monitor",
];
const DEGRADING_READER = "loadBookingHorizonDays";

function tsFilesUnder(dir: string): string[] {
  const abs = join(ROOT, dir);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(abs);
  return out;
}

// Derived by walking the directories, not from a list of files (L96): a measuring
// module added later is covered by construction rather than by somebody
// remembering to add it here.
const measuringFiles = MEASURING_DIRS.flatMap(tsFilesUnder);
assert(
  measuringFiles.length > 20,
  `the measuring sweep really found files to read (${measuringFiles.length})`,
);

/** Comments stripped, so the guard is never satisfied OR tripped by prose about
 *  the call, including the comment in the monitor lane explaining this very rule
 *  (L518: a source check that reads whole lines answers to the wrong text). */
const codeOnly = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

const guessing = measuringFiles.filter((f) =>
  new RegExp(`\\b${DEGRADING_READER}\\b`).test(codeOnly(readFileSync(f, "utf8"))),
);
assert(
  guessing.length === 0,
  `no measuring code guesses the horizon; found ${DEGRADING_READER} in: ${guessing
    .map((f) => f.slice(ROOT.length + 1))
    .join(", ")}`,
);

// Positive control on the same predicate the sweep uses, so a regex that stopped
// matching anything could not read as a clean tree (L98).
assert(
  new RegExp(`\\b${DEGRADING_READER}\\b`).test(
    codeOnly("  const horizonDays = await loadBookingHorizonDays();\n"),
  ),
  "positive control: the detector still flags a measuring caller taking the degrading reader",
);
// The other direction, which is what the stripping is for: a comment NAMING the
// banned reader must not read as a call to it, or the rule could not be written
// down beside the code it governs.
assert(
  !new RegExp(`\\b${DEGRADING_READER}\\b`).test(
    codeOnly("  // loadBookingHorizonDays would guess here\n  const h = await readBookingHorizonDays();\n"),
  ),
  "negative control: a comment naming the degrading reader is not a call to it",
);

// An OVERLAY of the real tree, which is what proves the sweep rather than the
// regex: put the degrading reader back into the monitor lane's actual source, in
// memory, and require the same filter to name that file. A control built from a
// synthetic string cannot tell a working sweep from one whose file walk or
// comment stripping quietly stopped matching real code.
{
  const laneFile = measuringFiles.find((f) => f.endsWith("app/api/cron/monitor/route.ts"));
  assert(laneFile !== undefined, "the monitor lane is inside the measuring sweep");
  const reverted = readFileSync(laneFile!, "utf8").replace(
    /readBookingHorizonDays\(\)/g,
    "loadBookingHorizonDays()",
  );
  assert(
    new RegExp(`\\b${DEGRADING_READER}\\b`).test(codeOnly(reverted)),
    "overlay control: the sweep catches the monitor lane taking the degrading reader again",
  );
}

// And the two readers are genuinely different things, not one aliased to the
// other: a file that exported both names from one implementation would satisfy
// every check above while measuring code went on guessing.
const settingsSrc = readFileSync(join(ROOT, "src/lib/booking/settings.ts"), "utf8");
assert(
  /export async function readBookingHorizonDays\(\): Promise<number \| null>/.test(settingsSrc),
  "readBookingHorizonDays can report a failed read, so a caller is able to refuse",
);

finish();
