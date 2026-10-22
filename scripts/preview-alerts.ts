// Print every alert Slate can send, rendered (#1153).
//
// The point of this file is to be READ. Alert copy is a contract with a person
// holding a phone mid-incident, and until now it was the only user-facing surface
// in Slate that could not be looked at before it shipped. Run it before changing
// any alert wording, and read the diff in review.
//
// Run: pnpm preview:alerts
import {
  HANDOFF_NOTICE_PREVIEWS,
  INVITE_MOVE_DM_PREVIEWS,
  OWNER_NOTICE_PREVIEWS,
  previewsByKey,
} from "../src/lib/notify/alert-preview.ts";
import { withSeverityLead, type AlertVoice } from "../src/lib/notify/severity-lead.ts";

// #1825: every state is printed as POSTED, under the severity lead the dispatcher
// puts on it, so a page and a whisper read as differently here as in Slack.
const VOICE: Record<"alert" | "info" | "recovery", AlertVoice> = {
  alert: "page",
  info: "info",
  recovery: "recovery",
};
// A family's preview key ends in `:*`; the lead is chosen for a member of it.
const sentKey = (key: string): string => (key.endsWith(":*") ? `${key.slice(0, -1)}preview` : key);

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
    const posted = withSeverityLead(s.text, sentKey(group.key), VOICE[s.channel]);
    for (const line of posted.split("\n")) console.log(`     ${line}`);
  }
}
console.log(`\n${"=".repeat(78)}`);
console.log("BOOKING HANDOFF NOTICES   [posted once to the handoff channel, for the sales side]");
for (const n of HANDOFF_NOTICE_PREVIEWS) {
  states++;
  console.log(`\n  -- ${n.kind}: ${n.state}`);
  for (const line of n.text.split("\n")) console.log(`     ${line}`);
}
console.log(`\n${"=".repeat(78)}`);
console.log("OWNER REASSIGN NOTICE   [posted once to the handoff channel, for the sales side]");
for (const n of OWNER_NOTICE_PREVIEWS) {
  states++;
  console.log(`\n  -- ${n.state}`);
  for (const line of n.text.split("\n")) console.log(`     ${line}`);
}
console.log(`\n${"=".repeat(78)}`);
console.log("MOVED INVITE DMS   [sent once to the advisor, and to their manager when a move is left (#3919)]");
for (const n of INVITE_MOVE_DM_PREVIEWS) {
  states++;
  console.log(`\n  -- to the ${n.to}: ${n.state}`);
  for (const line of n.text.split("\n")) console.log(`     ${line}`);
}
console.log(`\n${"=".repeat(78)}`);
console.log(`${states} rendered states across ${alerts} alerts, the sales notices and the moved invite DMs.`);
