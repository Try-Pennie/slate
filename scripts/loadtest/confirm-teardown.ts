// Confirm the loadtest deployment is really gone after `wrangler delete` (#2277).
//
// Thin on purpose: it reads the three settings, reads the account's Worker listing,
// and, ONLY when that listing was readable and did not name the Worker, reads the
// Worker by name to confirm the absence. It then prints the verdict's message and
// exits on its code. Every decision lives in scripts/loadtest/teardown-verdict.ts and
// is driven offline by scripts/test-loadtest-teardown-verdict.ts, so the outcomes are
// tested where there is no Cloudflare account to ask.
//
// Two reads because neither answers alone, and the reason is in that module's header:
// a bare 404 by name cannot tell "gone" from "wrong account", and an absence from the
// listing rests on the listing being complete, which nothing here has measured (L82).
// The second read is made only on an absence, so the ordinary still-deployed case and
// every unreadable case cost one request.
//
// Only "absent from a readable listing AND 404 by name" exits zero. Everything else,
// including every way of learning nothing, exits on its own code with its own
// wording: a teardown that could not be checked must never read like one that was
// (L98, L11).
import {
  byNameNoAnswerVerdict,
  judgeByName,
  misconfiguredVerdict,
  noAnswerVerdict,
  readWorkerListing,
  workerByNameUrl,
  workerListingUrl,
  type TeardownVerdict,
} from "./teardown-verdict.ts";

// `?? ""` and not a real default. `${{ vars.LOADTEST_WORKER_NAME }}` for a repo
// variable nobody created injects the EMPTY STRING rather than leaving the name
// unset, so a non-empty fallback here would be a promise that never applies (#1498).
// An empty value is refused by name below.
const token = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
const account = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
const workerName = (process.env.LOADTEST_WORKER_NAME ?? "").trim();

/** One GET, returning the status and the body text, or the error that stopped it. */
async function get(url: string): Promise<{ status: number; bodyText: string } | { failed: string }> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
    });
    // Read as TEXT, never `res.json()`. A platform error page is HTML, and a parse
    // that throws inside this try would be reported as "Cloudflare never answered",
    // which is a different cause with a different remedy. The judges decide whether
    // the text is readable.
    return { status: res.status, bodyText: await res.text() };
  } catch (err) {
    return { failed: (err as Error).message || String(err) };
  }
}

async function verdict(): Promise<TeardownVerdict> {
  const missing: string[] = [];
  if (!token) missing.push("CLOUDFLARE_API_TOKEN");
  if (!account) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (!workerName) missing.push("LOADTEST_WORKER_NAME");
  if (missing.length > 0) return misconfiguredVerdict(missing);

  const listed = await get(workerListingUrl(account));
  if ("failed" in listed) return noAnswerVerdict(listed.failed);

  const reading = readWorkerListing({ workerName, status: listed.status, bodyText: listed.bodyText });
  if (reading.kind === "decided") return reading.verdict;

  // Absent from the listing. That is a claim, not a verdict, so it is confirmed by a
  // second read before anything exits zero.
  const byName = await get(workerByNameUrl(account, workerName));
  if ("failed" in byName) return byNameNoAnswerVerdict(workerName, byName.failed);

  return judgeByName({
    workerName,
    listedCount: reading.listedCount,
    status: byName.status,
    bodyText: byName.bodyText,
  });
}

const result = await verdict();
if (result.confirmed) console.log(result.message);
else console.error(result.message);
process.exit(result.exitCode);
