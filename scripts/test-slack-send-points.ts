// #3528 (L757): Slate posts to Slack from exactly two places, and both escape what a
// person typed. This holds every other file to that.
//
// The escape lives at the send point (scripts/lib/slack-mrkdwn.ts, applied in
// src/lib/notify/slack.ts and scripts/lib/slack-post.ts) so that a message builder
// written tomorrow cannot skip it. That holds only while nothing ELSE talks to Slack:
// before #3528 the interactions route posted its own ephemeral replies to a
// `response_url` with a bare fetch, beside the notifier rather than through it, and the
// smoke canary carried its own one-off mention breaker. A new direct post would ship
// unescaped and look exactly like the rest, so this fails on it by name.
//
// What counts as talking to Slack: Slack's Web API host, its incoming hook host, and
// `response_type`, the field every reply to an interaction's `response_url` carries
// (that url arrives in a payload, so its host never appears in our source).
//
// Run: node --experimental-strip-types scripts/test-slack-send-points.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { sourceFiles } from "./lib/source-files.ts";

const ROOT = join(import.meta.dirname, "..");

/** A file that sends to Slack, by the shapes above. */
export const SLACK_SEND = /slack\.com\/api|hooks\.slack\.com|\bresponse_type\b/;

/** The two send points, and the escape each must apply. */
const SEND_POINTS: { file: string; applies: string }[] = [
  { file: "src/lib/notify/slack.ts", applies: "safeMessage(" },
  { file: "scripts/lib/slack-post.ts", applies: "slackSafeMrkdwn(" },
];

/**
 * Files that talk to Slack outside the two send points, each with the reason it is
 * safe. Every entry must still match, or it is stale and fails.
 */
const EXEMPT: { file: string; why: string }[] = [
  {
    file: ".github/workflows/main-push-guard.yml",
    why:
      "the shell fallback that reports the guard script itself could not run, so it cannot call the script's poster; " +
      "its text is fixed copy plus a commit sha, a GitHub login and a run url, none of which can carry Slack markup",
  },
];

/** Not judged: tests, which name these shapes to drive the send points with fakes. */
function isTest(file: string): boolean {
  return /\.test\.tsx?$/.test(file) || /(^|\/)scripts\/test-[^/]+\.ts$/.test(file);
}

export function offenders(files: { file: string; text: string }[]): string[] {
  const allowed = new Set([...SEND_POINTS.map((s) => s.file), ...EXEMPT.map((e) => e.file)]);
  return files.filter((f) => !allowed.has(f.file) && SLACK_SEND.test(f.text)).map((f) => f.file);
}

// --- positive controls: the scan sees each shape it exists to catch ------------
{
  const caught = offenders([
    { file: "src/app/api/x/route.ts", text: `await fetch("https://slack.com/api/chat.postMessage", {})` },
    { file: "src/lib/y.ts", text: `body: JSON.stringify({ response_type: "ephemeral", text })` },
    { file: "scripts/z.ts", text: `fetch("https://hooks.slack.com/services/T/B/x")` },
    { file: "src/lib/notify/slack.ts", text: `fetch("https://slack.com/api/chat.postMessage")` },
    { file: "src/lib/quiet.ts", text: `postSlack({ text })` },
  ]);
  eq(
    caught.join(","),
    "src/app/api/x/route.ts,src/lib/y.ts,scripts/z.ts",
    "a direct Web API post, an interaction reply and an incoming hook are each caught; the send point and a caller of it are not",
  );
}

// --- the real tree ------------------------------------------------------------
const files = sourceFiles({
  paths: ["src", "scripts", "worker", ".github/workflows"],
  match: /\.(ts|tsx|mjs|js|yml)$/,
  exclude: isTest,
}).map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));

const found = offenders(files);
eq(
  found.join(", "),
  "",
  "nothing posts to Slack except through src/lib/notify/slack.ts or scripts/lib/slack-post.ts, which escape what a person typed (#3528). " +
    "Send through one of them instead",
);

for (const s of SEND_POINTS) {
  const f = files.find((x) => x.file === s.file);
  assert(f !== undefined, `${s.file} is still where Slate posts to Slack`);
  if (!f) continue;
  assert(SLACK_SEND.test(f.text), `${s.file} still talks to Slack, so it is still a send point worth holding`);
  assert(f.text.includes(s.applies), `${s.file} applies the escape (${s.applies}) to what it sends`);
}

for (const e of EXEMPT) {
  const f = files.find((x) => x.file === e.file);
  assert(f !== undefined && SLACK_SEND.test(f.text), `the exemption for ${e.file} still matches something, or it is stale and should go`);
}

finish();
