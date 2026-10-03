// Repo invariant (#3098): a failed alert send is never caught and dropped.
//
// `sendThrottledAlert` throws on purpose when a key is misconfigured, so the
// mistake lands in a failure boundary instead of paging on every tick (#2656).
// A `.catch(() => {})` on the send threw that away with no log line, at more than
// forty call sites, so the guard written to make a broken alert visible was
// invisible itself. Every send now records its failure through
// `logAlertSendFailure` / `logAllClearFailure`, and this fails the build on the
// next silent one.
//
// Escape hatch: `// alert-swallow-ok: <why>` on, or directly above, the line.
//
// Run: node --experimental-strip-types scripts/test-alert-send-catches.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { scanAlertSendCatches } from "./lib/scan-alert-send-catches.ts";
import { eq, assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

// --- the scanner, both directions -------------------------------------------
eq(
  scanAlertSendCatches(`await sendThrottledAlert("k", 1, "t").catch(() => {});`).length,
  1,
  "a one line send with a bare catch is refused",
);
eq(
  scanAlertSendCatches(`
  await sendThrottledAlert(
    KEY,
    COOLDOWN_MS,
    copy(\`a {brace} and \${x(1)}\`),
  ).catch(() => {});
`).length,
  1,
  "a multi line send whose copy carries braces and parens is refused",
);
eq(
  scanAlertSendCatches(`await resolveRecovered([{ key: K, text: t() }]).catch(() => []);`).length,
  1,
  "a batched all-clear whose arguments carry braces is refused (a statement walk-back stops inside them)",
);
// Every sender through the same cooldown gate, not only the two the issue named.
eq(
  scanAlertSendCatches(`await sendThrottledInfo("k", 1, "t").catch(() => {});`).length,
  1,
  "a whisper sent with a bare catch is refused",
);
eq(
  scanAlertSendCatches(`await resolveAlert("k", "over").catch(() => false);`).length,
  1,
  "an all-clear with a bare catch is refused",
);
// The INJECTED seam, which a scan by callee name alone never saw (the review
// found one live on src/lib/monitor/tier-volume.ts).
eq(
  scanAlertSendCatches(`
      await deps.notify(tierCheckFailedKey(tier), deps.cooldownMs, copy(label)).catch(() => {});
`).length,
  1,
  "a send through an injected notify seam is refused",
);
eq(
  scanAlertSendCatches(`
  await deps
    .notifyCountUnreadable(KEY, deps.cooldownMs, text)
    .catch(() => {});
`).length,
  1,
  "a multi line send through a named notify seam is refused",
);
eq(
  scanAlertSendCatches(`await deps.resolveCountUnreadable(KEY, text).catch(() => false);`).length,
  1,
  "an all-clear through an injected resolve seam is refused",
);
eq(
  scanAlertSendCatches(`await Promise.resolve(x).catch(() => {});`).length,
  0,
  "Promise.resolve is not an alert seam",
);
eq(
  scanAlertSendCatches(`await deps.resolverForAgent(id).catch(() => null);`).length,
  0,
  "a name that merely starts with resolve is not a seam",
);
eq(
  scanAlertSendCatches(`await notify(KEY, 1, "t").catch(() => {});`).length,
  0,
  "a bare function named notify is not a seam (only a member of a deps object is)",
);
eq(
  scanAlertSendCatches(`await sendThrottledAlert("k", 1, "t").catch(logAlertSendFailure("k"));`)
    .length,
  0,
  "the logging handler is accepted",
);
eq(
  scanAlertSendCatches(`await sendThrottledAlert("k", 1, "t").catch((err) => log.error("x", {}, err));`)
    .length,
  0,
  "any handler that takes the error is accepted",
);
eq(
  scanAlertSendCatches(`await recordHeartbeat("x").catch(() => {});`).length,
  0,
  "a bare catch on something other than an alert send is not this guard's business",
);
eq(
  scanAlertSendCatches(`await sendThrottledAlertSoon("k").catch(() => {});`).length,
  0,
  "a longer name sharing the prefix is not the send",
);
eq(
  scanAlertSendCatches(`
// alert-swallow-ok: the failure is already logged by the caller one line up
await sendThrottledAlert("k", 1, "t").catch(() => {});
`).length,
  0,
  "the reasoned opt-out is honoured",
);
eq(
  scanAlertSendCatches(`
// Historically sendThrottledAlert("k", 1, "t").catch(() => {}) lost the error.
await other();
`).length,
  0,
  "a mention inside a comment is not a call site",
);

// --- the real tree ----------------------------------------------------------
const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "worker"))];
assert(files.length > 100, `walked the real tree (${files.length} files)`);
let sends = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  sends += (
    source.match(/\b(?:sendThrottledAlert|sendThrottledInfo|resolveAlert|resolveRecovered)\s*\(/g) ?? []
  ).length;
  for (const f of scanAlertSendCatches(source)) {
    assert(
      false,
      `${relative(ROOT, file)}:${f.line}: ${f.callee}(...) is caught with a handler that drops the error. ` +
        `Use .catch(logAlertSendFailure(key)) or .catch(logAllClearFailure(keys)) from @/lib/notify/send-failure.`,
    );
  }
}
// Positive control on the real tree: the walk reached the sends, so a clean
// result is a clean tree rather than a scan that looked at nothing (L98).
assert(sends > 50, `the walk reached the real alert sends (${sends})`);

finish();
