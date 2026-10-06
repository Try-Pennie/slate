// Check the workflow's cold_samples input before the cold job installs or builds (#3354).
//
// The workflow can stand the job down only on the exact strings "0" and "", so any other
// value starts it. Run on bare node right after checkout, this refuses a value the leg
// would refuse anyway, by name, before the job spends an install and a build on it.
// It imports only cold-plan.ts, which imports nothing, so it needs no install.
//
// Run: COLD_SAMPLES=30 node --experimental-strip-types scripts/loadtest/check-cold-samples.ts
import { readColdSamples } from "./cold-plan.ts";

// env-ok: COLD_SAMPLES (the workflow's cold_samples input)
const read = readColdSamples(process.env.COLD_SAMPLES);
if (!read.ok) {
  console.error(`FAILED: ${read.why}, so the cold job stops before installing anything.`);
  process.exit(1);
}
console.log(`cold_samples reads as ${read.n}`);
