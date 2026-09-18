// Every webhook POST is claimed before it leaves (#2563).
//
// Four actors address one delivery row: the first send, the cron retry sweep, a
// manual admin resend, and an operator replay. `claimDeliveryAttempt` is the
// compare-and-swap that decides which of them owns an attempt, and until #2563
// two of those four (the first send and the replay) posted without taking it, so
// a hung first send racing the sweep, or an operator clicking replay twice, POSTed
// a booking event to Regal twice.
//
// The fix is structural: `claimAndSend` is the only thing that calls the private
// sender, so a new path cannot opt out of a claim it cannot reach around (L621).
// This guard is the backstop on that structure. It fails when a bare `send(` is
// added anywhere else in the module, which is the only way the pairing can come
// apart again.
//
// Run: node --experimental-strip-types scripts/test-webhook-send-claim.ts
import { readFileSync } from "node:fs";
import { assert, finish } from "./lib/harness.ts";

const FILE = "src/lib/webhooks/emit.ts";
const source = readFileSync(new URL(`../${FILE}`, import.meta.url), "utf8");

/** The span of a function's body, found by matching braces from its declaration. */
function bodySpan(text: string, declaration: string): { start: number; end: number } | null {
  const at = text.indexOf(declaration);
  if (at === -1) return null;
  const open = text.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return { start: open, end: i };
    }
  }
  return null;
}

/**
 * Blank out comments and string bodies, keeping every byte offset, so the scan
 * reads CODE. The first draft matched a doc comment that mentions `send()` and
 * reported a defect that was a sentence, which is the same mistake as scanning a
 * whole file for a token and being answered by prose (L135).
 */
function codeOnly(text: string): string {
  const out = text.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const end = text.indexOf("\n", i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      blank(i, end === -1 ? text.length : end + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) j += text[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/**
 * Call sites of the private sender, which is `send(` alone: `claimAndSend(`,
 * `doSend(`, `deferSend(` and `resendDelivery(` all fail the word boundary or the
 * lower case s, so they are not mistaken for it. The declaration itself is not a
 * call and is excluded by name.
 */
function unclaimedSendSites(text: string): number[] {
  const code = codeOnly(text);
  const body = bodySpan(code, "async function claimAndSend(");
  const sites: number[] = [];
  for (const m of code.matchAll(/(?<![\w.])send\(/g)) {
    const at = m.index;
    if (code.slice(Math.max(0, at - 30), at).includes("async function ")) continue;
    if (body && at > body.start && at < body.end) continue;
    sites.push(code.slice(0, at).split("\n").length);
  }
  return sites;
}

// The shared claim-then-send must exist at all: a guard that cannot find it would
// pass over a file that had abandoned the pairing entirely.
assert(
  bodySpan(source, "async function claimAndSend(") !== null,
  "emit.ts declares claimAndSend, the one path a delivery goes out by",
);
assert(
  /claimDeliveryAttempt\(db, deliveryId, currentAttempts\)/.test(source),
  "claimAndSend takes the attempt claim before it sends",
);

const live = unclaimedSendSites(source);
assert(
  live.length === 0,
  `no webhook send bypasses the attempt claim (unclaimed send( at line(s): ${live.join(", ") || "none"})`,
);

// Positive control. A scan that matched nothing and a module with no unclaimed
// send read the same, so plant one and require it to be caught (L1). It is planted
// in a copy held in memory; nothing is written to the tree.
const planted = source.replace(
  "export async function retryFailedDeliveries(): Promise<number> {",
  "export async function roguePath(): Promise<void> {\n" +
    "  await send(endpoint, deliveryId, event, payload, 1);\n" +
    "}\n\n" +
    "export async function retryFailedDeliveries(): Promise<number> {",
);
assert(planted !== source, "the positive control planted an unclaimed send");
assert(
  unclaimedSendSites(planted).length === 1,
  "the scan catches an unclaimed send added outside claimAndSend",
);

// And the control must be blamed on the right place rather than on any line.
const plantedLine = planted.split("\n").findIndex((l) => l.includes("await send(endpoint, deliveryId, event, payload, 1);")) + 1;
assert(
  unclaimedSendSites(planted)[0] === plantedLine,
  `the scan names the line the unclaimed send is on (expected ${plantedLine})`,
);

finish();
