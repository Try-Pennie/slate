// #3171: every bare node alerter posts to the alerts channel through ONE helper,
// `postToAlertsChannel` in scripts/lib/slack-post.ts, and the next hand rolled copy
// fails here (L613).
// Run: node --experimental-strip-types scripts/test-alerts-channel-poster.ts
//
// Nine scripts each read SLACK_ALERTS_CHANNEL, trimmed it, dropped an empty value so
// the poster would refuse it by name, posted, and turned Slack's answer into a
// reason. The rule and its blind spots are in scripts/lib/scan-alerts-channel-reads.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { postToAlertsChannel } from "./lib/slack-post.ts";
import { scanAlertsChannelReads } from "./lib/scan-alerts-channel-reads.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const OWNER = "scripts/lib/slack-post.ts";

// --- the helper ------------------------------------------------------------------
type Msg = { text: string; channel?: string };
function fakePost(reply: { ok: boolean; error?: string }) {
  const calls: Msg[] = [];
  return { calls, post: async (m: Msg) => (calls.push(m), reply) };
}

{
  const { calls, post } = fakePost({ ok: true });
  const res = await postToAlertsChannel(post, "it broke", { SLACK_ALERTS_CHANNEL: "  C123  " });
  eq(res, { ok: true, reason: "posted" }, "a delivered post is ok and says posted");
  eq(calls, [{ text: "it broke", channel: "C123" }], "the channel is trimmed and the text sent as given");
}
{
  // An unset repo variable interpolates to the empty string (#1500). Passed as a
  // channel it would post into nowhere, so it goes as NO channel and the poster
  // refuses it by name.
  for (const value of ["", "   ", undefined]) {
    const { calls, post } = fakePost({ ok: false, error: "slack-channel-not-configured" });
    const res = await postToAlertsChannel(post, "it broke", { SLACK_ALERTS_CHANNEL: value });
    eq(calls[0], { text: "it broke" }, `a channel of ${JSON.stringify(value)} is passed as none at all`);
    eq(res, { ok: false, reason: "slack-channel-not-configured" }, "and the poster's refusal is the reason");
  }
}
{
  const { post } = fakePost({ ok: false });
  eq(
    await postToAlertsChannel(post, "x", { SLACK_ALERTS_CHANNEL: "C1" }),
    { ok: false, reason: "unknown-error" },
    "a refusal with no reason of its own still reads as a failure, never as posted",
  );
}

// --- the scan, on fixtures ---------------------------------------------------------
const lines = (src: string) => scanAlertsChannelReads(src).map((f) => f.line).join(",");
{
  // THE POSITIVE CONTROLS: the shape every alerter carried, and its spellings.
  eq(lines("const channel = env.SLACK_ALERTS_CHANNEL?.trim() || undefined;"), "1", "the hand rolled read is caught");
  eq(lines("const c = process.env.SLACK_ALERTS_CHANNEL;"), "1", "a read from process.env is caught");
  eq(lines('const c = env["SLACK_ALERTS_CHANNEL"];'), "1", "a bracketed read is caught");
  eq(lines("post({\n  text,\n  channel: env.SLACK_ALERTS_CHANNEL,\n});"), "3", "a read inside a call is caught where it is");

  // THE NEGATIVE CONTROLS.
  eq(
    lines('console.error("Check SLACK_BOT_TOKEN and SLACK_ALERTS_CHANNEL in the repo Actions settings.");'),
    "",
    "the name in a message telling somebody which setting to check is not a read",
  );
  eq(lines("// env.SLACK_ALERTS_CHANNEL is read by the helper"), "", "the name in a comment is not a read");
  eq(lines("const env = { SLACK_ALERTS_CHANNEL: \"C1\" };"), "", "a key in a fake env is not a read");
  eq(lines("delete process.env.SLACK_ALERTS_CHANNEL;"), "", "clearing it is not posting with it");
}

// --- the real tree -------------------------------------------------------------------
const SKIP_DIRS = new Set(["node_modules", "__fixtures__"]);
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(join(dir, entry.name)));
    } else if (/\.(?:ts|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// Suites are left out: a test hands its subject a fake env and never posts. Every
// other file under scripts/ is in, so a new alerter is covered by construction rather
// than by remembering to list it (L96).
const files = walk(join(ROOT, "scripts"))
  .map((f) => relative(ROOT, f))
  .filter((rel) => !/(^|\/)test-[^/]*$/.test(rel) && rel !== OWNER)
  .map((rel) => ({ rel, src: readFileSync(join(ROOT, rel), "utf8") }));
const scanned = new Set(files.map((f) => f.rel));

// The nine that hand rolled it. The walk has to have reached them, or a clean result
// means nothing (L98), and each must now post through the helper.
const CONVERTED = [
  "scripts/check-main-push.ts",
  "scripts/notify-burst-counter.ts",
  "scripts/notify-deploy-failure.ts",
  "scripts/notify-router-replay.ts",
  "scripts/notify-clock-shift.ts",
  "scripts/notify-kill-switch.ts",
  "scripts/notify-smoke-failure.ts",
  "scripts/notify-parity-failure.ts",
  "scripts/lib/post-decision.ts",
];
for (const rel of CONVERTED) {
  assert(scanned.has(rel), `${rel} is in the scan`);
  const src = files.find((f) => f.rel === rel)?.src ?? "";
  assert(/\bpostToAlertsChannel\(/.test(src), `${rel} posts through postToAlertsChannel`);
}

const findings = files.flatMap((f) =>
  scanAlertsChannelReads(f.src, f.rel).map((x) => `${f.rel}:${x.line}  ${x.text}`),
);
assert(
  findings.length === 0,
  `no script outside ${OWNER} reads SLACK_ALERTS_CHANNEL itself; post through postToAlertsChannel instead:\n  ${findings.join("\n  ")}`,
);

// The owner is the one place the read lives. If it moved, the exemption above is
// exempting nothing and the rule has no home.
assert(
  scanAlertsChannelReads(readFileSync(join(ROOT, OWNER), "utf8")).length > 0,
  `${OWNER} is where the read lives`,
);

// THE POSITIVE CONTROL ON THE REAL TREE: put the old ending back into a real alerter,
// in memory, and the scan has to name it.
{
  const rel = "scripts/notify-deploy-failure.ts";
  const real = readFileSync(join(ROOT, rel), "utf8");
  const planted = `${real}\nexport function handRolled(env: Record<string, string | undefined>) {\n  return env.SLACK_ALERTS_CHANNEL?.trim() || undefined;\n}\n`;
  eq(scanAlertsChannelReads(real, rel).length, 0, "the real alerter is clean");
  eq(scanAlertsChannelReads(planted, rel).length, 1, "the same alerter with a hand rolled read planted is caught");
}

finish();
