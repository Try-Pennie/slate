// CPU benchmark for `computeBucketSlots` (#2806). Hand run; NOT a suite (the name
// deliberately avoids the `test-*` glob), because a timing is a property of the
// machine running it and a gate on one would fail on a busy laptop (L294, L356).
//
//   node --experimental-strip-types scripts/bench-bucket-slots.ts
//   node --experimental-strip-types scripts/bench-bucket-slots.ts --samples 30 --module /path/to/compute.ts
//
// One window is the next-available probe's: seven org days, an 80 member pool over
// the seven roster zones at the live event type's settings (scripts/lib/
// slot-compute-fixtures.ts, `benchOptions`). Each sample is ONE call on a FRESH
// fixture seed, timed by `process.cpuUsage()` (CPU, user plus system) and by the wall
// clock, after warm up calls that let the JIT settle. It prints every sample's
// spread (min, quartiles, median, max), not one number, because one reading per arm
// cannot be told from noise (L395, L656), and the load average beside it, because a
// reading on a machine that is also building measures both (L356).
//
// `--module` points it at another copy of compute.ts (say, the previous commit's,
// written out with `git show`), which is how a before and after pair is measured
// on the same fixtures in the same process conditions.
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { benchOptions, buildFixture } from "./lib/slot-compute-fixtures.ts";
import type { SlotComputeInput } from "../src/lib/availability/compute.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A count flag, refused unless it is a positive whole number (L50): a NaN here
 *  would run zero samples and print a summary of nothing. */
function countArg(name: string, fallback: number): number {
  const raw = arg(name);
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive whole number, got ${raw}`);
  return n;
}

const samples = countArg("samples", 20);
const warmup = countArg("warmup", 3);
const modulePath = arg("module");
const mod = (await import(
  modulePath ? pathToFileURL(modulePath).href : "../src/lib/availability/compute.ts"
)) as { computeBucketSlots: (i: SlotComputeInput) => string[] };

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function summary(label: string, xs: number[]): string {
  const s = [...xs].sort((a, b) => a - b);
  const f = (n: number) => n.toFixed(1);
  return (
    `${label}: median ${f(quantile(s, 0.5))}ms  min ${f(s[0]!)}  q1 ${f(quantile(s, 0.25))}` +
    `  q3 ${f(quantile(s, 0.75))}  max ${f(s[s.length - 1]!)}  (n=${s.length})`
  );
}

const opts = benchOptions();
console.log(`module: ${modulePath ?? "src/lib/availability/compute.ts"}`);
console.log(
  `fixture: ${opts.members} members, ${opts.days} days, ~${opts.busyPerDay} busy/day, ` +
    `${opts.durationMin}m on ${opts.slotIntervalMin}m, buffers ${opts.bufferBeforeMin}/${opts.bufferAfterMin}, cap ${opts.dailyCap}`,
);
console.log(`load average before: ${loadavg().map((n) => n.toFixed(2)).join(" ")}`);

for (let i = 0; i < warmup; i++) mod.computeBucketSlots(buildFixture(1000 + i, opts));

const cpu: number[] = [];
const wall: number[] = [];
let slots = 0;
for (let i = 0; i < samples; i++) {
  const input = buildFixture(i + 1, opts);
  const c0 = process.cpuUsage();
  const w0 = performance.now();
  const out = mod.computeBucketSlots(input);
  const w1 = performance.now();
  const c1 = process.cpuUsage(c0);
  cpu.push((c1.user + c1.system) / 1000);
  wall.push(w1 - w0);
  slots += out.length;
}
console.log(summary("cpu ", cpu));
console.log(summary("wall", wall));
console.log(`mean offered slots per window: ${(slots / samples).toFixed(0)}`);
console.log(`load average after: ${loadavg().map((n) => n.toFixed(2)).join(" ")}`);
