// Print every alert Slate can send, rendered (#1153).
//
// The point of this file is to be READ. Alert copy is a contract with a person
// holding a phone mid-incident, and until now it was the only user-facing surface
// in Slate that could not be looked at before it shipped. Run it before changing
// any alert wording, and read the diff in review.
//
// Run: pnpm preview:alerts
import { previewsByKey } from "../src/lib/notify/alert-preview.ts";

const KIND_LABEL: Record<string, string> = {
  condition: "CONDITION (pages, and must say when it clears)",
  incident: "INCIDENT (a finished event, no all-clear)",
  info: "INFO (needs no action)",
};

let alerts = 0;
let states = 0;
for (const group of previewsByKey()) {
  alerts++;
  console.log(`\n${"=".repeat(78)}`);
  console.log(`${group.key}   [${KIND_LABEL[group.kind] ?? group.kind}]`);
  console.log(`why: ${group.why}`);
  for (const s of group.states) {
    states++;
    console.log(`\n  -- ${s.channel.toUpperCase()}: ${s.state}`);
    for (const line of s.text.split("\n")) console.log(`     ${line}`);
  }
}
console.log(`\n${"=".repeat(78)}`);
console.log(`${states} rendered states across ${alerts} alerts.`);
