// Confirm the loadtest deployment is really gone after `wrangler delete` (#2277).
//
// Thin on purpose: it reads the three settings, makes ONE request to the account's
// Worker listing, hands the status and the body to `judgeWorkerListing`, prints the
// verdict's message and exits on its code. Every decision it makes lives in
// scripts/loadtest/teardown-verdict.ts and is driven offline by
// scripts/test-loadtest-teardown-verdict.ts, so the outcomes are tested where there
// is no Cloudflare account to ask.
//
// Only "the Worker is absent from a listing this could positively read" exits zero.
// Everything else, including every way of learning nothing, exits on its own code
// with its own wording: a teardown that could not be checked must never read like one
// that was (L98, L11).
import {
  judgeWorkerListing,
  misconfiguredVerdict,
  noAnswerVerdict,
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

async function verdict(): Promise<TeardownVerdict> {
  const missing: string[] = [];
  if (!token) missing.push("CLOUDFLARE_API_TOKEN");
  if (!account) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (!workerName) missing.push("LOADTEST_WORKER_NAME");
  if (missing.length > 0) return misconfiguredVerdict(missing);

  let status: number;
  let bodyText: string;
  try {
    const res = await fetch(workerListingUrl(account), {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
    });
    status = res.status;
    // Read as TEXT, never `res.json()`. A platform error page is HTML, and a parse
    // that throws inside this try would be reported as "Cloudflare never answered",
    // which is a different cause with a different remedy. The judge decides whether
    // the text is readable.
    bodyText = await res.text();
  } catch (err) {
    return noAnswerVerdict((err as Error).message || String(err));
  }

  return judgeWorkerListing({ workerName, status, bodyText });
}

const result = await verdict();
if (result.confirmed) console.log(result.message);
else console.error(result.message);
process.exit(result.exitCode);
